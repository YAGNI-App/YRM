import { describe, expect, it } from "bun:test";
import type { AskValue, ExtensionAPI, Fact, NewFact, NewSourceEvent, YrmConfig } from "../contracts/index.ts";
import { SqliteStore } from "../store/index.ts";
import { FakeRouter } from "../testing/fake-router.ts";
import { createHost } from "./index.ts";
import { silentLogger } from "./logger.ts";
import { eventKnownAt } from "./pipeline.ts";

/**
 * ADR 0008: facts drawn from imported history are known from when their event
 * was received, not from when YRM indexed it; a live run knows them now.
 */

const config: YrmConfig = {
  tenant: { id: "local", selfAddresses: ["jack@example.com"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} as YrmConfig["models"]["routes"] },
};

const IMPORT_TIME = "2026-10-04T12:00:00.000Z";

const msg = (externalId: string, at: string, text: string, meta: Record<string, unknown> = {}): NewSourceEvent => ({
  source: "fake",
  kind: "message",
  externalId,
  occurredAt: at,
  threadKey: "t1",
  participants: [{ role: "from", address: "alice@acme.com" }],
  content: { text },
  meta,
});

const EVENTS: NewSourceEvent[] = [
  msg("ask", "2026-06-01T10:00:00.000Z", "Can you send the deck?"),
  // Sent in August, held by a gateway, received in September.
  msg("late", "2026-08-14T10:00:00.000Z", "Leaving Acme.", { receivedAt: "Thu, 03 Sep 2026 09:00:00 +0000" }),
  msg("answer", "2026-06-02T10:00:00.000Z", "Here is the deck."),
  msg("pinned", "2026-06-03T10:00:00.000Z", "Pinned."),
];

function extension(yrm: ExtensionAPI): void {
  yrm.registerSource({
    name: "fake",
    kinds: ["message"],
    async sync(ctx) {
      await ctx.emit(EVENTS);
    },
  });
  yrm.registerResolver({
    name: "header",
    priority: 0,
    async resolve(event, ctx) {
      const [found] = await ctx.store.findEntities({ tenantId: ctx.tenantId, identifier: { type: "email", value: "alice@acme.com" } });
      const alice =
        found ??
        (await ctx.store.createEntity({
          kind: "person",
          name: "Alice",
          identifiers: [{ type: "email", value: "alice@acme.com", confidence: 1, source: "header" }],
          status: "proposed",
        }));
      // A resolver-recorded fact (like works_at) on every event.
      await ctx.store.recordFact({
        type: "relationship",
        subject: { entityId: alice.id, name: "Alice" },
        predicate: "ext.test.seen_in",
        value: { externalId: event.externalId },
        statement: `Alice wrote ${event.externalId}.`,
        validFrom: event.occurredAt,
        provenance: [{ eventId: event.id }],
        confidence: 0.8,
        origin: { kind: "rule", by: "header", version: "1" },
        tags: [event.externalId],
      });
      return [{ index: 0, entityId: alice.id }];
    },
  });
  yrm.registerExtractor({
    name: "asks",
    version: "1",
    async extract(event, ctx): Promise<NewFact[]> {
      const alice = ctx.participants[0];
      if (!alice) return [];
      const base: Omit<NewFact<AskValue>, "value" | "statement"> = {
        type: "ask",
        subject: { entityId: alice.id, name: alice.name },
        predicate: "asked",
        validFrom: event.occurredAt,
        provenance: [{ eventId: event.id }],
        confidence: 0.6,
        origin: { kind: "rule", by: "asks", version: "1" },
        tags: [event.externalId],
      };
      if (event.externalId === "ask") {
        const value: AskValue = { what: "the deck", answered: false };
        return [{ ...base, value, statement: "Alice asked for the deck." }];
      }
      if (event.externalId === "answer") {
        // A supersedes closure: the ask, answered by this event.
        const open = ctx.knownFacts.find((f) => f.predicate === "asked");
        if (!open) return [];
        const value: AskValue = { what: "the deck", answered: true, answeredBy: event.id };
        return [{ ...base, value, statement: "Alice asked for the deck (answered).", supersedes: open.id }];
      }
      if (event.externalId === "pinned") {
        // An extractor that knows better sets knownAt itself.
        const value: AskValue = { what: "pinned", answered: false };
        return [{ ...base, value, statement: "Pinned.", knownAt: "2026-07-01T00:00:00.000Z" }];
      }
      return [];
    },
  });
}

