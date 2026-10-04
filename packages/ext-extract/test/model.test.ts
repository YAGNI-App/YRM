import { describe, expect, it } from "bun:test";
import { RouterError, type AskValue, type CommitmentValue, type NewFact, type Route } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import { dedupeFacts } from "../src/dedupe.ts";
import {
  buildExtractPrompt,
  createModelExtractor,
  createTriageExtractor,
  findSpan,
  KV_NAMESPACE,
  triageKey,
  type TriageResult,
} from "../src/model.ts";
import { createRuleExtractor } from "../src/rules.ts";
import { context, DANA, ELENA, JACK, MARCUS, message, stored } from "./helpers.ts";

const ROUTE: Route[] = [{ provider: "fake", model: "fake-model" }];
const ROUTES = { triage: ROUTE, extract: ROUTE };

const TEXT =
  "Elena, Marcus,\n\nI will send you our SOC 2 Type II report by September 30. Dana will send the subprocessor list\nby September 4.";

function setup(responses: ConstructorParameters<typeof FakeRouter>[0], routes: Record<string, Route[]> = ROUTES) {
  const store = new MemoryStore();
  const models = new FakeRouter(responses, routes);
  const ev = message(JACK, [ELENA, MARCUS], TEXT, { cc: [DANA] });
  const ctx = context(ev, { models });
  return { store, models, ev, ctx };
}

const TRIAGE_REPLY = {
  json: {
    relevant: true,
    has: { commitment: true, ask: false, decision: false, objection: false, signal: false },
    summary: "Jack commits to Type II by Sept 30.",
  },
};

describe("model-triage", () => {
  it("asks the triage tier once and stores the verdict in kv", async () => {
    const { store, models, ev, ctx } = setup([TRIAGE_REPLY]);
    const triage = createTriageExtractor({ store, models });
    expect(triage.applies?.(ev)).toBe(true);
    expect(await triage.extract(ev, ctx)).toEqual([]);
    expect(models.calls).toHaveLength(1);
    const call = models.calls[0]!;
    expect(call.tier).toBe("triage");
    expect(call.req).toMatchObject({ maxTokens: 200, cacheKey: "extract/triage/v1" });
    expect((call.req.schema as { required: string[] }).required).toEqual(["relevant", "has", "summary"]);
    const saved = await store.kvGet<TriageResult>(KV_NAMESPACE, triageKey(ev.id));
    expect(saved).toMatchObject({ relevant: true, has: { commitment: true }, model: "fake", version: "1" });

    // Second pass reads kv; FakeRouter would throw on an unscripted call.
    expect(await triage.extract(ev, ctx)).toEqual([]);
    expect(models.calls).toHaveLength(1);
  });

  it("does not apply without a triage route", () => {
    const { store, models, ev } = setup([], {});
    expect(createTriageExtractor({ store, models }).applies?.(ev)).toBe(false);
  });

  for (const code of ["NO_ROUTE", "NO_ELIGIBLE_ROUTE", "BUDGET_EXCEEDED"] as const) {
    it(`degrades to [] on ${code}`, async () => {
      const { store, models, ev, ctx } = setup([new RouterError(code, "triage", code)]);
      expect(await createTriageExtractor({ store, models }).extract(ev, ctx)).toEqual([]);
      expect(await store.kvGet(KV_NAMESPACE, triageKey(ev.id))).toBeNull();
    });
  }

  it("rethrows errors that are not about availability", async () => {
    const { store, models, ev, ctx } = setup([new Error("boom")]);
    await expect(createTriageExtractor({ store, models }).extract(ev, ctx)).rejects.toThrow("boom");
  });
});

