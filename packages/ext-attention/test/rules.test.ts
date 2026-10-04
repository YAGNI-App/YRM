import { describe, expect, it } from "bun:test";
import type { AskValue, CommitmentValue, ObjectionValue, QueueItem } from "@yrm/core";
import { mergeItems } from "../src/index.ts";
import { byRule, harness, ref } from "./helpers.ts";

const ask = (h: Awaited<ReturnType<typeof harness>>, from: Parameters<typeof ref>[0], validFrom: string, extra: Partial<AskValue> = {}) =>
  h.fact<AskValue>({
    type: "ask",
    predicate: "asked",
    subject: ref(from),
    object: ref(h.me),
    value: { what: "Can we exit the pilot with no fee if Type II slips?", askedBy: ref(from), askedOf: ref(h.me), answered: false, ...extra },
    validFrom,
  });

const commitment = (
  h: Awaited<ReturnType<typeof harness>>,
  by: Parameters<typeof ref>[0],
  to: Parameters<typeof ref>[0],
  dueAt: string,
  extra: Partial<CommitmentValue> = {},
) =>
  h.fact<CommitmentValue>({
    type: "commitment",
    predicate: "committed_to",
    subject: ref(by),
    object: ref(to),
    value: { what: "Send the SOC 2 Type II report", owedBy: ref(by), owedTo: ref(to), dueAt, status: "open", ...extra },
    validFrom: "2026-08-27T10:00:00Z",
  });

describe("unanswered-ask", () => {
  it("surfaces an open ask to you, with the asker's role adding weight", async () => {
    const h = await harness();
    const marcus = await h.person("Marcus Bell", "marcus@acme.example");
    const evId = await h.event({ at: "2026-09-28T10:00:00Z", title: "Exit terms", from: marcus, to: [h.me] });
    const f = await h.fact<AskValue>({
      type: "ask",
      subject: ref(marcus),
      object: ref(h.me),
      value: { what: "Can we exit with no fee?", answered: false },
      validFrom: "2026-09-28T10:00:00Z",
      provenance: [{ eventId: evId }],
    });
    await h.fact({ type: "role", predicate: "economic_buyer", subject: ref(marcus), value: { what: "economic buyer" } });

    const [item] = byRule(await h.rank(), "unanswered-ask");
    expect(item).toBeDefined();
    expect(item!.key).toBe(`unanswered-ask:${f.id}`);
    expect(item!.score).toBeCloseTo(0.5 + 5 / 14 + 0.1, 3);
    expect(item!.action).toBe("Reply to Marcus Bell about: Can we exit with no fee?");
    expect(item!.reason).toBe("Asked 5 days ago in 'Exit terms'; no reply from you since.");
    expect(item!.about).toEqual([{ entityId: marcus.id, name: "Marcus Bell" }]);
    expect(item!.evidence).toEqual({ factIds: [f.id], eventIds: [evId] });
  });

  it("waits two days, caps age at 0.4 and clips long asks", async () => {
    const h = await harness();
    const a = await h.person("Ann", "ann@acme.example");
    await ask(h, a, "2026-10-02T09:00:00Z");
    expect(byRule(await h.rank(), "unanswered-ask")).toHaveLength(0);
    const [item] = byRule(await h.rank("2026-10-04"), "unanswered-ask");
    expect(item!.score).toBeCloseTo(0.5 + 2 / 14, 3);
    const [old] = byRule(await h.rank("2026-12-30"), "unanswered-ask");
    expect(old!.score).toBe(0.9);

    const long = await harness();
    const b = await long.person("Bo", "bo@acme.example");
    await ask(long, b, "2026-09-01T09:00:00Z", { what: "x".repeat(200) });
    const [clipped] = byRule(await long.rank(), "unanswered-ask");
    expect(clipped!.action.length).toBeLessThanOrEqual("Reply to Bo about: ".length + 80);
  });

  it("drops an ask once a superseding answered fact is recorded, and ignores asks of others", async () => {
    const h = await harness();
    const a = await h.person("Ann", "ann@acme.example");
    const b = await h.person("Bob", "bob@acme.example");
    const open = await ask(h, a, "2026-09-01T09:00:00Z");
    await h.fact<AskValue>({ ...open, supersedes: open.id, value: { ...open.value, answered: true, answeredBy: "evt" }, validFrom: "2026-09-02T09:00:00Z" });
    await h.fact<AskValue>({ type: "ask", subject: ref(a), object: ref(b), value: { what: "Ping Bob", answered: false }, validFrom: "2026-09-01T09:00:00Z" });
    expect(byRule(await h.rank(), "unanswered-ask")).toHaveLength(0);
  });
});

