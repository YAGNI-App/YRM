import { describe, expect, it } from "bun:test";
import type { Entity, Store } from "@yrm/core";
import { listSuggestions, suggestionKey, type MergeSuggestion } from "../src/index.ts";
import { ingestAndResolve, message, runCommand, setup, TENANT } from "./helpers.ts";

const JACK = { name: "Jack Collins", address: "jack@yagni.example" };
const PRIYA_ACME = { name: "Priya Raman", address: "priya.raman@acme-robotics.example" };
const PRIYA_NW = { name: "Priya Raman", address: "priya@northwind.example" };
const MARCUS = { name: "Marcus Bell", address: "marcus.bell@acme-robotics.example" };
const TOM_HOME = { name: "Tom Fischer", address: "tfischer@mailhub.example" };
const TOM_WORK = { name: "Tom Fischer", address: "tom.fischer@acme-robotics.example" };

const D1 = "2026-06-02T16:14:22.000Z";
const D2 = "2026-06-03T15:40:51.000Z";

const BATCH = [
  message("m1", D1, PRIYA_ACME, [JACK], { cc: [MARCUS], thread: "intro" }),
  message("m2", D2, MARCUS, [JACK], { cc: [PRIYA_ACME], thread: "intro" }),
  message("m3", "2026-06-20T04:47:03.000Z", TOM_HOME, [JACK], { thread: "agent" }),
  message("m4", "2026-06-20T15:15:40.000Z", JACK, [TOM_HOME], { cc: [TOM_WORK], thread: "agent" }),
  // Plus-addressing and a mail-host subdomain both land on what we already know.
  message("m5", "2026-06-25T10:00:00.000Z", { name: "BELL, MARCUS", address: "Marcus.Bell+pilot@Acme-Robotics.example" }, [JACK]),
  message("m6", "2026-07-17T22:48:26.000Z", { name: "Rachel Kim", address: "rachel.kim@mail.acme-robotics.example" }, [JACK]),
  message("m7", "2026-09-10T15:30:27.000Z", PRIYA_NW, [JACK], { thread: "northwind" }),
];

async function byEmail(store: Store, value: string): Promise<Entity> {
  const [e] = await store.findEntities({ tenantId: TENANT, identifier: { type: "email", value } });
  if (!e) throw new Error(`no entity for ${value}`);
  return e;
}

async function byDomain(store: Store, value: string): Promise<Entity | undefined> {
  const [e] = await store.findEntities({ tenantId: TENANT, kind: "organization", identifier: { type: "domain", value } });
  return e;
}

async function counts(store: Store) {
  return {
    entities: (await store.findEntities({ tenantId: TENANT })).length,
    facts: (await store.queryFacts({ tenantId: TENANT, includeRetracted: true })).length,
  };
}