describe("model-extractor", () => {
  const known = stored({
    type: "ask",
    subject: { entityId: ELENA.entityId, name: ELENA.name },
    object: { entityId: JACK.entityId, name: JACK.name },
    value: { what: "When will Type II be ready?", answered: false },
    statement: "Elena asked when Type II will be ready.",
  });

  const reply = {
    model: "fake-extract-1",
    json: {
      facts: [
        {
          type: "commitment",
          predicate: "committed_to",
          subjectEntityId: JACK.entityId,
          objectEntityId: ELENA.entityId,
          statement: "Jack will send Elena the SOC 2 Type II report by September 30.",
          quote: "I will send you our SOC 2 Type II report by September 30.",
          value: { what: "SOC 2 Type II report", dueAt: "2026-09-30", status: "open" },
          confidence: 0.9,
        },
        {
          // Quote with the line break normalized away: found by whitespace-insensitive search.
          type: "commitment",
          predicate: "committed_to",
          subjectEntityId: DANA.entityId,
          objectEntityId: ELENA.entityId,
          statement: "Dana will send the subprocessor list by September 4.",
          quote: "Dana will send the subprocessor list by September 4.",
          value: { what: "subprocessor list", dueAt: "2026-09-04" },
          confidence: 0.8,
        },
        {
          // Paraphrased quote: kept, penalized, no span.
          type: "ask",
          predicate: "answered",
          subjectEntityId: ELENA.entityId,
          objectEntityId: JACK.entityId,
          statement: "Elena's question about Type II timing was answered.",
          quote: "Type II will arrive on September 30",
          value: { what: "When will Type II be ready?", answered: true },
          supersedes: known.id,
          confidence: 0.8,
        },
        {
          // Invented subject id: dropped.
          type: "decision",
          predicate: "decided",
          subjectEntityId: "e-nobody",
          statement: "Someone decided something.",
          quote: "Elena, Marcus,",
          value: { what: "?" },
          confidence: 0.9,
        },
        {
          // Unknown supersedes target: fact kept, supersedes dropped.
          type: "objection",
          predicate: "objected",
          subjectEntityId: JACK.entityId,
          statement: "Jack has a concern.",
          quote: "Elena, Marcus,",
          value: { what: "concern", severity: "extreme" },
          supersedes: "f-unknown",
          confidence: 1.4,
        },
      ],
    },
  };

  it("validates entity ids, finds spans, penalizes unlocated quotes and passes supersedes through", async () => {
    const { store, models, ev, ctx } = setup([reply], { extract: ROUTE });
    ctx.knownFacts = [known];
    const extractor = createModelExtractor({ store, models });
    expect(extractor.applies?.(ev)).toBe(true);
    const facts = await extractor.extract(ev, ctx);

    expect(models.calls).toHaveLength(1);
    const { tier, req } = models.calls[0]!;
    expect(tier).toBe("extract");
    expect(req).toMatchObject({ maxTokens: 2000, cacheKey: "extract/extract/v1" });
    expect(req.messages[0]!.content).toContain(`- ${JACK.entityId} | Jack Collins <jack@yagni.example> | from, self`);
    expect(req.messages[0]!.content).toContain(`[${known.id}] ask answered=false`);

    expect(facts.map((f) => f.type)).toEqual(["commitment", "commitment", "ask", "objection"]);
    const [jack, dana, ask, objection] = facts as [NewFact, NewFact, NewFact, NewFact];

    expect(jack.origin).toEqual({ kind: "model", by: "extract", model: "fake-extract-1", version: "1" });
    expect(jack.subject).toEqual({ entityId: JACK.entityId, name: JACK.name });
    expect(jack.object?.entityId).toBe(ELENA.entityId);
    expect(jack.validFrom).toBe(ev.occurredAt);
    expect(jack.confidence).toBe(0.9);
    expect(jack.value as CommitmentValue).toMatchObject({ what: "SOC 2 Type II report", dueAt: "2026-09-30", status: "open" });
    const jp = jack.provenance[0]!;
    expect(TEXT.slice(jp.span!.start, jp.span!.end)).toBe("I will send you our SOC 2 Type II report by September 30.");
    expect(jp.speaker?.entityId).toBe(JACK.entityId);

    const dp = dana.provenance[0]!;
    expect(TEXT.slice(dp.span!.start, dp.span!.end)).toBe("Dana will send the subprocessor list\nby September 4.");
    expect(dp.quote).toBe("Dana will send the subprocessor list\nby September 4.");
    expect(dana.confidence).toBe(0.8);
    expect((dana.value as CommitmentValue).status).toBe("open");

    expect(ask.supersedes).toBe(known.id);
    expect(ask.confidence).toBeCloseTo(0.56, 5);
    const ap = ask.provenance.find((p) => p.eventId === ev.id)!;
    expect(ap.span).toBeUndefined();
    expect(ap.quote).toBe("Type II will arrive on September 30");
    expect(ask.value as AskValue).toMatchObject({ answered: true, answeredBy: ev.id });

    expect(objection.supersedes).toBeUndefined();
    expect(objection.confidence).toBe(1);
    expect((objection.value as { severity?: string }).severity).toBeUndefined();
  });

  it("degrades to [] when the extract tier has no route", async () => {
    const { store, models, ev, ctx } = setup([new RouterError("NO_ROUTE", "extract", "no route")], { extract: ROUTE });
    expect(await createModelExtractor({ store, models }).extract(ev, ctx)).toEqual([]);
  });

  it("does not apply without an extract route", () => {
    const { store, models, ev } = setup([], { triage: ROUTE });
    expect(createModelExtractor({ store, models }).applies?.(ev)).toBe(false);
  });

  it("skips events triage did not flag, without a model call", async () => {
    const { store, models, ev, ctx } = setup([], ROUTES);
    await store.kvSet(KV_NAMESPACE, triageKey(ev.id), {
      relevant: false,
      has: { commitment: false, ask: false, decision: false, objection: false, signal: false },
      summary: "",
    });
    expect(await createModelExtractor({ store, models }).extract(ev, ctx)).toEqual([]);
    expect(models.calls).toHaveLength(0);
  });

  it("without triage, gates on whether rules would find anything", () => {
    const { store, models } = setup([], { extract: ROUTE });
    const extractor = createModelExtractor({ store, models });
    expect(extractor.applies?.(message(MARCUS, [JACK], "Thanks, talk soon."))).toBe(false);
    expect(extractor.applies?.(message(MARCUS, [JACK], "Can you send the deck?"))).toBe(true);
  });

  it("includes thread context oldest first", () => {
    const first = message(ELENA, [JACK], "First message.", { at: "2026-08-01T00:00:00.000Z" });
    const second = message(MARCUS, [JACK], "Second message.", { at: "2026-08-02T00:00:00.000Z" });
    const ev = message(JACK, [ELENA], "Reply.");
    const prompt = buildExtractPrompt(ev, context(ev, { thread: [first, second] }));
    expect(prompt.indexOf("First message.")).toBeLessThan(prompt.indexOf("Second message."));
    expect(prompt.indexOf("Second message.")).toBeLessThan(prompt.indexOf("## The message"));
  });
});

