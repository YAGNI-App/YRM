import { describe, expect, it } from "bun:test";
import type {
  AskValue,
  ExtensionAPI,
  ExtractContext,
  NewFact,
  NewSourceEvent,
  QueueItem,
  YrmConfig,
} from "../contracts/index.ts";
import { FakeRouter } from "../testing/fake-router.ts";
import { MemoryStore } from "../testing/memory-store.ts";
import { createHost } from "./index.ts";
import { silentLogger } from "./logger.ts";
import { sortAndDedupe } from "./pipeline.ts";

const config: YrmConfig = {
  tenant: { id: "local", selfAddresses: ["Jack@Example.com"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} as YrmConfig["models"]["routes"] },
};

const msg = (externalId: string, at: string, from: string, to: string[], text: string, meta: Record<string, unknown> = {}): NewSourceEvent => ({
  source: "fake",
  kind: "message",
  externalId,
  occurredAt: at,
  threadKey: "t1",
  participants: [{ role: "from", address: from }, ...to.map((a) => ({ role: "to", address: a }))],
  content: { text, title: "Deck" },
  meta,
});

const BATCH: NewSourceEvent[] = [
  msg("m1", "2026-09-01T10:00:00.000Z", "alice@acme.com", ["jack@example.com"], "Can you send the deck?"),
  msg("m2", "2026-09-01T11:00:00.000Z", "jack@example.com", ["alice@acme.com"], "Sure, sending it tomorrow."),
  msg("m3", "2026-09-02T09:00:00.000Z", "alice@acme.com", ["jack@example.com", "bob@acme.com"], "Thanks. Bob, are you joining?"),
  // Re-delivery of m1: must be dropped by the store's idempotency.
  msg("m1", "2026-09-01T10:00:00.000Z", "alice@acme.com", ["jack@example.com"], "Can you send the deck?"),
  // Bulk mail: an ingest:before hook vetoes it.
  msg("n1", "2026-09-02T12:00:00.000Z", "noreply@news.example", ["jack@example.com"], "Weekly digest?", { bulk: true }),
];

/** One extension exercising every registration the pipeline uses. */
function testExtension(threads: Map<string, string[]>) {
  return (yrm: ExtensionAPI) => {
    yrm.registerSource({
      name: "fake",
      kinds: ["message"],
      async sync(ctx) {
        await ctx.emit(BATCH);
        await ctx.setCursor("after-m3");
      },
    });

    yrm.on("ingest:before", async (_ctx, event) => (event.meta["bulk"] ? null : undefined));

    yrm.registerResolver({
      name: "header",
      priority: 0,
      async resolve(event, ctx) {
        const out: Array<{ index: number; entityId: string }> = [];
        for (const [index, p] of event.participants.entries()) {
          if (p.entityId || !p.address) continue;
          const [found] = await ctx.store.findEntities({ tenantId: ctx.tenantId, identifier: { type: "email", value: p.address } });
          const entity =
            found ??
            (await ctx.store.createEntity({
              kind: "person",
              name: p.address.split("@")[0]!,
              identifiers: [{ type: "email", value: p.address, confidence: 1, source: "header" }],
              status: "proposed",
            }));
          out.push({ index, entityId: entity.id });
        }
        return out;
      },
    });

    // Lower priority; must only ever see participants the header resolver left alone.
    yrm.registerResolver({
      name: "late",
      priority: 100,
      async resolve(event) {
        if (event.participants.some((p) => !p.entityId)) throw new Error("late resolver saw an unresolved participant");
        return [];
      },
    });

    yrm.registerExtractor({
      name: "rules",
      version: "1",
      applies: (event) => event.content.text.includes("?"),
      async extract(event, ctx: ExtractContext): Promise<NewFact[]> {
        threads.set(event.externalId, ctx.thread.map((e) => e.externalId));
        const from = event.participants.find((p) => p.role === "from");
        const speaker = ctx.participants.find((e) => e.identifiers.some((i) => i.value === from?.address));
        if (!speaker) return [];
        const value: AskValue = { what: event.content.text, askedBy: { entityId: speaker.id, name: speaker.name }, answered: false };
        // Leave confidence and origin.version out: the host fills them.
        const fact = {
          type: "ask",
          subject: { entityId: speaker.id, name: speaker.name },
          predicate: "asked",
          value,
          statement: `${speaker.name} asked: ${event.content.text}`,
          validFrom: event.occurredAt,
          provenance: [{ eventId: event.id, speaker: { entityId: speaker.id, name: speaker.name }, quote: event.content.text }],
          origin: { kind: "rule", by: "rules" },
        } as NewFact;
        return [fact];
      },
    });

    // Filter: drop asks about joining.
    yrm.on("extract:after", async (_ctx, _event, facts) =>
      facts.filter((f) => !(f.value as AskValue).what.includes("joining")),
    );

    yrm.registerRanker({
      name: "unanswered",
      async rank(ctx, candidates) {
        const asks = await ctx.store.queryFacts({ tenantId: ctx.tenantId, type: "ask" });
        const items: QueueItem[] = asks
          .filter((f) => (f.value as AskValue).answered === false)
          .map((f) => ({
            key: `ask:${f.id}`,
            action: `Reply to ${f.subject.name}`,
            reason: f.statement,
            score: 0.6,
            about: [{ entityId: f.subject.entityId }],
            evidence: { factIds: [f.id], eventIds: f.provenance.map((p) => p.eventId) },
            by: "unanswered",
          }));
        return [...candidates, ...items];
      },
    });

    // Re-proposes the same key at a lower score, plus one unrelated, higher item.
    yrm.registerRanker({
      name: "echo",
      async rank(_ctx, candidates) {
        const first = candidates[0];
        const extra: QueueItem[] = first ? [{ ...first, score: 0.1, by: "echo" }] : [];
        return [
          ...candidates,
          ...extra,
          { key: "x", action: "x", reason: "x", score: 0.9, about: [], evidence: { factIds: [], eventIds: [] }, by: "echo" },
        ];
      },
    });
  };
}

