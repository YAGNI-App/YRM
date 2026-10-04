import type { StorageConfig, Store } from "../contracts/index.ts";
import { ConfigError } from "../errors.ts";
import { SqliteStore, type StoredModelCall } from "./sqlite.ts";

export { SqliteStore, DEFAULT_TENANT, HUMAN_OUTRANKED_CONFIDENCE_CAP } from "./sqlite.ts";
export type { SqliteStoreOptions, StoredModelCall } from "./sqlite.ts";
export { MIGRATIONS } from "./schema.ts";
export type { Migration } from "./schema.ts";

/**
 * Model-call accounting the router's usage sink needs. Not on `Store`: it is
 * operational bookkeeping, not part of the context layer extensions read.
 */
export interface ModelCallStore {
  /** Record one model call. Returns its id. */
  recordModelCall(call: StoredModelCall): Promise<string>;
  /** Total USD spent by a tenant on calls at or after `sinceIso`. */
  sumModelCost(tenantId: string, sinceIso: string): Promise<number>;
}

export function isModelCallStore(store: unknown): store is ModelCallStore {
  if (typeof store !== "object" || store === null) return false;
  const s = store as Partial<Record<keyof ModelCallStore, unknown>>;
  return typeof s.recordModelCall === "function" && typeof s.sumModelCost === "function";
}

/** The part of `@yrm/store-postgres` that core needs; typed here so core does not depend on it. */
interface PostgresStoreModule {
  PostgresStore: new (options: { url: string }) => Store;
}

const POSTGRES_PACKAGE = "@yrm/store-postgres";

/** Open the configured store and bring its schema up to date. */
export async function createStore(config: StorageConfig): Promise<Store> {
  switch (config.driver) {
    case "sqlite": {
      if (!config.path) throw new ConfigError("STORAGE_PATH_REQUIRED", 'storage.path is required for driver "sqlite"');
      const store = new SqliteStore({ path: config.path });
      await store.migrate();
      return store;
    }
    case "postgres": {
      const url = config.url ?? config.path;
      if (!url) throw new ConfigError("STORAGE_URL_REQUIRED", 'storage.url is required for driver "postgres"');
      const { PostgresStore } = await loadPostgres();
      const store = new PostgresStore({ url });
      try {
        await store.migrate();
      } catch (err) {
        await store.close().catch(() => {});
        throw err;
      }
      return store;
    }
    default:
      throw new ConfigError("UNSUPPORTED_STORAGE_DRIVER", `unsupported storage driver: ${config.driver}`);
  }
}

// Loaded lazily so SQLite-only installs never need the Postgres driver.
async function loadPostgres(): Promise<PostgresStoreModule> {
  let mod: unknown;
  try {
    mod = await import(POSTGRES_PACKAGE);
  } catch (err) {
    throw new ConfigError(
      "STORAGE_DRIVER_NOT_INSTALLED",
      `storage driver "postgres" needs the ${POSTGRES_PACKAGE} package; install it next to @yrm/core (bun add ${POSTGRES_PACKAGE})`,
      { cause: err },
    );
  }
  const ctor = (mod as Partial<PostgresStoreModule> | null)?.PostgresStore;
  if (typeof ctor !== "function") {
    throw new ConfigError("STORAGE_DRIVER_INVALID", `${POSTGRES_PACKAGE} does not export PostgresStore`);
  }
  return { PostgresStore: ctor };
}
