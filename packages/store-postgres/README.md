# @yrm/store-postgres

The Postgres implementation of the YRM `Store`. Use it when more than one process or host writes to YRM, or when one database holds several tenants. For one person on one machine, the default SQLite store is simpler.

It has the same semantics as the SQLite store (idempotent events, append-only bi-temporal facts, supersede closing transaction time, human beats model). Both pass the same conformance suite. See [ADR 0009](../../docs/decisions/0009-postgres-store.md) for the design.

## Configure

```ts
// yrm.config.ts
import { defineConfig } from "@yrm/core";

export default defineConfig({
  tenant: { id: "acme" },
  storage: { driver: "postgres", url: process.env.YRM_DATABASE_URL ?? "postgres://yrm:secret@localhost:5432/yrm" },
  models: { routes: {} },
});
```

`@yrm/core` loads this package only when `driver` is `"postgres"`. The `yrm` CLI ships with it; if you embed `@yrm/core` yourself, install it next to core (`bun add @yrm/store-postgres`). Without it, `createStore` throws a `ConfigError` with code `STORAGE_DRIVER_NOT_INSTALLED`.

`yrm doctor` prints the configured URL with the password masked.

## Migrations

Automatic. `createStore` (and so every `yrm` command) runs `store.migrate()` on startup, which applies any numbered migration newer than the `schema_version` table records. Migrations take a Postgres advisory lock, so several hosts can start at once. The database user needs `CREATE` on the schema the first time and whenever YRM ships a new migration.

To run them without starting anything else:

```ts
import { PostgresStore } from "@yrm/store-postgres";

const store = new PostgresStore({ url: process.env.YRM_DATABASE_URL! });
await store.migrate();
await store.close();
```

## Hosted Postgres

Any Postgres 14 or newer works, with no extensions required:

- **Supabase**: use the direct connection string or the session pooler (port 5432). The transaction pooler (port 6543) does not support prepared statements; see below.
- **Neon**: use the connection string from the dashboard. `?sslmode=require` is honoured.
- **Amazon RDS / Aurora, Google Cloud SQL, Azure**: use the instance endpoint; add `?sslmode=require` if the server enforces TLS.

Behind PgBouncer or another pooler in *transaction* mode, turn prepared statements off, or use the pooler's session mode:

```ts
new PostgresStore({ url, pool: { prepare: false } });
```

The default pool is 10 connections, 30 s idle timeout and 10 s connect timeout; override with `new PostgresStore({ url, pool: { max: 20 } })`. `createStore` uses the defaults.

## Tests

`bun test` runs the conformance suite and the Postgres-specific tests in process on [PGlite](https://pglite.dev); no server is needed. To also run them against a real server:

```sh
createdb yrm_test
YRM_TEST_POSTGRES_URL=postgres://localhost/yrm_test bun test packages/store-postgres
```

The tests truncate every YRM table in that database. Point the variable at a throwaway database.
