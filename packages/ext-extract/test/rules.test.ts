import { describe, expect, it } from "bun:test";
import type { AskValue, CommitmentValue, DecisionValue, NewFact, ObjectionValue } from "@yrm/core";
import { classifySentence, createRuleExtractor } from "../src/rules.ts";
import { context, DANA, ELENA, JACK, MARCUS, message, stored } from "./helpers.ts";

const AT = "2026-08-27T14:15:00.000Z";
const kinds = (s: string): string[] => [...classifySentence(s, AT)].sort();
const run = async (ev: ReturnType<typeof message>, ctx = context(ev)) => createRuleExtractor().extract(ev, ctx);
const ofType = (facts: NewFact[], type: string) => facts.filter((f) => f.type === type);

describe("classifySentence", () => {
  const cases: Array<[string, string[]]> = [
    ["Can you send me your current SOC 2 report?", ["ask"]],
    ["Could you confirm the start date", ["ask"]],
    ["Let me know which dates in August work for that.", ["ask"]],
    ["Do you accept net 60", ["ask"]],
    ["Are you able to join on the 3rd", ["ask"]],
    ["Remember I mentioned we were building a practice?", []],
    ["I will send you our SOC 2 Type II report by September 30.", ["commitment"]],
    ["I'll have the agent installed on the test VLAN by August 14.", ["commitment"]],
    ["We'll get you the numbers by end of week.", ["commitment"]],
    ["Dana will send the subprocessor list by September 4.", ["commitment"]],
    ["I'll send it over.", []],
    ["I'll need the installer by end of this week.", []],
    ["I'll send an invite for Thursday.", []],
    ["Following yesterday's session: we're going with Option A.", ["decision"]],
    ["We have decided to start in October.", ["decision"]],
    ["The budget was approved this morning.", ["decision"]],
    ["I want to flag a concern up front.", ["objection"]],
    ["Type II is a hard blocker for us.", ["objection"]],
    ["The Reno pilot is on hold until I have the report.", ["decision", "objection"]],
    ["Jack, Marcus is our VP of Operations and owns the budget.", ["role"]],
    ["Looping in Rachel, who runs procurement.", ["role"]],
    ["Thanks for the time yesterday.", []],
  ];
  for (const [sentence, expected] of cases) {
    it(`${JSON.stringify(sentence)} -> ${expected.join(",") || "nothing"}`, () => {
      expect(kinds(sentence)).toEqual(expected);
    });
  }
});

describe("rule extractor", () => {
  it("records an ask from the sender to the self recipient, with provenance", async () => {
    const text = "Thanks Jack.\n\nIf Type II slips, will you let us exit with no fee? A yes or no is fine.";
    const ev = message(MARCUS, [JACK], text);
    const [ask] = ofType(await run(ev), "ask");
    expect(ask).toBeDefined();
    expect(ask!.subject).toEqual({ entityId: MARCUS.entityId, name: MARCUS.name });
    expect(ask!.object?.entityId).toBe(JACK.entityId);
    expect(ask!.value as AskValue).toMatchObject({ answered: false, askedOf: { entityId: JACK.entityId } });
    expect(ask!.origin).toEqual({ kind: "rule", by: "extract", version: "1" });
    expect(ask!.validFrom).toBe(ev.occurredAt);
    expect(ask!.confidence).toBeGreaterThanOrEqual(0.5);
    expect(ask!.confidence).toBeLessThanOrEqual(0.7);
    const p = ask!.provenance[0]!;
    expect(p.eventId).toBe(ev.id);
    expect(p.speaker?.entityId).toBe(MARCUS.entityId);
    expect(text.slice(p.span!.start, p.span!.end)).toBe(p.quote!);
    expect(p.quote).toBe("If Type II slips, will you let us exit with no fee?");
  });

  it("records a dated commitment owed by the sender to the first other recipient", async () => {
    const ev = message(JACK, [ELENA, MARCUS], "I will send you our SOC 2 Type II report by September 30.", { cc: [DANA] });
    const [c] = ofType(await run(ev), "commitment");
    expect(c!.subject.entityId).toBe(JACK.entityId);
    expect(c!.object?.entityId).toBe(ELENA.entityId);
    expect(c!.value as CommitmentValue).toMatchObject({ dueAt: "2026-09-30", status: "open", owedBy: { entityId: JACK.entityId } });
  });

  it("attributes a named third party's promise to them", async () => {
    const ev = message(JACK, [ELENA], "Follow-ups:\n- Dana will send the subprocessor list by September 4.", { cc: [DANA] });
    const [c] = ofType(await run(ev), "commitment");
    expect(c!.subject.entityId).toBe(DANA.entityId);
    expect(c!.object?.entityId).toBe(ELENA.entityId);
    expect((c!.value as CommitmentValue).dueAt).toBe("2026-09-04");
  });

  it("owes a commitment made to the self side to the self participant", async () => {
    const ev = message(MARCUS, [JACK], "We'll get you the signed order form by Friday.", { at: "2026-07-14T16:00:00.000Z" });
    const [c] = ofType(await run(ev), "commitment");
    expect(c!.object?.entityId).toBe(JACK.entityId);
    expect((c!.value as CommitmentValue).dueAt).toBe("2026-07-17");
  });

  it("records decisions, objections with severity, and roles of people on the message", async () => {
    const ev = message(
      ELENA,
      [JACK],
      "I want to flag a concern up front. The pilot is on hold until I have the report. Jack, Marcus is our VP of Operations and owns the budget.",
      { cc: [MARCUS] },
    );
    const facts = await run(ev);
    const objections = ofType(facts, "objection").map((f) => f.value as ObjectionValue);
    expect(objections.map((o) => o.severity)).toEqual(["medium", "high"]);
    expect(objections.every((o) => o.resolved === false && o.raisedBy?.entityId === ELENA.entityId)).toBe(true);
    const [decision] = ofType(facts, "decision");
    expect((decision!.value as DecisionValue).decidedBy?.entityId).toBe(ELENA.entityId);
    const [role] = ofType(facts, "role");
    expect(role!.subject.entityId).toBe(MARCUS.entityId);
    expect(role!.predicate).toBe("holds_role");
    expect(role!.value).toEqual({ role: "VP of Operations", scope: "acme.example" });
  });

  it("skips a role for someone who is not on the message", async () => {
    const ev = message(MARCUS, [JACK], "Elena Vasquez, who runs information security, will run the review.");
    expect(ofType(await run(ev), "role")).toEqual([]);
  });

  it("skips facts when the sender has no entity", async () => {
    const ev = message(MARCUS, [JACK], "Can you send the deck?");
    ev.participants[0] = { role: "from", address: MARCUS.address };
    expect(await run(ev)).toEqual([]);
  });
});

