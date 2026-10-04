# 0006. Start on SQLite behind a Store interface

Date: 2026-10-04
Status: accepted

## Context

The original plan required Postgres. For the first users of YRM, a person or a small team trying it on their own mail, running a database server is the largest piece of setup and the most common reason a self-hosted tool never gets past `install`. The data volume is small: one person's relationship history is tens of thousands of events and perhaps a few hundred thousand facts.

Later, YRM will need multi-tenant deployments, concurrent writers from several hosts, and possibly YAGNI using it as a context layer for many organizations. That is Postgres territory. We do not want the code that reads and writes facts to know which one it is talking to, and we do not want extensions issuing SQL that ties them to one dialect.

Bun ships `bun:sqlite`, a synchronous SQLite binding in the runtime, so there is no native module to install.

## Decision

All persistence goes through the `Store` interface in `packages/core/src/contracts/store.ts`. The first and default implementation uses `bun:sqlite` with a single file under `.yrm/`. Postgres will be a second implementation of the same interface.

Specifics:

- Tables: `events`, `event_participants`, `facts`, `fact_provenance`, `entities`, `entity_identifiers`, `views`, `cursors`, `kv`, `model_calls`. `tenantId` is on every row from day one.
- The store owns the invariants: event idempotency, append-only facts, `supersedes` closing transaction time, and the human-beats-model reconciliation rule. Callers cannot bypass them.
- Extensions get the `Store` object, never a connection or SQL. Extension state goes in namespaced `kv`.
- SQLite runs in WAL mode. Migrations are numbered SQL files applied by `store.migrate()`.
- A shared test suite runs against every `Store` implementation, so Postgres has to pass the same tests as SQLite.

## Consequences

Easier: install is `bun install` and a file path. Tests create a fresh in-memory store in milliseconds and need no services. Backups are a file copy. A user can open the database with any SQLite tool to see what YRM knows about them.

Harder: SQLite has one writer at a time. A sync running while the MCP server records a human fact will serialize. That is fine for one user and will become a problem for a team of more than a handful sharing one file. Bi-temporal queries (0003) need careful indexing on `(tenantId, subject, predicate, validFrom, validTo, recordedAt, retractedAt)`, and SQLite's planner is less forgiving than Postgres's. Vector search for the `embed` tier needs an extension (sqlite-vec) or a separate index; that choice is deferred.

The `Store` interface is coarse on purpose (record, query, merge). Some projections will want set-based queries the interface does not offer, and the temptation will be to add a raw query escape hatch. We will add specific methods instead and accept that the interface grows.

Given up: features we would get from Postgres immediately (row-level security, `LISTEN/NOTIFY`, logical replication into a stream processor like Day.ai's Materialize setup). Multi-tenant hosting waits for the Postgres store, which is at least 0.3.

## Alternatives considered

- **Postgres only (the original plan).** Right for hosting, wrong for the first hour of a self-hosted user.
- **An ORM or query builder (Drizzle, Kysely) shared across both databases.** Reduces duplicated SQL, but leaks a query API toward extensions and hides the invariants we want in one place.
- **DuckDB.** Excellent for analytical scans over the log, weak for many small transactional writes.
- **Embedded key-value store (LMDB, RocksDB).** Fast, but we would rebuild indexing and querying by hand.