describe("overdue-commitment", () => {
  it("scores your own late promise higher than someone else's", async () => {
    const h = await harness();
    const elena = await h.person("Elena Vasquez", "elena@acme.example");
    const tom = await h.person("Tom Fischer", "tom@acme.example");
    const mine = await commitment(h, h.me, elena, "2026-09-30");
    const theirs = await commitment(h, tom, h.me, "2026-09-26", { what: "Install the agent" });
    const items = byRule(await h.rank(), "overdue-commitment");
    const m = items.find((i) => i.key === `overdue-commitment:${mine.id}`)!;
    const t = items.find((i) => i.key === `overdue-commitment:${theirs.id}`)!;
    expect(m.score).toBe(0.95); // 0.6 + min(3/7, 0.35)
    expect(m.action).toBe("Deliver to Elena Vasquez: Send the SOC 2 Type II report");
    expect(m.dueAt).toBe("2026-09-30");
    expect(m.about[0]!.name).toBe("Elena Vasquez");
    expect(t.score).toBe(0.7); // 0.4 + min(7/14, 0.3)
    expect(t.action).toBe("Follow up with Tom Fischer on: Install the agent");
  });

  it("is not overdue on the due date, and a fulfilled commitment is gone", async () => {
    const h = await harness();
    const e = await h.person("E", "e@acme.example");
    await commitment(h, h.me, e, "2026-10-03");
    const done = await commitment(h, h.me, e, "2026-09-20");
    await h.fact<CommitmentValue>({ ...done, supersedes: done.id, value: { ...done.value, status: "fulfilled" }, validFrom: "2026-09-19T00:00:00Z" });
    const items = await h.rank();
    expect(byRule(items, "overdue-commitment")).toHaveLength(0);
    expect(byRule(items, "due-soon")).toHaveLength(1);
    const [late] = byRule(await h.rank("2026-10-04"), "overdue-commitment");
    expect(late!.score).toBeCloseTo(0.6 + 1 / 7, 3);
  });
});

describe("due-soon", () => {
  it("covers today through three days out", async () => {
    const h = await harness();
    const e = await h.person("E", "e@acme.example");
    const today = await commitment(h, h.me, e, "2026-10-03");
    const three = await commitment(h, e, h.me, "2026-10-06T17:00:00Z", { what: "Send redlines" });
    await commitment(h, h.me, e, "2026-10-07");
    const items = byRule(await h.rank(), "due-soon");
    expect(items.map((i) => i.key).sort()).toEqual([`due-soon:${today.id}`, `due-soon:${three.id}`].sort());
    expect(items.find((i) => i.key === `due-soon:${today.id}`)!.score).toBeCloseTo(0.65, 3);
    const t = items.find((i) => i.key === `due-soon:${three.id}`)!;
    expect(t.score).toBeCloseTo(0.35, 3);
    expect(t.action).toBe("Check in with E on: Send redlines");
  });
});

describe("broken-commitment", () => {
  it("surfaces for 14 days after it broke", async () => {
    const h = await harness();
    const e = await h.person("Elena", "e@acme.example");
    const c = await commitment(h, h.me, e, "2026-09-15");
    const broken = await h.fact<CommitmentValue>({ ...c, supersedes: c.id, value: { ...c.value, status: "broken" }, validFrom: "2026-09-19T08:00:00Z" });
    const [item] = byRule(await h.rank(), "broken-commitment");
    expect(item!.key).toBe(`broken-commitment:${broken.id}`);
    expect(item!.score).toBe(0.5);
    expect(item!.action).toBe("Reset expectations with Elena on: Send the SOC 2 Type II report");
    expect(byRule(await h.rank("2026-10-04"), "broken-commitment")).toHaveLength(0);
    // The superseded open version is not overdue any more either.
    expect(byRule(await h.rank(), "overdue-commitment")).toHaveLength(0);
  });
});

