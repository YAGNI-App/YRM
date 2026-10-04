import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import type { Store } from "@yrm/core";
import { createStore } from "../../core/src/store/index.ts";
import { makeEvent, makeFact } from "../../core/src/testing/fixtures.ts";
import { runStoreSuite, type StoreInspector } from "../../core/src/testing/store-suite.ts";
import { pgliteClient, postgresClient, type Queryable, type SqlClient } from "../src/client.ts";
import { MIGRATIONS } from "../src/schema.ts";
import { PostgresStore } from "../src/store.ts";

const TABLES = [
  "events", "event_participants", "facts", "fact_provenance", "fact_audit", "entities",
  "entity_identifiers", "entity_audit", "views", "cursors", "kv", "model_calls",
];

/** Empty every table so each test starts clean without paying for a new database. */
async function reset(q: Queryable): Promise<void> {
  const exists = await q.query<{ t: string | null }>("SELECT to_regclass('public.events')::text AS t");
  if (exists[0]?.t) await q.exec(`TRUNCATE ${TABLES.join(", ")}`);
}

/** Raw access to the database behind each store, for the inspector and assertions. */
const rawOf = new WeakMap<Store, Queryable>();

function inspector(): StoreInspector {
  const raw = (s: Store): Queryable => {
    const q = rawOf.get(s);
    if (!q) throw new Error("store was not created by this test file");
    return q;
  };
  return {
    expectedVersions: MIGRATIONS.map((m) => m.version),
    schemaVersions: async (s) =>
      (await raw(s).query<{ version: number }>("SELECT version FROM schema_version ORDER BY version")).map((r) => r.version),
    tables: async (s) =>
      (await raw(s).query<{ name: string }>("SELECT tablename AS name FROM pg_tables WHERE schemaname = 'public'")).map(
        (r) => r.name,
      ),
    factAudit: async (s) =>
      raw(s).query<{ fact_id: string; action: string; by: string; at: string }>(
        "SELECT fact_id, action, by, at FROM fact_audit",
      ),
    entityAudit: async (s) =>
      raw(s).query<{ entity_id: string; action: string; by: string }>("SELECT entity_id, action, by FROM entity_audit"),
  };
}

/** Wraps a client so that statements matching `fail` throw inside transactions. */
function failingClient(inner: SqlClient, fail: RegExp): SqlClient {
  return {
    ...inner,
    query: (text, params) => inner.query(text, params),
    exec: (text) => inner.exec(text),
    transaction: (fn) =>
      inner.transaction((tx) =>
        fn({
          exec: (text) => tx.exec(text),
          query: (text, params) => {
            if (fail.test(text)) return Promise.reject(new Error(`injected failure: ${text.slice(0, 30)}`));
            return tx.query(text, params);
          },
        }),
      ),
    close: () => inner.close(),
  };
}

interface Backend {
  /** A new client on the shared test database. */
  client(): SqlClient;
  /** Raw access that outlives any one store. */
  raw: Queryable;
}

