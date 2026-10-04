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
    // Pleasantries, bare check-ins and slot proposals are not asks to track.
    ["How are you?", []],
    ["Hope you're well?", []],
    ["Does that work?", []],
    ["Make sense?", []],
    ["Would a 45-minute discovery call on June 16 or 17 work?", []],
    ["Does Thursday at 2pm work for you?", []],
    ["Can you send it?", ["ask"]],
    ["Could we find 30 minutes next week?", ["ask"]],
    ["Does the edge agent work without outbound internet access?", ["ask"]],
    // A promise to decide, and pencilling someone in, are not deliverables.
    ["We'll make a call on scope after our scoping session on the 8th.", []],
    ["Yes, we can do the week of the 24th; I'll pencil in Luis, who did Sparks.", []],
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

describe("who owes a reported promise", () => {
  it("resolves she/he/they to the participant named most recently before it", async () => {
    const text = "Jack,\n\nElena Vasquez in security is copied. She'll have the questionnaire back to you by July 17.";
    const ev = message(MARCUS, [JACK], text, { cc: [ELENA], at: "2026-07-09T16:31:00.000Z" });
    const [c] = ofType(await run(ev), "commitment");
    expect(c!.subject.entityId).toBe(ELENA.entityId);
    expect(c!.object?.entityId).toBe(JACK.entityId);
    expect(c!.confidence).toBeGreaterThanOrEqual(0.6);
  });

  it("keeps the sender at low confidence when the pronoun cannot be resolved", async () => {
    const lone = message(MARCUS, [JACK], "She'll have the order form back to you by July 17.", { at: "2026-07-09T16:31:00.000Z" });
    const [c] = ofType(await run(lone), "commitment");
    expect(c!.subject.entityId).toBe(MARCUS.entityId);
    expect(c!.confidence).toBe(0.4);

    // Named, but not on the message: still a guess.
    const offList = message(MARCUS, [JACK], "Rachel runs procurement. She'll have the order form back to you by July 17.", {
      at: "2026-07-09T16:31:00.000Z",
    });
    const [d] = ofType(await run(offList), "commitment");
    expect(d!.subject.entityId).toBe(MARCUS.entityId);
    expect(d!.confidence).toBe(0.4);
  });
});

