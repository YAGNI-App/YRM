import { Database } from "bun:sqlite";
import { describe, expect, it } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("migration 2 backfills knownAt and knownUntil from transaction time", async () => {
    const JUNE = "2026-06-02T00:00:00.000Z";
    const dir = mkdtempSync(join(tmpdir(), "yrm-mig-"));
    try {
      const path = join(dir, "v1.sqlite");
      const v1 = new Database(path, { create: true });
      v1.exec(MIGRATIONS[0]!.sql);
      v1.run("CREATE TABLE schema_version (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)");
      v1.run("INSERT INTO schema_version VALUES (1, 'initial', '2026-01-01T00:00:00.000Z')");
      v1.run(
        `INSERT INTO facts (id, tenant_id, type, subject_id, predicate, value_json, statement, valid_from, recorded_at,
           retracted_at, confidence, origin_kind, origin_by)
         VALUES ('f1', 'local', 'attribute', 's', 'title', 'null', 'x', ?, ?, ?, 0.5, 'rule', 'r')`,
        [JUNE, "2026-07-01T00:00:00.000Z", "2026-08-01T00:00:00.000Z"],
      );
      v1.close();
      const migrated = new SqliteStore({ path });
      await migrated.migrate();
      const f = await migrated.getFact("f1");
      expect(f?.knownAt).toBe("2026-07-01T00:00:00.000Z");
      expect(f?.knownUntil).toBe("2026-08-01T00:00:00.000Z");
      const indexes = dbOf(migrated)
        .query<{ name: string }, []>("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'facts'")
        .all()
        .map((r) => r.name);
      expect(indexes).toContain("facts_known");
      await migrated.close();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
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