describe("gone-quiet", () => {
  async function quietOrg(lastInbound: string) {
    const h = await harness();
    const acme = await h.org("Acme Robotics", "acme.example");
    const marcus = await h.person("Marcus Bell", "marcus@acme.example", acme.id);
    await h.event({ at: lastInbound, from: marcus, to: [h.me], title: "Exit?" });
    // Our own later check-in is not contact from them.
    await h.event({ at: "2026-09-30T10:00:00Z", from: h.me, to: [marcus], title: "Checking in" });
    return { h, acme, marcus };
  }

  it("flags an org with open items and no inbound contact for 14+ days", async () => {
    const { h, acme, marcus } = await quietOrg("2026-09-02T17:48:00Z");
    const a = await ask(h, marcus, "2026-09-02T17:48:00Z");
    const [item] = byRule(await h.rank(), "gone-quiet");
    expect(item!.key).toBe(`gone-quiet:${acme.id}`);
    expect(item!.action).toBe("Re-engage Acme Robotics: quiet for 31 days with 1 open item");
    expect(item!.score).toBeCloseTo(0.3 + Math.min(17 / 30, 0.4), 3);
    expect(item!.evidence.factIds).toEqual([a.id]);
    expect(item!.about.map((x) => x.name)).toEqual(["Acme Robotics", "Marcus Bell"]);
  });

  it("needs 14 days and at least one open item, and skips rejected orgs", async () => {
    const recent = await quietOrg("2026-09-20T10:00:00Z");
    await ask(recent.h, recent.marcus, "2026-09-20T10:00:00Z");
    expect(byRule(await recent.h.rank(), "gone-quiet")).toHaveLength(0);
    const [edge] = byRule(await recent.h.rank("2026-10-04"), "gone-quiet");
    expect(edge!.score).toBeCloseTo(0.3, 3);

    const idle = await quietOrg("2026-08-01T10:00:00Z");
    expect(byRule(await idle.h.rank(), "gone-quiet")).toHaveLength(0);

    const h = await harness();
    const rejected = await h.org("Spam Co", "spam.example", "rejected");
    const p = await h.person("P", "p@spam.example", rejected.id);
    await h.event({ at: "2026-08-01T10:00:00Z", from: p, to: [h.me] });
    await ask(h, p, "2026-08-01T10:00:00Z");
    expect(byRule(await h.rank(), "gone-quiet")).toHaveLength(0);
  });

  it("falls back to summary.lastSeen when a person has no events", async () => {
    const h = await harness();
    const acme = await h.org("Acme", "acme.example");
    const p = await h.store.createEntity({
      tenantId: "local",
      kind: "person",
      name: "Quiet Person",
      status: "confirmed",
      identifiers: [],
      summary: { parentId: acme.id, lastSeen: "2026-09-01T00:00:00Z" },
    });
    await h.fact({ type: "objection", subject: ref(p), value: { what: "Too pricey", resolved: false, severity: "low" } });
    const [item] = byRule(await h.rank(), "gone-quiet");
    expect(item!.action).toBe("Re-engage Acme: quiet for 32 days with 1 open item");
  });
});

describe("open-objection", () => {
  it("scores high and medium, skips low and resolved", async () => {
    const h = await harness();
    const elena = await h.person("Elena Vasquez", "elena@acme.example");
    const obj = (severity: NonNullable<ObjectionValue["severity"]>, resolved = false) =>
      h.fact<ObjectionValue>({ type: "objection", subject: ref(elena), value: { what: `SOC 2 ${severity}`, raisedBy: ref(elena), severity, resolved } });
    const high = await obj("high");
    const med = await obj("medium");
    await obj("low");
    const res = await obj("high");
    await h.fact<ObjectionValue>({ ...res, supersedes: res.id, value: { ...res.value, resolved: true } });
    const items = byRule(await h.rank(), "open-objection");
    expect(items.map((i) => [i.key, i.score])).toEqual([
      [`open-objection:${high.id}`, 0.55],
      [`open-objection:${med.id}`, 0.4],
    ]);
    expect(items[0]!.action).toBe("Address Elena Vasquez's concern: SOC 2 high");
  });
});

describe("meeting-prep", () => {
  it("lists open items for attendees of a meeting in the next two days", async () => {
    const h = await harness();
    const elena = await h.person("Elena Vasquez", "elena@acme.example");
    const tom = await h.person("Tom Fischer", "tom@acme.example");
    const meeting = await h.event({
      kind: "meeting",
      at: "2026-10-05T16:00:00Z",
      title: "Security sync",
      attendees: [h.me, elena, tom],
      meta: { start: "2026-10-05T16:00:00Z", end: "2026-10-05T17:00:00Z" },
    });
    const c = await commitment(h, h.me, elena, "2026-10-20");
    const o = await h.fact<ObjectionValue>({ type: "objection", subject: ref(elena), value: { what: "Type II", resolved: false, severity: "high" } });
    const [item] = byRule(await h.rank(), "meeting-prep");
    expect(item!.key).toBe(`meeting-prep:${meeting}`);
    expect(item!.score).toBeCloseTo(0.55, 3);
    expect(item!.action).toBe("Prepare for 'Security sync' with Elena Vasquez: 2 open items");
    expect(item!.evidence.factIds.sort()).toEqual([c.id, o.id].sort());
    expect(item!.evidence.eventIds).toContain(meeting);
    expect(byRule(await h.rank("2026-10-02"), "meeting-prep")).toHaveLength(0);
  });

  it("skips cancelled meetings and meetings with nothing open; caps at 0.7", async () => {
    const h = await harness();
    const e = await h.person("E", "e@acme.example");
    const f = await h.person("F", "f@acme.example");
    await h.event({ kind: "meeting", at: "2026-10-04T16:00:00Z", title: "Kickoff", attendees: [h.me, e], meta: { start: "2026-10-04T16:00:00Z", cancelled: true } });
    await h.event({ kind: "meeting", at: "2026-10-04T16:00:00Z", title: "Coffee", attendees: [h.me, f], meta: { start: "2026-10-04T16:00:00Z" } });
    for (let i = 0; i < 6; i++) await ask(h, e, "2026-10-01T10:00:00Z");
    expect(byRule(await h.rank(), "meeting-prep")).toHaveLength(0);
    await h.event({ kind: "meeting", at: "2026-10-03T16:00:00Z", title: "Review", attendees: [h.me, e], meta: { start: "2026-10-03T16:00:00Z" } });
    const [item] = byRule(await h.rank(), "meeting-prep");
    expect(item!.score).toBe(0.7);
  });
});