async function setup() {
  const store = new MemoryStore();
  const host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  const threads = new Map<string, string[]>();
  await host.use(testExtension(threads), { name: "test" });
  return { host, store, threads };
}

describe("pipeline", () => {
  it("runs ingest, resolve, extract, project and rank end to end", async () => {
    const { host, store, threads } = await setup();
    const summary = await host.run(undefined, { today: "2026-09-04" });

    expect(summary.sources).toEqual([{ name: "fake", created: 3, duplicates: 1, dropped: 1 }]);
    expect(summary.events).toBe(3);
    expect(store.events.size).toBe(3);
    expect(await store.getCursor("local", "fake")).toBe("after-m3");

    // Every participant resolved: 2 + 2 + 3.
    expect(summary.resolved).toBe(7);
    expect(store.entities.size).toBe(3);

    // Self marking is case-insensitive against tenant.selfAddresses.
    const events = await store.listEvents({ tenantId: "local" });
    for (const e of events) {
      for (const p of e.participants) expect(p.self === true).toBe(p.address === "jack@example.com");
      expect(e.tenantId).toBe("local");
      expect(e.content.tokens).toBeGreaterThan(0);
    }

    // m1 and m3 contain "?"; extract:after dropped m3's fact.
    expect(summary.facts).toBe(1);
    const [fact] = await store.queryFacts({ tenantId: "local" });
    expect(fact!.confidence).toBe(0.5);
    expect(fact!.origin.version).toBe("1");
    expect(fact!.tenantId).toBe("local");

    // Thread context: prior events in the thread, oldest first.
    expect(threads.get("m1")).toEqual([]);
    expect(threads.get("m3")).toEqual(["m1", "m2"]);

    // Projection.
    const [alice] = await store.findEntities({ identifier: { value: "alice@acme.com" } });
    expect(alice!.summary).toMatchObject({
      eventCount: 3,
      firstSeen: "2026-09-01T10:00:00.000Z",
      lastSeen: "2026-09-02T09:00:00.000Z",
      openAsks: 1,
      openCommitments: 0,
    });
    const [bob] = await store.findEntities({ identifier: { value: "bob@acme.com" } });
    expect(bob!.summary?.eventCount).toBe(1);

    // Ranking: sorted by score, deduped by key keeping the higher-scored copy.
    expect(summary.queue.map((q) => [q.key, q.score])).toEqual([
      ["x", 0.9],
      [`ask:${fact!.id}`, 0.6],
    ]);
    expect(summary.queue[1]!.by).toBe("unanswered");
  });

  it("is idempotent on re-run", async () => {
    const { host, store } = await setup();
    await host.run();
    const again = await host.run("fake");
    expect(again.sources).toEqual([{ name: "fake", created: 0, duplicates: 4, dropped: 1 }]);
    expect(again.facts).toBe(0);
    expect(store.events.size).toBe(3);
    expect(store.facts.size).toBe(1);
  });

  it("lets extract:before skip an event", async () => {
    const { host, store } = await setup();
    host.hooks.on("extract:before", async () => null, "skipper");
    const summary = await host.run();
    expect(summary.extractSkipped).toBe(3);
    expect(store.facts.size).toBe(0);
  });

  it("fires fact:recorded and resolve:after", async () => {
    const { host } = await setup();
    const recorded: string[] = [];
    const resolved: number[] = [];
    host.hooks.on("fact:recorded", async (_c, f) => void recorded.push(f.id));
    host.hooks.on("resolve:after", async (_c, _e, entities) => void resolved.push(entities.length));
    await host.run();
    expect(recorded).toHaveLength(1);
    expect(resolved).toEqual([2, 2, 3]);
  });

  it("builds a context bundle within budget", async () => {
    const { host, store } = await setup();
    await host.run();
    const [alice] = await store.findEntities({ identifier: { value: "alice@acme.com" } });
    const [bob] = await store.findEntities({ identifier: { value: "bob@acme.com" } });

    const full = await host.buildContext({ entityIds: [alice!.id, bob!.id], budget: 10_000 });
    expect(full.sections.map((s) => s.title)).toEqual(["alice (person)", "bob (person)", "Open commitments and asks"]);
    expect(full.sections[0]!.text).toContain("email:alice@acme.com");
    expect(full.sections[0]!.text).toMatch(/alice asked: Can you send the deck\? \(source: \w+, alice, 2026-09-01\)/);
    expect(full.tokens).toBeLessThanOrEqual(10_000);

    // Trims from the end until it fits.
    const firstOnly = Math.ceil(full.sections[0]!.title.length / 4) + Math.ceil(full.sections[0]!.text.length / 4);
    const trimmed = await host.buildContext({ entityIds: [alice!.id, bob!.id], budget: firstOnly });
    expect(trimmed.sections.map((s) => s.title)).toEqual(["alice (person)"]);
    expect(trimmed.tokens).toBe(firstOnly);

    expect((await host.buildContext({ entityIds: [alice!.id], budget: 1 })).sections).toEqual([]);

    // Thread requests pull in non-self participants; hooks can add sections.
    host.hooks.on("context:build", async (_c, _r, draft) => ({
      ...draft,
      sections: [{ title: "Pinned", text: "note" }, ...draft.sections],
    }));
    const byThread = await host.buildContext({ threadKey: "t1", budget: 10_000 });
    expect(byThread.sections.map((s) => s.title)).toEqual(["Pinned", "alice (person)", "bob (person)", "Open commitments and asks"]);
  });

  it("fires host:start and host:stop, and close closes the store", async () => {
    const { host, store } = await setup();
    const seen: string[] = [];
    host.hooks.on("host:start", async () => void seen.push("start"));
    host.hooks.on("host:stop", async () => void seen.push("stop"));
    await host.start();
    await host.close();
    expect(seen).toEqual(["start", "stop"]);
    expect(store.closed).toBe(true);
  });

  it("sortAndDedupe is stable on ties", () => {
    const item = (key: string, score: number, by: string): QueueItem => ({
      key, action: "", reason: "", score, about: [], evidence: { factIds: [], eventIds: [] }, by,
    });
    const out = sortAndDedupe([item("a", 0.5, "1"), item("b", 0.5, "2"), item("a", 0.5, "3")]);
    expect(out.map((q) => `${q.key}${q.by}`)).toEqual(["a1", "b2"]);
  });
});