async function runWith(live: boolean) {
  const store = new SqliteStore({ path: ":memory:", clock: () => new Date(IMPORT_TIME) });
  await store.migrate();
  const host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  await host.use(extension, { name: "test" });
  await host.run(undefined, { live });
  const all = await store.queryFacts({ includeRetracted: true, validAt: "2026-12-31T00:00:00Z" });
  const tagged = (tag: string, predicate: string): Fact[] => all.filter((f) => f.tags?.includes(tag) && f.predicate === predicate);
  return { store, host, all, tagged };
}

describe("knowledge time from events", () => {
  it("eventKnownAt prefers meta.receivedAt, then occurredAt, and is undefined when live", () => {
    const base = { occurredAt: "2026-08-14T10:00:00.000Z" };
    const at = (meta: Record<string, unknown>, live = false) =>
      eventKnownAt({ ...base, meta } as unknown as Parameters<typeof eventKnownAt>[0], live);
    expect(at({ receivedAt: "2026-09-03T09:00:00Z" })).toBe("2026-09-03T09:00:00.000Z");
    expect(at({})).toBe(base.occurredAt);
    expect(at({ receivedAt: "garbage" })).toBe(base.occurredAt);
    expect(at({ receivedAt: 42 })).toBe(base.occurredAt);
    expect(at({ receivedAt: "2026-09-03T09:00:00Z" }, true)).toBeUndefined();
  });

  it("an import knows extracted and resolver facts from the event, recorded now", async () => {
    const { tagged } = await runWith(false);
    const late = tagged("late", "ext.test.seen_in")[0]!;
    expect(late.recordedAt).toBe(IMPORT_TIME);
    expect(late.knownAt).toBe("2026-09-03T09:00:00.000Z");
    expect(tagged("ask", "ext.test.seen_in")[0]!.knownAt).toBe("2026-06-01T10:00:00.000Z");

    const ask = tagged("ask", "asked")[0]!;
    expect(ask.knownAt).toBe("2026-06-01T10:00:00.000Z");
    expect(ask.recordedAt).toBe(IMPORT_TIME);
  });

  it("a supersedes closure is known when the closing event was, and closes the old fact then", async () => {
    const { tagged, store } = await runWith(false);
    const ask = tagged("ask", "asked")[0]!;
    const answered = tagged("answer", "asked")[0]!;
    expect(answered.supersedes).toBe(ask.id);
    expect(answered.knownAt).toBe("2026-06-02T10:00:00.000Z");
    expect(ask.knownUntil).toBe("2026-06-02T10:00:00.000Z");

    const openOn = async (asOf: string) =>
      (await store.queryFacts({ predicate: "asked", tags: ["ask", "answer"], validAt: asOf, asOf })).map(
        (f) => (f.value as AskValue).answered,
      );
    expect(await openOn("2026-06-01T12:00:00.000Z")).toEqual([false]);
    expect(await openOn("2026-06-02T12:00:00.000Z")).toEqual([true]);
  });

  it("respects a knownAt the extractor set", async () => {
    const { tagged } = await runWith(false);
    expect(tagged("pinned", "asked")[0]!.knownAt).toBe("2026-07-01T00:00:00.000Z");
  });

  it("a live run knows everything now", async () => {
    const { all } = await runWith(true);
    const pinned = all.find((f) => f.statement === "Pinned.")!;
    for (const f of all) if (f !== pinned) expect(f.knownAt).toBe(IMPORT_TIME);
    // An explicit knownAt still stands; the store only clamps it to the record time.
    expect(pinned.knownAt).toBe("2026-07-01T00:00:00.000Z");
  });
});