describe("closing asks and commitments", () => {
  const openAsk = () =>
    stored({
      type: "ask",
      subject: { entityId: MARCUS.entityId, name: MARCUS.name },
      object: { entityId: JACK.entityId, name: JACK.name },
      value: { what: "Can you include pricing?", askedBy: { entityId: MARCUS.entityId }, askedOf: { entityId: JACK.entityId }, answered: false },
    });

  it("answers an open ask when the asked party replies in the thread", async () => {
    const ask = openAsk();
    const ev = message(JACK, [MARCUS], "Pricing for three sites is $13,500 per month.", { at: "2026-08-28T10:00:00.000Z" });
    const [closed] = await run(ev, context(ev, { knownFacts: [ask] }));
    expect(closed!.supersedes).toBe(ask.id);
    expect(closed!.type).toBe("ask");
    expect(closed!.subject.entityId).toBe(MARCUS.entityId);
    expect(closed!.value as AskValue).toMatchObject({ answered: true, answeredBy: ev.id, what: "Can you include pricing?" });
    expect(closed!.validFrom).toBe(ev.occurredAt);
    expect(closed!.provenance.map((p) => p.eventId)).toEqual(["ev-earlier", ev.id]);
  });

  it("leaves the ask open when the reply is in another thread or from someone else", async () => {
    const ask = openAsk();
    const otherThread = message(JACK, [MARCUS], "Checking in.", { thread: "t2", at: "2026-09-22T10:00:00.000Z" });
    expect(await run(otherThread, context(otherThread, { knownFacts: [ask] }))).toEqual([]);
    const fromElena = message(ELENA, [JACK], "Following up.", { at: "2026-09-22T10:00:00.000Z" });
    expect(await run(fromElena, context(fromElena, { knownFacts: [ask] }))).toEqual([]);
  });

  it("matches the thread by provenance when the fact has no thread tag", async () => {
    const ask = { ...openAsk(), tags: [] };
    const earlier = message(MARCUS, [JACK], "Can you include pricing?", { id: "ev-earlier" });
    const ev = message(JACK, [MARCUS], "Yes, see below.");
    const out = await run(ev, context(ev, { knownFacts: [ask], thread: [earlier] }));
    expect(out.map((f) => f.supersedes)).toEqual([ask.id]);
  });

  const openCommitment = (dueAt: string) =>
    stored({
      type: "commitment",
      validFrom: "2026-07-15T13:10:00.000Z",
      subject: { entityId: JACK.entityId, name: JACK.name },
      object: { entityId: ELENA.entityId, name: ELENA.name },
      value: { what: "I'll send the Type I report by July 24.", owedBy: { entityId: JACK.entityId }, dueAt, status: "open" },
    });

  it("fulfils an open commitment when the owing party delivers in the thread", async () => {
    const c = openCommitment("2026-07-24");
    const ev = message(JACK, [ELENA], "As promised, attached under NDA.", { at: "2026-07-23T20:20:00.000Z" });
    const [closed] = await run(ev, context(ev, { knownFacts: [c] }));
    expect(closed!.supersedes).toBe(c.id);
    expect(closed!.value as CommitmentValue).toMatchObject({ status: "fulfilled", resolvedBy: ev.id, dueAt: "2026-07-24" });
  });

  it("marks a commitment broken when the owing party reports a slip after the due date", async () => {
    const c = openCommitment("2026-08-14");
    const ev = message(JACK, [ELENA], "Bad news: the install slipped because of the change freeze.", { at: "2026-08-18T14:58:00.000Z" });
    const [closed] = await run(ev, context(ev, { knownFacts: [c] }));
    expect(closed!.value as CommitmentValue).toMatchObject({ status: "broken", dueAt: "2026-08-14", resolvedBy: ev.id });
  });

  it("does not break a commitment before it is due", async () => {
    const c = openCommitment("2026-09-30");
    const ev = message(JACK, [ELENA], "The auditor pushed the kickoff.", { at: "2026-09-01T14:00:00.000Z" });
    expect(await run(ev, context(ev, { knownFacts: [c] }))).toEqual([]);
  });

  it("never supersedes a human fact", async () => {
    const ask = { ...openAsk(), origin: { kind: "human" as const, by: "user:jack" } };
    const ev = message(JACK, [MARCUS], "Here you go.");
    expect(await run(ev, context(ev, { knownFacts: [ask] }))).toEqual([]);
  });
});