describe("meetings and notes", () => {
  const asMeeting = (ev: ReturnType<typeof message>, cancelled: boolean) => ({
    ...ev,
    kind: "meeting",
    source: "calendar",
    participants: ev.participants.map((p) => ({ ...p, role: p.role === "from" ? "organizer" : "attendee" })),
    meta: { cancelled },
  });

  it("emits nothing for a cancelled meeting", async () => {
    const ev = asMeeting(
      message(JACK, [MARCUS], "Cancelled at Marcus Bell's request: the Reno pilot is on hold until the security review clears."),
      true,
    );
    expect(await run(ev)).toEqual([]);
  });

  it("does not read an agenda as a decision, objection or promise unless it is in the first person", async () => {
    const agenda = asMeeting(message(JACK, [MARCUS], "The pilot is on hold until security signs off. Elena will send the policy by Friday."), false);
    expect(await run(agenda)).toEqual([]);
    const mine = asMeeting(message(JACK, [MARCUS], "I'll send the agenda by Friday."), false);
    expect(ofType(await run(mine), "commitment")).toHaveLength(1);
  });

  it("reads a note as the author's words, with named attendees owning their promises", async () => {
    const ev = message(JACK, [], "## Commitments\n\n- Dana will send the subprocessor list by September 4.\n- Elena chose Option A. She will confirm in writing by August 28.");
    const note = {
      ...ev,
      kind: "note",
      source: "notes",
      participants: [
        { role: "author", self: true, entityId: JACK.entityId, name: JACK.name },
        { role: "attendee", entityId: DANA.entityId, name: DANA.name, self: true },
        { role: "attendee", entityId: ELENA.entityId, name: ELENA.name },
      ],
    };
    const owners = ofType(await run(note, context(note)), "commitment").map((f) => f.subject.entityId);
    expect(owners).toEqual([DANA.entityId, ELENA.entityId]);
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

describe("closing across threads", () => {
  const proposal = () =>
    stored({
      type: "commitment",
      validFrom: "2026-06-17T13:20:00.000Z",
      subject: { entityId: JACK.entityId, name: JACK.name },
      object: { entityId: ELENA.entityId, name: ELENA.name },
      value: {
        what: "I'll send a written pilot proposal with two scoping options by June 26.",
        owedBy: { entityId: JACK.entityId },
        owedTo: { entityId: ELENA.entityId },
        dueAt: "2026-06-26",
        status: "open",
      },
    });
  const AT = "2026-06-26T16:03:00.000Z";

  it("fulfils a promise delivered in a new thread that names the deliverable", async () => {
    const c = proposal();
    const text = "Elena,\n\nAttached is the pilot proposal, built on the Reno data. Two options below.";
    const ev = message(JACK, [ELENA, MARCUS], text, { thread: "t2", at: AT });
    const [closed] = await run(ev, context(ev, { knownFacts: [c] }));
    expect(closed!.supersedes).toBe(c.id);
    expect(closed!.value as CommitmentValue).toMatchObject({ status: "fulfilled", resolvedBy: ev.id, dueAt: "2026-06-26" });
    const by = closed!.provenance.at(-1)!;
    expect(by.eventId).toBe(ev.id);
    expect(by.quote).toBe("Attached is the pilot proposal, built on the Reno data.");
    expect(text.slice(by.span!.start, by.span!.end)).toBe(by.quote!);
  });

  it("leaves it open when the delivery is of something else, or not to the party owed", async () => {
    const c = proposal();
    const other = message(JACK, [ELENA], "Attached is the signed NDA.", { thread: "t2", at: AT });
    expect(await run(other, context(other, { knownFacts: [c] }))).toEqual([]);
    const elsewhere = message(JACK, [MARCUS], "Attached is the pilot proposal.", { thread: "t2", at: AT });
    expect(await run(elsewhere, context(elsewhere, { knownFacts: [c] }))).toEqual([]);
    const noDelivery = message(JACK, [ELENA], "The pilot proposal is taking longer than planned.", { thread: "t2", at: AT });
    expect(await run(noDelivery, context(noDelivery, { knownFacts: [c] }))).toEqual([]);
  });

  it("fulfils a promise when the party owed acknowledges receipt", async () => {
    const c = stored({
      type: "commitment",
      validFrom: "2026-07-09T16:31:00.000Z",
      subject: { entityId: MARCUS.entityId, name: MARCUS.name },
      object: { entityId: JACK.entityId, name: JACK.name },
      value: { what: "We'll send the signed order form by Friday.", owedBy: { entityId: MARCUS.entityId }, dueAt: "2026-07-17", status: "open" },
    });
    const ev = message(JACK, [MARCUS], "Thanks for sending the signed order form. Countersigned copy to follow.", {
      thread: "t2",
      at: "2026-07-18T13:00:00.000Z",
    });
    const [closed] = await run(ev, context(ev, { knownFacts: [c] }));
    expect(closed!.value as CommitmentValue).toMatchObject({ status: "fulfilled", resolvedBy: ev.id });
    expect(closed!.provenance.at(-1)!.quote).toBe("Thanks for sending the signed order form.");
  });

  it("answers an ask from another thread only when the reply addresses it", async () => {
    const ask = stored({
      type: "ask",
      subject: { entityId: MARCUS.entityId, name: MARCUS.name },
      object: { entityId: JACK.entityId, name: JACK.name },
      value: {
        what: "What happens to our data if we end after the pilot?",
        askedBy: { entityId: MARCUS.entityId },
        askedOf: { entityId: JACK.entityId },
        answered: false,
      },
    });
    const answer = message(JACK, [MARCUS], "On your question: if you end after the pilot, we delete your data within 30 days.", {
      thread: "t2",
      at: "2026-08-28T10:00:00.000Z",
    });
    const [closed] = await run(answer, context(answer, { knownFacts: [ask] }));
    expect(closed!.value as AskValue).toMatchObject({ answered: true, answeredBy: answer.id });

    const unrelated = message(JACK, [MARCUS], "Attached is the updated order form for the pilot.", { thread: "t2", at: "2026-08-28T10:00:00.000Z" });
    expect(await run(unrelated, context(unrelated, { knownFacts: [ask] }))).toEqual([]);
  });

  it("never supersedes a human fact from another thread", async () => {
    const c = { ...proposal(), origin: { kind: "human" as const, by: "user:jack" } };
    const ev = message(JACK, [ELENA], "Attached is the pilot proposal.", { thread: "t2", at: AT });
    expect(await run(ev, context(ev, { knownFacts: [c] }))).toEqual([]);
  });
});
