import type { StorageConfig, Store } from "../contracts/index.ts";
import { ConfigError } from "../errors.ts";
import { SqliteStore } from "./sqlite.ts";

export { SqliteStore, DEFAULT_TENANT, HUMAN_OUTRANKED_CONFIDENCE_CAP } from "./sqlite.ts";
export type { SqliteStoreOptions, StoredModelCall } from "./sqlite.ts";
export { MIGRATIONS } from "./schema.ts";
export type { Migration } from "./schema.ts";

/** Open the configured store and bring its schema up to date. */
export async function createStore(config: StorageConfig): Promise<Store> {
  switch (config.driver) {
    case "sqlite": {
      if (!config.path) throw new ConfigError("STORAGE_PATH_REQUIRED", 'storage.path is required for driver "sqlite"');
      const store = new SqliteStore({ path: config.path });
      await store.migrate();
      return store;
    }
    default:
      throw new ConfigError("UNSUPPORTED_STORAGE_DRIVER", `unsupported storage driver: ${config.driver}`);
  }
}
