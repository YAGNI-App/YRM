import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { decodeTime } from "ulid";
import type { Fact, Store } from "../contracts/index.ts";
import { StoreError } from "../errors.ts";
import { isModelCallStore } from "../store/index.ts";
import { makeEntity, makeEvent, makeFact } from "./fixtures.ts";

/**
 * The behavioural contract every `Store` implementation must meet (ADR 0006).
 * Each implementation's test file calls `runStoreSuite` with a factory; the
 * suite owns the clock so recordedAt and ingestedAt are deterministic.
 */

export interface StoreSuiteContext {
  /** The clock the store must read for every time it assigns. */
  clock: () => Date;
}

export interface FactAuditRow {
  fact_id: string;
  action: string;
  by: string;
  at: string;
}

export interface EntityAuditRow {
  entity_id: string;
  action: string;
  by: string;
}

/**
 * Read-only access to tables the `Store` interface does not expose, for
 * assertions only. Without it the migration and audit assertions are skipped.
 */
export interface StoreInspector {
  /** Versions recorded in `schema_version`, ascending. */
  schemaVersions(store: Store): Promise<number[]>;
  /** Versions the implementation ships, ascending. */
  expectedVersions: number[];
  tables(store: Store): Promise<string[]>;
  factAudit(store: Store): Promise<FactAuditRow[]>;
  entityAudit(store: Store): Promise<EntityAuditRow[]>;
}

export interface StoreSuiteOptions {
  /** Test names (the `it` title) to skip, with a reason in the caller. */
  skip?: string[];
  inspect?: StoreInspector;
}

export type StoreFactory = (ctx: StoreSuiteContext) => Promise<Store> | Store;

const ULID_RE = /^[0-9A-HJKMNP-TV-Z]{26}$/;

/** A settable clock so tests control recordedAt / ingestedAt. */
function makeClock(start = "2026-01-10T00:00:00.000Z") {
  let t = new Date(start);
  return {
    now: () => t,
    set(iso: string) {
      t = new Date(iso);
    },
  };
}

export async function expectStoreError(p: Promise<unknown>, code: string): Promise<void> {
  let caught: unknown;
  try {
    await p;
  } catch (e) {
    caught = e;
  }
  expect(caught).toBeInstanceOf(StoreError);
  expect((caught as StoreError).code).toBe(code);
}

