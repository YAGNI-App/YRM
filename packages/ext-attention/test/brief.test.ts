import { describe, expect, it } from "bun:test";
import type { AskValue, CommitmentValue, CompletionRequest, LogRecord } from "@yrm/core";
import { createLogger } from "@yrm/core";
import { BRIEF_NAMESPACE, briefKey, type StoredBrief } from "../src/index.ts";
import { harness, ref, TODAY } from "./helpers.ts";

const SYNTH = { synthesize: [{ provider: "fake", model: "fake-synth" }] };
const SECRET_TEXT = "PRIVATE-BODY-7731 the CFO meeting is on the 10th";
const SECRET_QUOTE = "will you let us exit the pilot order with no fee";

async function seeded(opts: Parameters<typeof harness>[0]) {
  const h = await harness(opts);
  const marcus = await h.person("Marcus Bell", "marcus@acme.example");
  const elena = await h.person("Elena Vasquez", "elena@acme.example");
  const ev = await h.event({ at: "2026-09-02T17:48:00Z", title: "Re: Security review follow-ups", text: SECRET_TEXT, from: marcus, to: [h.me] });
  const ask = await h.fact<AskValue>({
    type: "ask",
    subject: ref(marcus),
    object: ref(h.me),
    statement: "Marcus asked whether Acme can exit with no fee if Type II slips.",
    value: { what: "Exit with no fee?", answered: false },
    validFrom: "2026-09-02T17:48:00Z",
    provenance: [{ eventId: ev, quote: SECRET_QUOTE }],
  });
  const commit = await h.fact<CommitmentValue>({
    type: "commitment",
    subject: ref(h.me),
    object: ref(elena),
    statement: "Jack will send the Type II report by September 30.",
    value: { what: "Send Type II report", status: "open", dueAt: "2026-09-30" },
    validFrom: "2026-08-27T10:00:00Z",
  });
  return { h, askKey: `unanswered-ask:${ask.id}`, commitKey: `overdue-commitment:${commit.id}` };
}

describe("attention/brief", () => {
  it("re-orders and rewrites reasons, ignores unknown keys, adds nothing, stores the headline", async () => {
    let captured: CompletionRequest | undefined;
    const { h, askKey, commitKey } = await seeded({
      routes: SYNTH,
      responses: [
        (_tier, req) => {
          captured = req;
          return {
            json: {
              headline: "Answer Marcus before anything else.",
              items: [
                { key: commitKey, score: 0.3, reason: "You told Elena on 2026-08-27 the Type II report would arrive by 2026-09-30." },
                { key: askKey, score: 0.99, reason: "Marcus asked on 2026-09-02 for a yes or no on a no-fee exit." },
                { key: "invented:1", score: 1, reason: "Made up." },
              ],
            },
          };
        },
      ],
    });
    const items = await h.rank();
    expect(h.router.calls).toHaveLength(1);
    expect(h.router.calls[0]!.tier).toBe("synthesize");
    expect(items.map((i) => i.key)).toEqual([askKey, commitKey]);
    expect(items[0]!.score).toBe(0.99);
    expect(items[0]!.reason).toBe("Marcus asked on 2026-09-02 for a yes or no on a no-fee exit.");
    expect(items[1]!.reason).toStartWith("You told Elena");
    expect(items.some((i) => i.key === "invented:1")).toBe(false);
    // Rule-owned fields are untouched.
    expect(items[0]!.action).toBe("Reply to Marcus Bell about: Exit with no fee?");

    const stored = await h.store.kvGet<StoredBrief>(BRIEF_NAMESPACE, briefKey(TODAY));
    expect(stored?.headline).toBe("Answer Marcus before anything else.");

    // ADR 0007: fact statements go out, event text and verbatim quotes do not.
    const wire = JSON.stringify(captured);
    expect(wire).toContain("Marcus asked whether Acme can exit with no fee if Type II slips.");
    expect(wire).not.toContain("PRIVATE-BODY-7731");
    expect(wire).not.toContain(SECRET_QUOTE);
    expect(captured!.schema).toBeDefined();
  });

  it("keeps rule order when the router fails, logging at info", async () => {
    const records: LogRecord[] = [];
    const log = createLogger("debug", (r) => records.push(r));
    const { h, askKey, commitKey } = await seeded({ routes: SYNTH, responses: [new Error("upstream 529")], log });
    const items = await h.rank();
    expect(items.map((i) => [i.key, i.score])).toEqual([[commitKey, 0.95], [askKey, 0.9]]);
    expect(records.some((r) => r.level === "info" && r.msg.includes("brief: model call failed"))).toBe(true);
    expect(await h.store.kvGet(BRIEF_NAMESPACE, briefKey(TODAY))).toBeNull();
  });

  it("does not call a model without a synthesize route or when brief is false", async () => {
    const none = await seeded({});
    await none.h.rank();
    expect(none.h.router.calls).toHaveLength(0);
    const off = await seeded({ routes: SYNTH, settings: { brief: false } });
    await off.h.rank();
    expect(off.h.router.calls).toHaveLength(0);
  });

  it("only sends the top N items", async () => {
    let sent = 0;
    const { h } = await seeded({
      routes: SYNTH,
      settings: { briefTopN: 1 },
      responses: [
        (_t, req) => {
          sent = (JSON.parse(req.messages[0]!.content) as { items: unknown[] }).items.length;
          return { json: { headline: "", items: [] } };
        },
      ],
    });
    expect((await h.rank()).length).toBe(2);
    expect(sent).toBe(1);
  });
});