describe("header-resolver", () => {
  it("proposes a person per address and an organization per company domain", async () => {
    const { host, store } = await setup();
    const events = await ingestAndResolve(host, BATCH);
    expect(events.every((e) => e.participants.every((p) => p.entityId !== undefined))).toBe(true);

    const people = await store.findEntities({ tenantId: TENANT, kind: "person" });
    expect(people.map((p) => p.name).sort()).toEqual([
      "Jack Collins",
      "Marcus Bell",
      "Priya Raman",
      "Priya Raman",
      "Rachel Kim",
      "Tom Fischer",
      "Tom Fischer",
    ]);
    expect(people.every((p) => p.status === "proposed")).toBe(true);

    const orgs = await store.findEntities({ tenantId: TENANT, kind: "organization" });
    expect(orgs.map((o) => o.name).sort()).toEqual(["Acme Robotics", "Northwind", "YAGNI"]);
    expect(await byDomain(store, "mailhub.example")).toBeUndefined();
    expect((await byDomain(store, "yagni.example"))?.status).toBe("confirmed");

    // Plus-tag matched Marcus and was kept as a second identifier.
    const marcus = await byEmail(store, "marcus.bell@acme-robotics.example");
    expect(marcus.identifiers.map((i) => i.value).sort()).toEqual([
      "marcus.bell+pilot@acme-robotics.example",
      "marcus.bell@acme-robotics.example",
    ]);
    const main = marcus.identifiers.find((i) => i.value === "marcus.bell@acme-robotics.example")!;
    expect(main).toMatchObject({ source: "resolve", confidence: 1, firstSeen: D1, lastSeen: "2026-06-25T10:00:00.000Z" });

    // mail.acme-robotics.example is Acme.
    const acme = (await byDomain(store, "acme-robotics.example"))!;
    const rachel = await byEmail(store, "rachel.kim@mail.acme-robotics.example");
    expect(rachel.summary?.parentId).toBe(acme.id);
    await host.close();
  });

  it("records works_at from the first message and sets parentId", async () => {
    const { host, store } = await setup();
    await ingestAndResolve(host, BATCH);
    const acme = (await byDomain(store, "acme-robotics.example"))!;
    const yagni = (await byDomain(store, "yagni.example"))!;
    const priya = await byEmail(store, PRIYA_ACME.address);
    const marcus = await byEmail(store, MARCUS.address);
    const jack = await byEmail(store, JACK.address);
    const tomHome = await byEmail(store, TOM_HOME.address);

    expect(priya.summary?.parentId).toBe(acme.id);
    expect(jack.summary?.parentId).toBe(yagni.id);
    expect(tomHome.summary?.parentId).toBeUndefined();

    for (const [person, org, from] of [
      [priya, acme, D1],
      [marcus, acme, D1],
      [jack, yagni, D1],
    ] as const) {
      const facts = await store.queryFacts({ tenantId: TENANT, subjectId: person.id, predicate: "works_at", objectId: org.id });
      expect(facts).toHaveLength(1);
      expect(facts[0]).toMatchObject({
        type: "relationship",
        validFrom: from,
        confidence: 0.8,
        origin: { kind: "rule", by: "resolve", version: "1" },
      });
      expect(facts[0]!.provenance[0]?.eventId).toBeString();
    }
    expect(await store.queryFacts({ tenantId: TENANT, subjectId: tomHome.id, predicate: "works_at" })).toHaveLength(0);
    await host.close();
  });

  it("creates nothing new when the same event is resolved again", async () => {
    const { host, store } = await setup();
    const result = await host.ingest({
      name: "fake",
      kinds: ["message"],
      async sync(ctx) {
        await ctx.emit(BATCH);
      },
    });
    for (const e of result.events) await host.resolve(e);
    const before = await counts(store);
    const pairs = async () => (await listSuggestions(store, TENANT)).map((s) => [s.from, s.into, s.score]);
    const kvBefore = await pairs();
    // The original, unresolved copies: every resolver runs again from scratch.
    // Suggestions may gain evidence from events that predate the second address, but no new pairs.
    for (const e of result.events) await host.resolve(e);
    expect(await counts(store)).toEqual(before);
    expect(await pairs()).toEqual(kvBefore);
    await host.close();
  });

  it("moves works_at back to an earlier message that arrives late", async () => {
    const { host, store } = await setup();
    await ingestAndResolve(host, [BATCH[1]!]);
    await ingestAndResolve(host, [BATCH[0]!]);
    const acme = (await byDomain(store, "acme-robotics.example"))!;
    const marcus = await byEmail(store, MARCUS.address);
    const facts = await store.queryFacts({ tenantId: TENANT, subjectId: marcus.id, predicate: "works_at", objectId: acme.id });
    expect(facts).toHaveLength(1);
    expect(facts[0]!.validFrom).toBe(D1);
    expect(facts[0]!.supersedes).toBeString();
    expect(facts[0]!.provenance).toHaveLength(2);
    await host.close();
  });
});

