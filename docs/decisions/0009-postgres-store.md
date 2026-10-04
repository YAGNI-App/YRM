# 0009. Add a Postgres Store that passes the same suite as SQLite

Date: 2026-10-04
Status: accepted

## Context

ADR 0006 put all persistence behind `Store` and promised Postgres as a second implementation for multi-tenant and multi-host deployments, held to "a shared test suite [that] runs against every Store implementation". Until now there was one implementation, and its tests were written against `SqliteStore` directly, so nothing would have caught a second store that drifted from the first.

A hosted YRM has several writers (sync workers, the MCP server, the web dashboard) on several hosts, and several tenants in one database. SQLite's single writer and single file do not fit that. Issue #20 asks for the Postgres store without changing the `Store` interface.

## Decision

`@yrm/store-postgres` (`packages/store-postgres`) implements `Store` and `ModelCallStore` on Postgres. `createStore({ driver: "postgres", url })` loads it lazily, so SQLite-only installs never load a Postgres driver. The store's SQL and invariants mirror `SqliteStore` line for line, and the conformance suite moved from `sqlite.test.ts` to `packages/core/src/testing/store-suite.ts` (`runStoreSuite`) runs unchanged against both.

### Driver and connection

- Production driver: [`postgres`](https://github.com/porsager/postgres) (porsager). Pure JavaScript, works on Bun, pools connections, no native build.
- The store talks to a three-method `SqlClient` (`query`, `exec`, `transaction`, plus `close`). Two adapters exist: `postgresClient(url)` and `pgliteClient(db)`. The store's code is identical on both.
- Pool defaults: `max: 10`, `idle_timeout: 30s`, `connect_timeout: 10s`, overridable through `PostgresStoreOptions.pool`. Behind PgBouncer (or Supabase's port 6543) in transaction mode, named prepared statements break; `pool: { prepare: false }` turns them off.

### Schema

Migrations are numbered SQL in `packages/store-postgres/src/schema.ts`, recorded in `schema_version`, and applied by `store.migrate()`, which `createStore` calls on startup exactly as for SQLite. Each migration runs in its own transaction holding `pg_advisory_xact_lock`, so two hosts starting at once do not race on DDL.

Tables, primary keys, unique keys and indexes mirror `packages/core/src/store/schema.ts`. Every table that SQLite scopes by tenant carries `tenant_id` (`kv` stays namespaced by extension, as the interface has no tenant on kv calls). Type mapping:

| SQLite | Postgres | Why |
| --- | --- | --- |
| `TEXT` ids (ULID) | `text COLLATE "C"` | Byte order, so ULID order is creation order under any database locale. |
| `TEXT` ISO 8601 times | `text COLLATE "C"` | See below. |
| `TEXT` JSON (`*_json`) | `jsonb`, column named without the `_json` suffix | Validated on write, indexable (`facts.tags` has a GIN index for `?|`). |
| `INTEGER` 0/1 (`self`) | `boolean` | |
| `REAL` | `double precision` | Same 8-byte float as SQLite's REAL. |
| `INTEGER` | `integer` | Indexes, spans and token counts fit in 32 bits. |

**Times stay text.** The store normalizes every time to `YYYY-MM-DDTHH:mm:ss.sssZ` before writing, so byte comparison is chronological comparison. Keeping text (with the C collation) makes every bi-temporal predicate and every `ORDER BY` behave exactly as in SQLite and round-trips the exact string callers get back. `timestamptz` would add a parse and format on every row, lose nothing we use, and open a door to session time zone and precision (microseconds vs milliseconds) differences between the two stores. If we later want range types or time arithmetic in SQL, a migration can add generated `timestamptz` columns without changing the contract.

Indexes beyond the SQLite set: `(tenant_id, recorded_at)` on facts and `(tenant_id, occurred_at)` on events (both already in SQLite, named the same), a partial index on believed human facts for the human-beats-model check that runs on every write, and the GIN index on `tags`.

### Invariants

The store enforces them exactly as SQLite does, in one transaction per write. Postgres adds two things SQLite does not need with a single writer:

- **Concurrency.** `appendEvent` uses `INSERT ... ON CONFLICT (tenant_id, source, external_id) DO NOTHING`, so two hosts appending the same message produce one row and both get it back. Supersede, retract and end-validity lock the target fact with `SELECT ... FOR UPDATE`, so two writers cannot both supersede one fact.
- **Append-only below the store.** Triggers reject `UPDATE` and `DELETE` on `events`, `DELETE` on `facts` and `fact_provenance`, any change to `event_participants` other than `entity_id`, and any change to `facts` other than closing `retracted_at` or `valid_to` once and repointing `subject_id`/`object_id` on merge. A stray `UPDATE` from a psql session fails instead of silently rewriting history.

### Tests

The conformance suite runs in the normal offline `bun test` against [PGlite](https://pglite.dev) (Postgres compiled to WASM, in process), a dev dependency only. It runs under Bun 1.4 with no flags; one instance is shared by the file and tables are truncated between tests, so the suite takes under a second. When `YRM_TEST_POSTGRES_URL` is set, the same suite and the Postgres-specific tests (concurrent append from two pools, rollback of a failed supersede, the triggers, concurrent migrate) also run against that server; CI does this in a separate job with a `postgres:16` service container. Locally the server run is skipped with a message naming the variable.

## Consequences

Easier: a team or hosted deployment points `storage.url` at any Postgres 14+ (Supabase, Neon, RDS, Cloud SQL) and gets concurrent writers. Any future store implementation proves itself by calling `runStoreSuite`. The append-only rule now holds even against hand-written SQL.

Harder: two copies of every query. The conformance suite is what keeps them honest; a behaviour change in one store without a suite test is a bug waiting in the other. The ADR 0006 index on the full bi-temporal tuple is still approximated by `(tenant_id, subject_id, predicate)`; revisit with `EXPLAIN` on real data.

Differences we could not remove, none of which the suite exercises:

- Postgres `text` and `jsonb` cannot hold the NUL character (`\u0000`); SQLite can. An event body containing NUL fails to append on Postgres. Sources should strip NUL at the edge.
- `jsonb` does not keep object key order or duplicate keys. Values compare equal; `JSON.stringify` of a round-tripped value may order keys differently.
- `findEntities({ nameLike })` lowercases with Postgres's Unicode-aware `LOWER`; SQLite's `LOWER` folds ASCII only, so non-ASCII names match case-insensitively on Postgres and not on SQLite.

Given up for now: **Row Level Security.** Every query filters on `tenant_id` in the store, as in SQLite. The natural next step for hosting is RLS policies keyed on a `SET LOCAL yrm.tenant_id` per transaction, so a missed filter cannot leak across tenants. That needs the store to carry a tenant per connection, which the interface does not yet model (several methods take no tenant). `LISTEN/NOTIFY` for live projections is also future work.

## Alternatives considered

- **`pg` (node-postgres).** Mature, but callback-era API, and Bun support relies on Node compatibility shims; porsager is smaller and native-ESM.
- **`Bun.sql`.** Built in and fast, but ties the package to Bun's Postgres client and has no in-process test story; the `SqlClient` seam leaves room to add it as a third adapter.
- **Skip offline Postgres tests unless a server is configured.** Leaves most contributors never running the Postgres store; PGlite makes it free.
- **A shared query builder for both stores.** Rejected in ADR 0006 for the same reasons: it leaks a query API and hides invariants.
- **`timestamptz` for times.** See Schema; correct but buys nothing the contract uses and risks precision and ordering drift from SQLite.
