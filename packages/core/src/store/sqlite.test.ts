import { describe, expect, it } from "bun:test";
import type { Database } from "bun:sqlite";
import type { Store } from "../contracts/index.ts";
import { ConfigError, YrmError } from "../errors.ts";
import { makeEvent } from "../testing/fixtures.ts";
import { runStoreSuite, type StoreInspector } from "../testing/store-suite.ts";
import { createStore, SqliteStore } from "./index.ts";
import { MIGRATIONS } from "./schema.ts";

// The audit and version tables are not on the Store interface; read them
// through bun:sqlite on the same handle, for assertions only.
function dbOf(s: Store): Database {
  return (s as unknown as { db: Database }).db;
}

const inspect: StoreInspector = {
  expectedVersions: MIGRATIONS.map((m) => m.version),
  schemaVersions: async (s) =>
    dbOf(s).query<{ version: number }, []>("SELECT version FROM schema_version ORDER BY version").all().map((r) => r.version),
  tables: async (s) =>
    dbOf(s).query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'table'").all().map((r) => r.name),
  factAudit: async (s) =>
    dbOf(s).query<{ fact_id: string; action: string; by: string; at: string }, []>("SELECT * FROM fact_audit").all(),
  entityAudit: async (s) =>
    dbOf(s).query<{ entity_id: string; action: string; by: string }, []>("SELECT * FROM entity_audit").all(),
};

runStoreSuite("sqlite", ({ clock }) => new SqliteStore({ path: ":memory:", clock }), { inspect });

describe("SqliteStore specifics", () => {
  it("enables foreign keys", async () => {
    const s = new SqliteStore({ path: ":memory:" });
    await s.migrate();
    expect(dbOf(s).query<{ foreign_keys: number }, []>("PRAGMA foreign_keys").get()?.foreign_keys).toBe(1);
    await s.close();
  });

  it("createStore opens sqlite and rejects bad storage config", async () => {
    const s = await createStore({ driver: "sqlite", path: ":memory:" });
    expect((await s.appendEvent(makeEvent())).created).toBe(true);
    await s.close();

    for (const config of [{ driver: "mysql", url: "mysql://x" }, { driver: "sqlite" }, { driver: "postgres" }]) {
      let caught: unknown;
      try {
        await createStore(config);
      } catch (e) {
        caught = e;
      }
      expect(caught).toBeInstanceOf(ConfigError);
      expect(caught).toBeInstanceOf(YrmError);
    }
  });
});