describe("same-name suggestions", () => {
  it("suggests Priya's two addresses and merges them on command", async () => {
    const { host, store } = await setup();
    await ingestAndResolve(host, BATCH);
    const old = await byEmail(store, PRIYA_ACME.address);
    const fresh = await byEmail(store, PRIYA_NW.address);

    const signals = await store.queryFacts({ tenantId: TENANT, predicate: "possibly_same_person", subjectId: fresh.id });
    expect(signals).toHaveLength(1);
    expect(signals[0]).toMatchObject({
      type: "signal",
      object: { entityId: old.id },
      confidence: 0.6,
      origin: { kind: "rule", by: "resolve" },
      validFrom: "2026-09-10T15:30:27.000Z",
    });

    const key = suggestionKey(fresh.id, old.id);
    expect(key).toBe(`suggest:${[fresh.id, old.id].sort().join(":")}`);
    const sug = await store.kvGet<MergeSuggestion>("resolve", key);
    expect(sug).toMatchObject({ from: fresh.id, into: old.id, score: 0.6, reason: "same name at different domains" });
    expect(sug!.evidence).toHaveLength(1);

    // Tom wrote from home and was copied at work in the same thread: a stronger suggestion.
    const tomHome = await byEmail(store, TOM_HOME.address);
    const tomWork = await byEmail(store, TOM_WORK.address);
    const tomSug = await store.kvGet<MergeSuggestion>("resolve", suggestionKey(tomHome.id, tomWork.id));
    expect(tomSug).toMatchObject({ from: tomWork.id, into: tomHome.id, score: 0.9 });

    const listed = await runCommand(host, "resolve:suggestions", []);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toHaveLength(2);
    expect(listed.stdout[0]).toContain("Tom Fischer");

    const merged = await runCommand(host, "resolve:merge", [fresh.id, old.id], { user: "jack" });
    expect(merged.code).toBe(0);
    expect((await byEmail(store, PRIYA_ACME.address)).id).toBe(old.id);
    expect((await byEmail(store, PRIYA_NW.address)).id).toBe(old.id);
    expect((await store.getEntity(fresh.id))?.status).toBe("merged");
    expect(await store.kvGet("resolve", key)).toBeNull();
    expect((await listSuggestions(store, TENANT)).map((s) => s.from)).toEqual([tomWork.id]);

    // Northwind's works_at followed Priya to the survivor.
    const nw = (await byDomain(store, "northwind.example"))!;
    expect(await store.queryFacts({ tenantId: TENANT, subjectId: old.id, predicate: "works_at", objectId: nw.id })).toHaveLength(1);
    await host.close();
  });

  it("merge without arguments prints usage", async () => {
    const { host } = await setup();
    const r = await runCommand(host, "resolve:merge", []);
    expect(r.code).toBe(1);
    expect(r.stderr[0]).toContain("usage");
    await host.close();
  });

  it("auto-merges strong suggestions when configured, never bare namesakes", async () => {
    const { host, store } = await setup({ autoMergeSameName: true });
    await ingestAndResolve(host, BATCH);
    const people = await store.findEntities({ tenantId: TENANT, kind: "person", status: "proposed" });
    expect(people.filter((p) => p.name === "Tom Fischer")).toHaveLength(1);
    expect(people.filter((p) => p.name === "Priya Raman")).toHaveLength(2);
    expect((await byEmail(store, TOM_HOME.address)).id).toBe((await byEmail(store, TOM_WORK.address)).id);
    await host.close();
  });
});

describe("name-link-resolver", () => {
  it("links an address-less attendee to the one person with that name", async () => {
    const { host, store } = await setup();
    await ingestAndResolve(host, BATCH.slice(0, 2));
    const [ev] = await ingestAndResolve(host, [
      {
        source: "fake",
        kind: "meeting",
        externalId: "cal-1",
        occurredAt: "2026-06-16T16:00:00.000Z",
        participants: [
          { role: "organizer", address: JACK.address, name: JACK.name },
          { role: "attendee", name: "MARCUS BELL" },
          { role: "attendee", name: "Someone Unknown" },
        ],
        content: { text: "Discovery" },
        meta: {},
      },
    ]);
    const marcus = await byEmail(store, MARCUS.address);
    expect(ev!.participants[1]!.entityId).toBe(marcus.id);
    expect(ev!.participants[2]!.entityId).toBeUndefined();
    await host.close();
  });
});

describe("resolve:job-change", () => {
  it("dates the signal by the message, not the import", async () => {
    const { host, store } = await setup();
    await ingestAndResolve(host, BATCH.slice(0, 1));
    const [late] = await ingestAndResolve(host, [
      message("leaving", "2026-08-15T00:02:45.000Z", PRIYA_ACME, [JACK], {
        cc: [MARCUS],
        text: "Jack,\n\nToday is my last day at Acme. I've accepted a role at Northwind Automation and start there on Monday the 17th.\n\nPriya",
      }),
    ]);
    const { facts } = await host.extract(late!);
    expect(facts).toHaveLength(1);
    const f = facts[0]!;
    const priya = await byEmail(store, PRIYA_ACME.address);
    expect(f).toMatchObject({
      type: "signal",
      predicate: "job_change",
      subject: { entityId: priya.id },
      value: { leaving: "Acme", joining: "Northwind Automation" },
      validFrom: "2026-08-15T00:02:45.000Z",
      origin: { kind: "rule", by: "resolve", version: "1" },
    });
    expect(f.provenance[0]?.quote).toStartWith("Today is my last day at Acme.");
    expect(f.recordedAt > f.validFrom).toBe(true);

    // The old employer is untouched; ending it is someone else's call.
    const acme = (await byDomain(store, "acme-robotics.example"))!;
    expect(await store.queryFacts({ tenantId: TENANT, subjectId: priya.id, predicate: "works_at", objectId: acme.id })).toHaveLength(1);
    await host.close();
  });

  it("falls back to the known employer when the text does not name one", async () => {
    const { host } = await setup();
    const [ev] = await ingestAndResolve(host, [message("x", D1, MARCUS, [JACK], { text: "Friday is my last day, sadly." })]);
    const { facts } = await host.extract(ev!);
    expect(facts[0]?.value).toEqual({ leaving: "Acme Robotics" });
    await host.close();
  });
});