function postgresSpecifics(name: string, backend: () => Backend): void {
  describe(`PostgresStore specifics: ${name}`, () => {
    const clock = () => new Date("2026-01-10T00:00:00.000Z");
    const open = async (client: SqlClient = backend().client()): Promise<PostgresStore> => {
      const s = new PostgresStore({ client, clock });
      await s.migrate();
      return s;
    };

    it("keeps one row when two connections append the same externalId at once", async () => {
      await reset(backend().raw);
      const a = await open();
      const b = await open();
      const input = makeEvent({ externalId: "<race@x>" });
      const results = await Promise.all([a.appendEvent(input), b.appendEvent(input), a.appendEvent(input), b.appendEvent(input)]);
      expect(results.filter((r) => r.created)).toHaveLength(1);
      expect(new Set(results.map((r) => r.event.id)).size).toBe(1);
      const rows = await backend().raw.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM events WHERE external_id = '<race@x>'",
      );
      expect(rows[0]?.n).toBe(1);
      const participants = await backend().raw.query<{ n: number }>(
        "SELECT COUNT(*)::int AS n FROM event_participants WHERE event_id = $1",
        [results[0]!.event.id],
      );
      expect(participants[0]?.n).toBe(input.participants.length);
      await a.close();
      await b.close();
    });

    it("rolls back a supersede whose new fact fails to insert", async () => {
      await reset(backend().raw);
      const good = await open();
      const old = await good.recordFact(makeFact({ validFrom: "2026-01-01T00:00:00Z" }));
      const bad = await open(failingClient(backend().client(), /^\s*INSERT INTO facts/));
      // A later validFrom takes the bridging path too: UPDATE, audit, bridge insert.
      let caught: unknown;
      try {
        await bad.recordFact(makeFact({ validFrom: "2026-01-05T00:00:00Z", supersedes: old.id }));
      } catch (e) {
        caught = e;
      }
      expect(String(caught)).toContain("injected failure");

      expect((await good.getFact(old.id))?.retractedAt).toBeUndefined();
      expect(await good.queryFacts({ includeRetracted: true })).toHaveLength(1);
      const audit = await backend().raw.query("SELECT * FROM fact_audit WHERE fact_id = $1", [old.id]);
      expect(audit).toEqual([]);
      // And the fact can still be superseded properly afterwards.
      const next = await good.recordFact(makeFact({ supersedes: old.id }));
      expect((await good.getFact(old.id))?.retractedAt).toBe(next.recordedAt);
      await good.close();
      await bad.close();
    });

    it("refuses edits and deletes of events and facts below the store", async () => {
      await reset(backend().raw);
      const s = await open();
      const { event } = await s.appendEvent(makeEvent());
      const fact = await s.recordFact(makeFact());
      const raw = backend().raw;
      const attempts: Array<[string, unknown[]]> = [
        ["UPDATE events SET kind = 'edited' WHERE id = $1", [event.id]],
        ["DELETE FROM events WHERE id = $1", [event.id]],
        ["UPDATE event_participants SET address = 'x@y' WHERE event_id = $1", [event.id]],
        ["UPDATE facts SET statement = 'edited' WHERE id = $1", [fact.id]],
        ["DELETE FROM fact_provenance WHERE fact_id = $1", [fact.id]],
        ["DELETE FROM facts WHERE id = $1", [fact.id]],
      ];
      for (const [sql, params] of attempts) {
        let caught: unknown;
        try {
          await raw.query(sql, params as string[]);
        } catch (e) {
          caught = e;
        }
        expect(String(caught)).toContain("yrm:");
      }
      await s.retractFact(fact.id, "user:jack");
      let caught: unknown;
      try {
        await raw.query("UPDATE facts SET retracted_at = NULL WHERE id = $1", [fact.id]);
      } catch (e) {
        caught = e;
      }
      expect(String(caught)).toContain("retracted_at is already set");
      await s.close();
    });

    it("migrates idempotently from two stores", async () => {
      const a = await open();
      const b = await open();
      await Promise.all([a.migrate(), b.migrate()]);
      const rows = await backend().raw.query<{ version: number }>("SELECT version FROM schema_version");
      expect(rows.map((r) => r.version)).toEqual(MIGRATIONS.map((m) => m.version));
      await a.close();
      await b.close();
    });
  });
}

// ---- PGlite: in-process Postgres, always runs ---------------------------------

let pglite: PGlite;
let pgliteBackend: Backend;

beforeAll(async () => {
  pglite = new PGlite();
  await pglite.waitReady;
  pgliteBackend = { client: () => pgliteClient(pglite, { shared: true }), raw: pgliteClient(pglite, { shared: true }) };
});

afterAll(async () => {
  await pglite.close();
});

runStoreSuite(
  "postgres (pglite)",
  async ({ clock }) => {
    await reset(pgliteBackend.raw);
    const store = new PostgresStore({ client: pgliteBackend.client(), clock });
    rawOf.set(store, pgliteBackend.raw);
    return store;
  },
  { inspect: inspector() },
);

postgresSpecifics("pglite", () => pgliteBackend);

// ---- A real server, when YRM_TEST_POSTGRES_URL is set (CI service container) ----

const url = process.env["YRM_TEST_POSTGRES_URL"];

if (url) {
  let raw: SqlClient;
  const serverBackend = (): Backend => ({ client: () => postgresClient(url, { max: 4 }), raw });

  beforeAll(async () => {
    raw = postgresClient(url, { max: 2 });
  });

  afterAll(async () => {
    await raw.close();
  });

  runStoreSuite(
    "postgres (server)",
    async ({ clock }) => {
      await reset(raw);
      const store = new PostgresStore({ client: postgresClient(url, { max: 4 }), clock });
      rawOf.set(store, raw);
      return store;
    },
    { inspect: inspector() },
  );

  postgresSpecifics("server", serverBackend);

  describe("createStore (server)", () => {
    it('opens storage: { driver: "postgres", url }', async () => {
      const s = await createStore({ driver: "postgres", url });
      expect(s).toBeInstanceOf(PostgresStore);
      expect((await s.appendEvent(makeEvent())).created).toBe(true);
      await s.close();
    });
  });
} else {
  describe.skip("PostgresStore against a real server (set YRM_TEST_POSTGRES_URL to run; PGlite covers it offline)", () => {
    it("skipped", () => {});
  });
}