describe("job-change", () => {
  async function moved(endOld: boolean) {
    const h = await harness();
    const acme = await h.org("Acme Robotics", "acme.example");
    const nw = await h.org("Northwind", "northwind.example");
    const priya = await h.person("Priya Raman", "priya@northwind.example", nw.id);
    await h.fact({ type: "relationship", predicate: "works_at", subject: ref(priya), object: ref(acme), value: {}, validFrom: "2026-06-01T00:00:00Z", ...(endOld ? { validTo: "2026-08-14T00:00:00Z" } : {}) });
    await h.fact({ type: "relationship", predicate: "works_at", subject: ref(priya), object: ref(nw), value: {}, validFrom: "2026-08-17T00:00:00Z" });
    h.setClock("2026-09-03T12:00:00Z");
    const signal = await h.fact({ type: "signal", predicate: "job_change", subject: ref(priya), value: { leaving: ref(acme), joining: ref(nw) }, validFrom: "2026-08-14T00:00:00Z" });
    // Back to the present: rankers read facts as known now, and the works_at facts were recorded on 10-01.
    h.setClock("2026-10-03T12:00:00Z");
    return { h, signal, priya };
  }

  it("asks you to update a stale works_at within 30 days of learning", async () => {
    const { h, signal } = await moved(false);
    const [item] = byRule(await h.rank(), "job-change");
    expect(item!.key).toBe(`job-change:${signal.id}`);
    expect(item!.score).toBe(0.5);
    expect(item!.action).toBe("Update Priya Raman's organization and find a new contact at Acme Robotics");
    expect(byRule(await h.rank("2026-10-04"), "job-change")).toHaveLength(0);
  });

  it("stays quiet once the old works_at has ended", async () => {
    const { h } = await moved(true);
    expect(byRule(await h.rank(), "job-change")).toHaveLength(0);
  });
});

describe("self resolution", () => {
  it("falls back to people at selfDomains when no address matches", async () => {
    const h = await harness({ settings: { selfAddresses: ["nobody@yagni.example"] } });
    const dana = await h.person("Dana", "dana@yagni.example");
    const x = await h.person("X", "x@acme.example");
    await h.fact<AskValue>({ type: "ask", subject: ref(x), object: ref(dana), value: { what: "Docs?", answered: false }, validFrom: "2026-09-20T00:00:00Z" });
    expect(byRule(await h.rank(), "unanswered-ask")).toHaveLength(1);
  });

  it("can disable a rule through settings", async () => {
    const h = await harness({ settings: { disable: ["unanswered-ask"] } });
    const x = await h.person("X", "x@acme.example");
    await ask(h, x, "2026-09-20T00:00:00Z");
    expect(byRule(await h.rank(), "unanswered-ask")).toHaveLength(0);
    expect(h.host.registry.rankers.has("attention/unanswered-ask")).toBe(false);
  });
});

describe("merge", () => {
  it("dedupes by key, keeps the higher score, unions about and evidence, sorts", () => {
    const base = (key: string, score: number, about: string, fact: string): QueueItem => ({
      key,
      action: key,
      reason: "r",
      score,
      about: [{ entityId: about }],
      evidence: { factIds: [fact], eventIds: [] },
      by: "x",
    });
    const out = mergeItems([base("a", 0.2, "p1", "f1"), base("b", 0.5, "p2", "f2"), base("a", 0.8, "p3", "f3")]);
    expect(out.map((i) => [i.key, i.score])).toEqual([
      ["a", 0.8],
      ["b", 0.5],
    ]);
    expect(out[0]!.about.map((a) => a.entityId)).toEqual(["p1", "p3"]);
    expect(out[0]!.evidence.factIds).toEqual(["f1", "f3"]);
  });

  it("registers merge after the rules and the brief last", async () => {
    const h = await harness();
    const names = h.host.registry.rankers.list().map((r) => r.name);
    expect(names.at(-2)).toBe("attention/merge");
    expect(names.at(-1)).toBe("attention/brief");
    expect(names).toHaveLength(10);
  });
});
