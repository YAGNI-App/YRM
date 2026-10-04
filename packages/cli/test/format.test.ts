import { describe, expect, test } from "bun:test";
import type { Fact, QueueItem } from "@yrm/core";
import { formatFacts, parseInstant } from "../src/commands/facts.ts";
import { formatBrief } from "../src/commands/today.ts";
import { createStyle, scoreBar, table, visibleWidth } from "../src/format.ts";

const items: QueueItem[] = [
  {
    key: "ask:f14",
    action: "Answer Marcus: can Acme exit with no fee if Type II slips?",
    reason: "Marcus asked a yes/no question on 2026-09-02 and has not had an answer.",
    score: 0.92,
    about: [{ entityId: "e-marcus", name: "Marcus Bell" }, { entityId: "e-acme" }],
    evidence: { factIds: ["f14"], eventIds: ["ev1", "ev2"] },
    by: "attention",
  },
  {
    key: "commitment:f08",
    action: "Send Elena the Type II report (or the bridge letter)",
    reason: "You promised it by 2026-09-30.",
    score: 0.8,
    about: [{ entityId: "e-elena", name: "Elena Vasquez" }],
    evidence: { factIds: ["f08"], eventIds: ["ev3"] },
    dueAt: "2026-09-30T00:00:00.000Z",
    by: "attention",
  },
];

describe("formatBrief", () => {
  test("renders header, numbered items, score bar, about, due and evidence", () => {
    const lines = formatBrief(items, { date: "2026-10-03", tenantName: "Jack" });
    expect(lines.join("\n")).toBe(
      [
        "Today, 2026-10-03 for Jack  (2 items)",
        "",
        "1. █████████░ 0.92  Answer Marcus: can Acme exit with no fee if Type II slips?",
        "   Marcus asked a yes/no question on 2026-09-02 and has not had an answer.",
        "   about: Marcus Bell, e-acme",
        "   (facts: 1, events: 2)",
        "",
        "2. ████████░░ 0.80  Send Elena the Type II report (or the bridge letter)",
        "   You promised it by 2026-09-30.",
        "   about: Elena Vasquez  ·  due: 2026-09-30",
        "   (facts: 1, events: 1)",
        "",
      ].join("\n"),
    );
  });

  test("empty queue", () => {
    expect(formatBrief([], { date: "2026-10-03" })).toEqual(["Today, 2026-10-03  (0 items)", "", "Nothing needs you today."]);
  });

  test("color adds ANSI without changing visible text", () => {
    const plain = formatBrief(items, { date: "2026-10-03" });
    const colored = formatBrief(items, { date: "2026-10-03", style: createStyle(true) });
    expect(colored.join("\n")).toContain("\u001b[");
    expect(colored.map((l) => l.replace(/\u001b\[[0-9;]*m/g, ""))).toEqual(plain);
  });
});

function fact(over: Partial<Fact>): Fact {
  return {
    id: "f1",
    tenantId: "local",
    type: "attribute",
    subject: { entityId: "e-priya", name: "Priya Raman" },
    predicate: "works_at",
    value: { org: "Acme" },
    statement: "Priya works at Acme Robotics",
    validFrom: "2026-06-01T00:00:00.000Z",
    recordedAt: "2026-06-02T15:04:00.000Z",
    provenance: [{ eventId: "ev-intro" }],
    confidence: 0.9,
    origin: { kind: "rule", by: "ext-extract", version: "1" },
    ...over,
  };
}

describe("formatFacts", () => {
  test("shows valid range, recorded time, retraction, confidence, origin and evidence", () => {
    const lines = formatFacts([
      fact({ id: "f2", statement: "Priya works at Northwind", validFrom: "2026-08-14T00:00:00.000Z", recordedAt: "2026-09-03T09:12:00.000Z", origin: { kind: "model", by: "ext-extract", version: "2", model: "qwen3:8b" }, confidence: 0.8, provenance: [{ eventId: "ev-quarantined" }, { eventId: "ev-sam" }] }),
      fact({ validTo: "2026-08-14T00:00:00.000Z", retractedAt: "2026-09-03T09:12:00.000Z" }),
    ]);
    expect(lines[0]).toMatch(/^statement\s+type\/predicate\s+valid\s+recorded\s+conf\s+origin\s+evidence$/);
    const [old, current] = [lines[2]!, lines[3]!];
    expect(old).toContain("x Priya works at Acme Robotics");
    expect(old).toContain("2026-06-01..2026-08-14");
    expect(old).toContain("2026-06-02 15:04 (retracted 2026-09-03 09:12)");
    expect(old).toContain("rule:ext-extract@1");
    expect(old).toContain("← ev-intro");
    expect(current).toContain("2026-08-14..");
    expect(current).toContain("0.80");
    expect(current).toContain("model:ext-extract@2 (qwen3:8b)");
    expect(current).toContain("← ev-quarantined, ev-sam");
    // Columns line up.
    expect(old.indexOf("[attribute/works_at]")).toBe(current.indexOf("[attribute/works_at]"));
  });

  test("no facts", () => {
    expect(formatFacts([])).toEqual(["(no facts)"]);
  });

  test("parseInstant treats a bare date as the end of that day", () => {
    expect(parseInstant("2026-06-03", "--as-of")).toBe("2026-06-03T23:59:59.999Z");
    expect(parseInstant("2026-06-03T10:00:00Z", "--at")).toBe("2026-06-03T10:00:00.000Z");
    expect(() => parseInstant("June 3rd", "--at")).toThrow(/--at/);
  });
});

describe("format helpers", () => {
  test("scoreBar clamps", () => {
    expect(scoreBar(0)).toBe("░░░░░░░░░░");
    expect(scoreBar(1.7)).toBe("██████████");
    expect(scoreBar(0.45, 4)).toBe("██░░");
  });

  test("table aligns by visible width", () => {
    const s = createStyle(true);
    const lines = table([[s.bold("a"), "1"], ["bbb", "22"]], { align: ["left", "right"] });
    expect(lines.map(visibleWidth)).toEqual([7, 7]);
  });
});