describe("findSpan", () => {
  it("finds exact, whitespace-normalized and curly-quote variants", () => {
    const text = "We’re  going with\nOption A.";
    expect(findSpan(text, "going with")).toEqual({ start: 7, end: 17 });
    const s = findSpan(text, "We're going with Option A.")!;
    expect(text.slice(s.start, s.end)).toBe(text);
    expect(findSpan(text, "Option B")).toBeUndefined();
  });
});

describe("dedupeFacts", () => {
  it("drops a rule fact a model fact covers, and keeps one superseder per fact", async () => {
    const ev = message(JACK, [ELENA, MARCUS], TEXT, { cc: [DANA] });
    const ask = stored({
      type: "ask",
      subject: { entityId: ELENA.entityId },
      object: { entityId: JACK.entityId },
      value: { what: "Type II?", answered: false, askedOf: { entityId: JACK.entityId } },
      validFrom: "2026-08-01T00:00:00.000Z",
    });
    const rules = await createRuleExtractor().extract(ev, context(ev, { knownFacts: [ask] }));
    const ruleCommitments = rules.filter((f) => f.type === "commitment");
    expect(ruleCommitments).toHaveLength(2);
    expect(rules.some((f) => f.supersedes === ask.id)).toBe(true);

    const jackSpan = ruleCommitments.find((f) => f.subject.entityId === JACK.entityId)!.provenance[0]!.span!;
    const model: NewFact[] = [
      {
        ...ruleCommitments[0]!,
        origin: { kind: "model", by: "extract", model: "m", version: "1" },
        provenance: [{ eventId: ev.id, span: { start: jackSpan.start + 2, end: jackSpan.end } }],
        confidence: 0.9,
      },
      { ...rules.find((f) => f.supersedes === ask.id)!, origin: { kind: "model", by: "extract", model: "m", version: "1" } },
    ];
    const out = dedupeFacts([...rules, ...model], ev.id);
    const commitments = out.filter((f) => f.type === "commitment");
    expect(commitments.map((f) => [f.subject.entityId, f.origin.kind])).toEqual([
      [DANA.entityId, "rule"],
      [JACK.entityId, "model"],
    ]);
    const superseders = out.filter((f) => f.supersedes === ask.id);
    expect(superseders.map((f) => f.origin.kind)).toEqual(["model"]);
  });
});
