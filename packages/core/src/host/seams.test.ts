import { describe, expect, it } from "bun:test";
import type { Entity, ExtensionAPI, Fact, NewSourceEvent, RankContext, TenantConfig, YrmConfig } from "../contracts/index.ts";
import { FakeRouter } from "../testing/fake-router.ts";
import { MemoryStore } from "../testing/memory-store.ts";
import { createHost } from "./index.ts";
import { silentLogger } from "./logger.ts";

const config: YrmConfig = {
  tenant: { id: "local", name: "Jack", selfAddresses: ["jack@example.com"], selfDomains: ["example.com"], timezone: "America/Denver" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} as YrmConfig["models"]["routes"] },
};

const msg = (externalId: string, from: string): NewSourceEvent => ({
  source: "fake",
  kind: "message",
  externalId,
  occurredAt: "2026-09-01T10:00:00.000Z",
  participants: [
    { role: "from", address: from },
    { role: "to", address: "jack@example.com" },
  ],
  content: { text: "hello" },
  meta: {},
});

/** A source that filters two items before emit, and a resolver that creates people and records works_at. */
function seams(seen: { tenant?: Readonly<TenantConfig>; proposed: Entity[]; recorded: Fact[]; rankAsOf: Array<string | undefined> }) {
  return (yrm: ExtensionAPI) => {
    seen.tenant = yrm.config.tenant;
    yrm.registerSource({
      name: "fake",
      kinds: ["message"],
      async sync(ctx) {
        await ctx.emit([msg("a", "alice@acme.test"), msg("b", "bob@acme.test")]);
        ctx.report?.({ dropped: 2 });
        ctx.report?.({ skipped: 1, dropped: -5 });
      },
    });
    yrm.registerResolver({
      name: "people",
      priority: 0,
      async resolve(event, ctx) {
        const out: Array<{ index: number; entityId: string }> = [];
        for (const [index, p] of event.participants.entries()) {
          if (p.self || !p.address) continue;
          const person = await ctx.store.createEntity({
            kind: "person",
            name: p.address,
            identifiers: [{ type: "email", value: p.address, confidence: 1, source: "people" }],
            status: "proposed",
          });
          await ctx.store.recordFact({
            tenantId: ctx.tenantId,
            type: "relationship",
            subject: { entityId: person.id, name: person.name },
            predicate: "works_at",
            value: {},
            statement: `${person.name} works at Acme.`,
            validFrom: event.occurredAt,
            provenance: [{ eventId: event.id }],
            confidence: 0.9,
            origin: { kind: "rule", by: "people", version: "1" },
          });
          out.push({ index, entityId: person.id });
        }
        return out;
      },
    });
    yrm.registerRanker({
      name: "spy",
      async rank(ctx: RankContext, candidates) {
        seen.rankAsOf.push(ctx.asOf);
        return candidates;
      },
    });
    yrm.on("entity:proposed", async (_ctx, entity) => {
      seen.proposed.push(entity);
    });
    yrm.on("fact:recorded", async (_ctx, fact) => {
      seen.recorded.push(fact);
    });
  };
}

async function setup() {
  const seen: Parameters<typeof seams>[0] = { proposed: [], recorded: [], rankAsOf: [] };
  const host = createHost(config, { store: new MemoryStore(), models: new FakeRouter(), log: silentLogger });
  await host.use(seams(seen), { name: "seams" });
  return { host, seen };
}

describe("ConfigReader.tenant", () => {
  it("hands extensions the tenant block", async () => {
    const { seen } = await setup();
    expect(seen.tenant?.selfAddresses).toEqual(["jack@example.com"]);
    expect(seen.tenant?.selfDomains).toEqual(["example.com"]);
    expect(seen.tenant?.timezone).toBe("America/Denver");
  });
});

describe("SyncContext.report", () => {
  it("adds reported drops and skips to the ingest result, ignoring bad counts", async () => {
    const { host } = await setup();
    const r = await host.ingest("fake");
    expect(r.events).toHaveLength(2);
    expect(r.dropped).toBe(2);
    expect(r.skipped).toBe(1);
  });

  it("carries through to the run summary", async () => {
    const { host } = await setup();
    const summary = await host.run();
    expect(summary.sources).toEqual([{ name: "fake", created: 2, duplicates: 0, dropped: 2, skipped: 1 }]);
  });
});

describe("resolve", () => {
  it("fires entity:proposed for each entity a resolver creates", async () => {
    const { host, seen } = await setup();
    const { events } = await host.ingest("fake");
    const r = await host.resolve(events[0]!);
    expect(r.created.map((e) => e.name)).toEqual(["alice@acme.test"]);
    expect(seen.proposed.map((e) => e.name)).toEqual(["alice@acme.test"]);
    expect(seen.proposed[0]!.status).toBe("proposed");
  });

  it("reports facts resolvers record and fires fact:recorded for them", async () => {
    const { host, seen } = await setup();
    const summary = await host.run();
    expect(seen.recorded.map((f) => f.predicate)).toEqual(["works_at", "works_at"]);
    expect(summary.facts).toBe(2);
  });
});

describe("rank asOf", () => {
  it("leaves RankContext.asOf unset by default and passes it through when given", async () => {
    const { host, seen } = await setup();
    await host.rank("2026-10-03");
    await host.rank("2026-10-03", { asOf: "2026-09-01T00:00:00.000Z" });
    expect(seen.rankAsOf).toEqual([undefined, "2026-09-01T00:00:00.000Z"]);
  });
});