export function runStoreSuite(name: string, factory: StoreFactory, opts: StoreSuiteOptions = {}): void {
  const skipped = new Set(opts.skip ?? []);
  const test = (title: string, fn: () => Promise<void>): void => {
    if (skipped.has(title)) it.skip(title, fn);
    else it(title, fn);
  };
  const inspected = (title: string, fn: (inspect: StoreInspector) => Promise<void>): void => {
    const inspect = opts.inspect;
    if (!inspect) it.skip(title, async () => {});
    else test(title, () => fn(inspect));
  };

  describe(`Store conformance: ${name}`, () => {
    let clock: ReturnType<typeof makeClock>;
    let store: Store;

    beforeEach(async () => {
      clock = makeClock();
      store = await factory({ clock: () => clock.now() });
      await store.migrate();
    });

    afterEach(async () => {
      await store.close();
    });

    describe("migrations", () => {
      inspected("records the schema version and is idempotent", async (inspect) => {
        await store.migrate();
        expect(await inspect.schemaVersions(store)).toEqual(inspect.expectedVersions);
        const tables = await inspect.tables(store);
        for (const t of ["events", "event_participants", "facts", "fact_provenance", "fact_audit", "entities",
          "entity_identifiers", "views", "cursors", "kv", "model_calls"]) {
          expect(tables).toContain(t);
        }
      });
    });

    describe("events", () => {
      test("appends with a ULID id, default tenant and store-set ingestedAt", async () => {
        clock.set("2026-02-01T12:00:00.000Z");
        const { event, created } = await store.appendEvent(makeEvent({ occurredAt: "2026-01-31T08:00:00Z" }));
        expect(created).toBe(true);
        expect(event.id).toMatch(ULID_RE);
        expect(event.tenantId).toBe("local");
        expect(event.ingestedAt).toBe("2026-02-01T12:00:00.000Z");
        expect(event.occurredAt).toBe("2026-01-31T08:00:00.000Z");
        expect(await store.getEvent(event.id)).toEqual(event);
      });

      test("is idempotent on (tenantId, source, externalId)", async () => {
        const input = makeEvent({ externalId: "<same@x>" });
        const first = await store.appendEvent(input);
        const dup = await store.appendEvent({ ...input, content: { text: "different" } });
        expect(dup.created).toBe(false);
        expect(dup.event).toEqual(first.event);
        expect(await store.listEvents({})).toHaveLength(1);

        // Different tenant or source is a different event.
        expect((await store.appendEvent({ ...input, tenantId: "other" })).created).toBe(true);
        expect((await store.appendEvent({ ...input, source: "calendar" })).created).toBe(true);
      });

      test("stores participants with their index and round-trips optional fields", async () => {
        const { event } = await store.appendEvent(
          makeEvent({
            threadKey: "t1",
            inReplyTo: ["prev"],
            rawRef: "blob://1",
            meta: { labels: ["inbox"] },
            participants: [
              { role: "from", address: "a@x.test", name: "A" },
              { role: "to", address: "b@x.test" },
              { role: "cc", address: "me@x.test", self: true },
            ],
          }),
        );
        const got = await store.getEvent(event.id);
        expect(got?.participants).toEqual([
          { role: "from", address: "a@x.test", name: "A" },
          { role: "to", address: "b@x.test" },
          { role: "cc", address: "me@x.test", self: true },
        ]);
        expect(got?.threadKey).toBe("t1");
        expect(got?.inReplyTo).toEqual(["prev"]);
        expect(got?.rawRef).toBe("blob://1");
        expect(got?.meta).toEqual({ labels: ["inbox"] });
      });

      test("setParticipantEntities updates only participant entity ids", async () => {
        const { event } = await store.appendEvent(makeEvent());
        await store.setParticipantEntities(event.id, [
          { index: 0, entityId: "ent-a" },
          { index: 1, entityId: "ent-me" },
        ]);
        const got = await store.getEvent(event.id);
        expect(got?.participants[0]?.entityId).toBe("ent-a");
        expect(got?.participants[1]?.entityId).toBe("ent-me");
        expect({ ...got, participants: [] }).toEqual({ ...event, participants: [] });

        await expectStoreError(store.setParticipantEntities(event.id, [{ index: 9, entityId: "x" }]), "PARTICIPANT_NOT_FOUND");
        await expectStoreError(store.setParticipantEntities("nope", [{ index: 0, entityId: "x" }]), "EVENT_NOT_FOUND");
      });

      test("listEvents filters and pages in id order", async () => {
        const a = (await store.appendEvent(makeEvent({ threadKey: "t1", occurredAt: "2026-01-01T00:00:00Z" }))).event;
        const b = (
          await store.appendEvent(
            makeEvent({
              threadKey: "t1",
              kind: "reply",
              occurredAt: "2026-01-02T00:00:00Z",
              participants: [{ role: "from", address: "z@x.test" }],
            }),
          )
        ).event;
        const c = (await store.appendEvent(makeEvent({ source: "calendar", occurredAt: "2026-01-03T00:00:00Z" }))).event;
        await store.setParticipantEntities(c.id, [{ index: 0, entityId: "ent-c" }]);

        expect((await store.listEvents({})).map((e) => e.id)).toEqual([a.id, b.id, c.id]);
        expect((await store.listEvents({ threadKey: "t1" })).map((e) => e.id)).toEqual([a.id, b.id]);
        expect((await store.listEvents({ source: "calendar" })).map((e) => e.id)).toEqual([c.id]);
        expect((await store.listEvents({ kind: "reply" })).map((e) => e.id)).toEqual([b.id]);
        expect((await store.listEvents({ address: "z@x.test" })).map((e) => e.id)).toEqual([b.id]);
        expect((await store.listEvents({ entityId: "ent-c" })).map((e) => e.id)).toEqual([c.id]);
        expect((await store.listEvents({ occurredAfter: "2026-01-01T00:00:00Z" })).map((e) => e.id)).toEqual([b.id, c.id]);
        expect((await store.listEvents({ occurredBefore: "2026-01-02T00:00:00Z" })).map((e) => e.id)).toEqual([a.id]);
        expect((await store.listEvents({ afterId: a.id, limit: 1 })).map((e) => e.id)).toEqual([b.id]);
        expect(await store.listEvents({ tenantId: "other" })).toEqual([]);
      });
    });

    describe("facts", () => {
      test("assigns id, tenant and recordedAt and round-trips provenance", async () => {
        clock.set("2026-03-01T00:00:00.000Z");
        const fact = await store.recordFact(
          makeFact({
            object: { entityId: "org-1", name: "Acme" },
            tags: ["crm"],
            provenance: [
              { eventId: "e1", speaker: { entityId: "p1", name: "Pat" }, quote: "hello", span: { start: 0, end: 5 } },
              { eventId: "e2" },
            ],
          }),
        );
        expect(fact.id).toMatch(ULID_RE);
        expect(decodeTime(fact.id)).toBeGreaterThan(0);
        expect(fact.tenantId).toBe("local");
        expect(fact.recordedAt).toBe("2026-03-01T00:00:00.000Z");
        expect(fact.retractedAt).toBeUndefined();
        expect(await store.getFact(fact.id)).toEqual(fact as Fact);
      });

      test("superseding sets the old fact's retractedAt to the new recordedAt", async () => {
        const old = await store.recordFact(makeFact({ value: { what: "VP" } }));
        clock.set("2026-02-01T00:00:00.000Z");
        const next = await store.recordFact(makeFact({ value: { what: "CRO" }, supersedes: old.id }));
        expect(next.supersedes).toBe(old.id);
        expect((await store.getFact(old.id))?.retractedAt).toBe(next.recordedAt);
        const current = await store.queryFacts({ subjectId: "entity-subject" });
        expect(current.map((f) => f.id)).toEqual([next.id]);

        await expectStoreError(store.recordFact(makeFact({ supersedes: old.id })), "FACT_ALREADY_RETRACTED");
        await expectStoreError(store.recordFact(makeFact({ supersedes: "missing" })), "FACT_NOT_FOUND");
      });

      test("refuses a model or rule fact superseding a human fact", async () => {
        const human = await store.recordFact(makeFact({ confidence: 1, origin: { kind: "human", by: "user:jack" } }));
        await expectStoreError(store.recordFact(makeFact({ supersedes: human.id })), "HUMAN_OVERRIDE_PROTECTED");
        await expectStoreError(
          store.recordFact(makeFact({ supersedes: human.id, origin: { kind: "rule", by: "rules", version: "1" } })),
          "HUMAN_OVERRIDE_PROTECTED",
        );
        expect((await store.getFact(human.id))?.retractedAt).toBeUndefined();

        // A human may supersede a human.
        clock.set("2026-02-01T00:00:00.000Z");
        const again = await store.recordFact(
          makeFact({ supersedes: human.id, confidence: 1, origin: { kind: "human", by: "user:jack" } }),
        );
        expect((await store.getFact(human.id))?.retractedAt).toBe(again.recordedAt);
      });

      test("caps model/rule confidence below 0.5 next to a believed human fact", async () => {
        await store.recordFact(makeFact({ confidence: 1, origin: { kind: "human", by: "user:jack" } }));
        const model = await store.recordFact(makeFact({ confidence: 0.95 }));
        expect(model.confidence).toBe(0.49);
        expect((await store.getFact(model.id))?.confidence).toBe(0.49);
        const rule = await store.recordFact(makeFact({ confidence: 0.3, origin: { kind: "rule", by: "rules" } }));
        expect(rule.confidence).toBe(0.3);
        // Kept for audit: still queryable, just outranked.
        expect(await store.queryFacts({ subjectId: "entity-subject" })).toHaveLength(3);
        expect(await store.queryFacts({ subjectId: "entity-subject", minConfidence: 0.5 })).toHaveLength(1);

        // Other predicate or subject is unaffected.
        expect((await store.recordFact(makeFact({ predicate: "timezone", confidence: 0.9 }))).confidence).toBe(0.9);
        const other = makeFact({ subject: { entityId: "someone-else" }, confidence: 0.9 });
        expect((await store.recordFact(other)).confidence).toBe(0.9);
      });

      test("does not cap once the human fact is retracted", async () => {
        const human = await store.recordFact(makeFact({ confidence: 1, origin: { kind: "human", by: "user:jack" } }));
        await store.retractFact(human.id, "user:jack");
        expect((await store.recordFact(makeFact({ confidence: 0.9 }))).confidence).toBe(0.9);
      });

      test("retractFact and endFactValidity set their columns", async () => {
        const a = await store.recordFact(makeFact());
        clock.set("2026-02-01T00:00:00.000Z");
        await store.retractFact(a.id, "user:jack");
        expect((await store.getFact(a.id))?.retractedAt).toBe("2026-02-01T00:00:00.000Z");
        await expectStoreError(store.retractFact(a.id, "user:jack"), "FACT_ALREADY_RETRACTED");
        await expectStoreError(store.retractFact("missing", "user:jack"), "FACT_NOT_FOUND");

        const b = await store.recordFact(makeFact({ predicate: "timezone" }));
        await store.endFactValidity(b.id, "2026-01-20T00:00:00Z", "rules");
        const ended = await store.getFact(b.id);
        expect(ended?.validTo).toBe("2026-01-20T00:00:00.000Z");
        expect(ended?.retractedAt).toBeUndefined();
        await expectStoreError(store.endFactValidity(b.id, "2026-01-25T00:00:00Z", "rules"), "FACT_VALIDITY_ALREADY_ENDED");
      });

      inspected("retractFact and endFactValidity write the audit", async (inspect) => {
        const a = await store.recordFact(makeFact());
        clock.set("2026-02-01T00:00:00.000Z");
        await store.retractFact(a.id, "user:jack");
        const b = await store.recordFact(makeFact({ predicate: "timezone" }));
        await store.endFactValidity(b.id, "2026-01-20T00:00:00Z", "rules");

        const audit = await inspect.factAudit(store);
        expect(audit).toContainEqual({ fact_id: a.id, action: "retract", by: "user:jack", at: "2026-02-01T00:00:00.000Z" });
        expect(audit).toContainEqual(expect.objectContaining({ fact_id: b.id, action: "end_validity", by: "rules" }));
      });

      test("queryFacts filters by type, predicate, subject, object, entity, tags, confidence and limit", async () => {
        const f1 = await store.recordFact(
          makeFact({ type: "commitment", predicate: "committed_to", object: { entityId: "org" }, tags: ["a", "b"] }),
        );
        clock.set("2026-01-11T00:00:00.000Z");
        const f2 = await store.recordFact(makeFact({ type: "ask", predicate: "asked", tags: ["c"], confidence: 0.4 }));
        clock.set("2026-01-12T00:00:00.000Z");
        const f3 = await store.recordFact(makeFact({ type: "attribute", subject: { entityId: "org" }, predicate: "domain" }));
        const ids = (fs: Fact[]) => fs.map((f) => f.id);

        expect(ids(await store.queryFacts({}))).toEqual([f3.id, f2.id, f1.id]);
        expect(ids(await store.queryFacts({ type: "ask" }))).toEqual([f2.id]);
        expect(ids(await store.queryFacts({ type: ["ask", "commitment"] }))).toEqual([f2.id, f1.id]);
        expect(ids(await store.queryFacts({ predicate: "domain" }))).toEqual([f3.id]);
        expect(ids(await store.queryFacts({ subjectId: "org" }))).toEqual([f3.id]);
        expect(ids(await store.queryFacts({ objectId: "org" }))).toEqual([f1.id]);
        expect(ids(await store.queryFacts({ entityId: "org" }))).toEqual([f3.id, f1.id]);
        expect(ids(await store.queryFacts({ tags: ["b", "c"] }))).toEqual([f2.id, f1.id]);
        expect(ids(await store.queryFacts({ tags: ["zzz"] }))).toEqual([]);
        expect(ids(await store.queryFacts({ minConfidence: 0.5 }))).toEqual([f3.id, f1.id]);
        expect(ids(await store.queryFacts({ limit: 2 }))).toEqual([f3.id, f2.id]);
        expect(ids(await store.queryFacts({ tenantId: "other" }))).toEqual([]);
      });

      test("queryFacts defaults validAt and asOf to now", async () => {
        clock.set("2026-01-10T00:00:00.000Z");
        const future = await store.recordFact(makeFact({ validFrom: "2026-06-01T00:00:00Z" }));
        expect(await store.queryFacts({})).toEqual([]);
        expect((await store.queryFacts({ validAt: "2026-07-01T00:00:00Z" })).map((f) => f.id)).toEqual([future.id]);
        // Before it was recorded we did not know it.
        expect(await store.queryFacts({ validAt: "2026-07-01T00:00:00Z", asOf: "2026-01-01T00:00:00Z" })).toEqual([]);
      });

      test("answers what was true and what we knew (bi-temporal)", async () => {
        const JAN = "2026-01-01T00:00:00.000Z";
        const MAY = "2026-05-15T00:00:00.000Z";
        const JUNE = "2026-06-01T00:00:00.000Z";
        const JULY = "2026-07-15T00:00:00.000Z";
        const AUG = "2026-08-10T00:00:00.000Z";
        const worksAt = (org: string, validFrom: string, supersedes?: string) =>
          makeFact({
            type: "relationship",
            subject: { entityId: "champion", name: "Dana" },
            object: { entityId: org, name: org },
            predicate: "works_at",
            value: { org },
            statement: `Dana works at ${org}.`,
            validFrom,
            ...(supersedes ? { supersedes } : {}),
          });
        const orgs = (fs: Fact[]) => fs.map((f) => f.object?.entityId).sort();

        clock.set(JAN);
        const acme = await store.recordFact(worksAt("acme", JAN));
        clock.set(AUG);
        const globex = await store.recordFact(worksAt("globex", JUNE, acme.id));
        clock.set("2026-10-01T00:00:00.000Z");

        const q = { subjectId: "champion", predicate: "works_at" };
        expect(orgs(await store.queryFacts({ ...q, validAt: MAY }))).toEqual(["acme"]);
        expect(orgs(await store.queryFacts({ ...q, validAt: JULY, asOf: JULY }))).toEqual(["acme"]);
        expect(orgs(await store.queryFacts({ ...q, validAt: JULY }))).toEqual(["globex"]);
        expect(orgs(await store.queryFacts({ ...q, includeRetracted: true }))).toEqual(["acme", "globex"]);

        // The original is untouched apart from its closed transaction time.
        const original = await store.getFact(acme.id);
        expect(original?.retractedAt).toBe(AUG);
        expect(original?.validTo).toBeUndefined();
        expect(globex.supersedes).toBe(acme.id);
      });

      test("validates inputs", async () => {
        await expectStoreError(store.recordFact(makeFact({ confidence: 1.5 })), "INVALID_INPUT");
        await expectStoreError(store.recordFact(makeFact({ validFrom: "not a date" })), "INVALID_TIME");
        await expectStoreError(
          store.recordFact(makeFact({ validFrom: "2026-02-01T00:00:00Z", validTo: "2026-01-01T00:00:00Z" })),
          "INVALID_INPUT",
        );
      });
    });

    describe("entities", () => {
      test("creates with id and timestamps and round-trips", async () => {
        clock.set("2026-04-01T00:00:00.000Z");
        const e = await store.createEntity(makeEntity({ summary: { parentId: "org-1", eventCount: 3 } }));
        expect(e.id).toMatch(ULID_RE);
        expect(e.tenantId).toBe("local");
        expect(e.createdAt).toBe("2026-04-01T00:00:00.000Z");
        expect(e.updatedAt).toBe(e.createdAt);
        expect(await store.getEntity(e.id)).toEqual(e);
        expect(await store.getEntity("missing")).toBeNull();
      });

      test("findEntities filters by kind, status, identifier, nameLike, parentId and limit", async () => {
        const org = await store.createEntity(
          makeEntity({
            kind: "organization",
            name: "Acme Corp",
            status: "confirmed",
            identifiers: [{ type: "domain", value: "acme.test", confidence: 1, source: "resolve" }],
          }),
        );
        const alice = await store.createEntity(
          makeEntity({
            name: "Alice Smith",
            identifiers: [
              { type: "email", value: "alice@acme.test", confidence: 1, source: "mail" },
              { type: "handle", value: "acme.test", confidence: 0.5, source: "mail" },
            ],
            summary: { parentId: org.id },
          }),
        );
        const bob = await store.createEntity(makeEntity({ name: "Bob 100%_ Jones", status: "rejected" }));
        const ids = (es: { id: string }[]) => es.map((e) => e.id);

        expect(ids(await store.findEntities({ kind: "person" }))).toEqual([alice.id, bob.id]);
        expect(ids(await store.findEntities({ kind: ["person", "organization"] }))).toEqual([org.id, alice.id, bob.id]);
        expect(ids(await store.findEntities({ status: "confirmed" }))).toEqual([org.id]);
        expect(ids(await store.findEntities({ status: ["proposed", "rejected"] }))).toEqual([alice.id, bob.id]);
        expect(ids(await store.findEntities({ identifier: { value: "alice@acme.test" } }))).toEqual([alice.id]);
        expect(ids(await store.findEntities({ identifier: { value: "acme.test" } }))).toEqual([org.id, alice.id]);
        expect(ids(await store.findEntities({ identifier: { type: "domain", value: "acme.test" } }))).toEqual([org.id]);
        expect(ids(await store.findEntities({ identifier: { value: "ACME.TEST" } }))).toEqual([]);
        expect(ids(await store.findEntities({ nameLike: "aLiCe" }))).toEqual([alice.id]);
        expect(ids(await store.findEntities({ nameLike: "100%_" }))).toEqual([bob.id]);
        expect(ids(await store.findEntities({ nameLike: "%" }))).toEqual([bob.id]);
        expect(ids(await store.findEntities({ parentId: org.id }))).toEqual([alice.id]);
        expect(ids(await store.findEntities({ limit: 2 }))).toEqual([org.id, alice.id]);
      });

      test("updateEntity patches fields, bumps updatedAt and reindexes identifiers", async () => {
        const e = await store.createEntity(makeEntity());
        clock.set("2026-05-01T00:00:00.000Z");
        const updated = await store.updateEntity(e.id, {
          name: "Alice B",
          status: "confirmed",
          identifiers: [{ type: "email", value: "new@x.test", confidence: 1, source: "user:jack" }],
        });
        expect(updated.name).toBe("Alice B");
        expect(updated.createdAt).toBe(e.createdAt);
        expect(updated.updatedAt).toBe("2026-05-01T00:00:00.000Z");
        expect(await store.getEntity(e.id)).toEqual(updated);
        expect(await store.findEntities({ identifier: { value: e.identifiers[0]!.value } })).toEqual([]);
        expect((await store.findEntities({ identifier: { value: "new@x.test" } })).map((x) => x.id)).toEqual([e.id]);
        await expectStoreError(store.updateEntity("missing", { name: "x" }), "ENTITY_NOT_FOUND");
      });

      test("mergeEntities moves identifiers, repoints facts and participants", async () => {
        const shared = { type: "email", value: "shared@x.test", confidence: 1, source: "mail" };
        const into = await store.createEntity(makeEntity({ name: "Alice", identifiers: [shared] }));
        const from = await store.createEntity(
          makeEntity({
            name: "A. Smith",
            identifiers: [shared, { type: "email", value: "asmith@x.test", confidence: 1, source: "mail" }],
          }),
        );
        const child = await store.createEntity(makeEntity({ summary: { parentId: from.id } }));
        const { event } = await store.appendEvent(makeEvent());
        await store.setParticipantEntities(event.id, [{ index: 0, entityId: from.id }]);
        const asSubject = await store.recordFact(makeFact({ subject: { entityId: from.id } }));
        const asObject = await store.recordFact(
          makeFact({ predicate: "reports_to", subject: { entityId: "boss" }, object: { entityId: from.id } }),
        );

        clock.set("2026-06-01T00:00:00.000Z");
        const survivor = await store.mergeEntities(from.id, into.id, "user:jack");
        expect(survivor.id).toBe(into.id);
        expect(survivor.identifiers.map((i) => i.value)).toEqual(["shared@x.test", "asmith@x.test"]);

        const merged = await store.getEntity(from.id);
        expect(merged?.status).toBe("merged");
        expect(merged?.mergedInto).toBe(into.id);
        expect((await store.findEntities({ identifier: { value: "asmith@x.test" } })).map((e) => e.id)).toEqual([into.id]);
        expect((await store.findEntities({ identifier: { value: "shared@x.test" } })).map((e) => e.id)).toEqual([into.id]);

        expect((await store.getFact(asSubject.id))?.subject.entityId).toBe(into.id);
        expect((await store.getFact(asObject.id))?.object?.entityId).toBe(into.id);
        expect((await store.getEvent(event.id))?.participants[0]?.entityId).toBe(into.id);
        expect((await store.getEntity(child.id))?.summary?.parentId).toBe(into.id);
        expect((await store.findEntities({ parentId: into.id })).map((e) => e.id)).toEqual([child.id]);

        await expectStoreError(store.mergeEntities(from.id, into.id, "user:jack"), "ENTITY_ALREADY_MERGED");
        await expectStoreError(store.mergeEntities(into.id, into.id, "user:jack"), "INVALID_MERGE");
      });

      inspected("mergeEntities audits both sides", async (inspect) => {
        const into = await store.createEntity(makeEntity({ name: "Alice" }));
        const from = await store.createEntity(makeEntity({ name: "A. Smith" }));
        await store.mergeEntities(from.id, into.id, "user:jack");
        const audit = await inspect.entityAudit(store);
        expect(audit).toContainEqual(expect.objectContaining({ entity_id: from.id, action: "merged_into", by: "user:jack" }));
        expect(audit).toContainEqual(expect.objectContaining({ entity_id: into.id, action: "absorbed", by: "user:jack" }));
      });

      test("resolveEntity follows merge chains", async () => {
        const a = await store.createEntity(makeEntity({ name: "A" }));
        const b = await store.createEntity(makeEntity({ name: "B" }));
        const c = await store.createEntity(makeEntity({ name: "C" }));
        await store.mergeEntities(a.id, b.id, "user:jack");
        await store.mergeEntities(b.id, c.id, "user:jack");
        expect((await store.resolveEntity(a.id))?.id).toBe(c.id);
        expect((await store.resolveEntity(b.id))?.id).toBe(c.id);
        expect((await store.resolveEntity(c.id))?.id).toBe(c.id);
        expect(await store.resolveEntity("missing")).toBeNull();

        // Merging into an already-merged entity lands on the survivor.
        const d = await store.createEntity(makeEntity({ name: "D" }));
        expect((await store.mergeEntities(d.id, a.id, "user:jack")).id).toBe(c.id);
      });
    });

    describe("views, cursors and kv", () => {
      test("defines and lists views per tenant, replacing by name", async () => {
        const view = {
          name: "economic_buyer",
          appliesTo: "deal",
          description: "Who controls the budget.",
          valueType: "entity",
          populatedBy: "model",
        } as const;
        await store.defineView("local", view);
        await store.defineView("local", { ...view, description: "Budget owner." });
        await store.defineView("other", { ...view, name: "stage", valueType: "enum", enumValues: ["a", "b"] });
        expect(await store.listViews("local")).toEqual([{ ...view, description: "Budget owner." }]);
        expect((await store.listViews("other")).map((v) => v.name)).toEqual(["stage"]);
      });

      test("gets and sets cursors per tenant and source", async () => {
        expect(await store.getCursor("local", "mail")).toBeNull();
        await store.setCursor("local", "mail", "100");
        await store.setCursor("local", "mail", "200");
        await store.setCursor("other", "mail", "x");
        expect(await store.getCursor("local", "mail")).toBe("200");
        expect(await store.getCursor("other", "mail")).toBe("x");
      });

      test("stores JSON values in kv", async () => {
        expect(await store.kvGet("ext", "k")).toBeNull();
        await store.kvSet("ext", "k", { n: 1, list: [true, null, "s"] });
        expect(await store.kvGet<unknown>("ext", "k")).toEqual({ n: 1, list: [true, null, "s"] });
        await store.kvSet("ext", "k", 42);
        expect(await store.kvGet<number>("ext", "k")).toBe(42);
        await store.kvSet("ext", "k", "text");
        expect(await store.kvGet<string>("ext", "k")).toBe("text");
        expect(await store.kvGet("other", "k")).toBeNull();
        await store.kvDelete("ext", "k");
        expect(await store.kvGet("ext", "k")).toBeNull();
        await expectStoreError(store.kvSet("ext", "k", undefined), "INVALID_INPUT");
      });
    });

    describe("model calls", () => {
      test("records calls and sums cost since a time", async () => {
        expect(isModelCallStore(store)).toBe(true);
        if (!isModelCallStore(store)) return;
        clock.set("2026-03-01T00:00:00.000Z");
        const id = await store.recordModelCall({
          tenantId: "local",
          tier: "extract",
          provider: "anthropic",
          model: "m",
          inputTokens: 100,
          outputTokens: 10,
          costUsd: 0.01,
          latencyMs: 120,
          meta: { eventId: "e1" },
        });
        expect(id).toMatch(ULID_RE);
        await store.recordModelCall({ tenantId: "local", tier: "triage", provider: "p", model: "m", costUsd: 0.002, createdAt: "2026-03-05T00:00:00Z" });
        await store.recordModelCall({ tenantId: "other", tier: "triage", provider: "p", model: "m", costUsd: 5 });
        expect(await store.sumModelCost("local", "2026-01-01T00:00:00Z")).toBeCloseTo(0.012);
        expect(await store.sumModelCost("local", "2026-03-02T00:00:00Z")).toBeCloseTo(0.002);
        expect(await store.sumModelCost("nobody", "2026-01-01T00:00:00Z")).toBe(0);
      });
    });

    describe("lifecycle", () => {
      test("throws StoreError after close", async () => {
        const s = await factory({ clock: () => clock.now() });
        await s.migrate();
        await s.close();
        await expectStoreError(s.getEvent("x"), "STORE_CLOSED");
        await expectStoreError(s.appendEvent(makeEvent()), "STORE_CLOSED");
        await expectStoreError(s.queryFacts({}), "STORE_CLOSED");
        await expectStoreError(s.kvGet("a", "b"), "STORE_CLOSED");
        await s.close(); // closing twice is harmless
      });
    });
  });
}
