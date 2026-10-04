import { describe, expect, it } from "bun:test";
import type { CommandContext } from "@yrm/core";
import { formatBrief, queueToMarkdown, scoreBar } from "../src/index.ts";
import { groundTruth, seedAcme } from "./acme-seed.ts";
import { harness } from "./helpers.ts";

const DAY = "2026-10-03";
const KIND_TO_RULE: Record<string, string> = {
  unanswered_ask: "unanswered-ask",
  overdue_commitment: "overdue-commitment",
  gone_quiet: "gone-quiet",
};

async function acme() {
  const h = await harness({
    settings: { ...groundTruth.tenant, timezone: "America/New_York" },
  });
  const seeded = await seedAcme(h);
  h.setClock(`${DAY}T13:00:00Z`);
  return { h, ...seeded };
}

describe("ground truth: fixtures/acme on 2026-10-03", () => {
  it("surfaces every expected item, with the unanswered ask on top", async () => {
    const { h, entities, facts } = await acme();
    const queue = await h.rank(DAY);

    for (const exp of groundTruth.expectedQueueOn[DAY]!) {
      const rule = KIND_TO_RULE[exp.kind]!;
      // gone_quiet is keyed by the organization, the others by the fact.
      const id = rule === "gone-quiet" ? entities.get(exp.about)!.id : facts.get(exp.fact)!.id;
      expect(queue.map((i) => i.key)).toContain(`${rule}:${id}`);
    }
    const top = queue[0]!;
    expect(top.key).toBe(`unanswered-ask:${facts.get("f14")!.id}`);
    expect(top.reason).toBe("Asked 31 days ago in 'Re: Security review follow-ups'; no reply from you since.");

    const quiet = queue.find((i) => i.by === "attention/gone-quiet")!;
    expect(quiet.action).toBe("Re-engage Acme Robotics: quiet for 31 days with 3 open items");
    // Answered asks, fulfilled commitments and an old broken one stay out.
    expect(queue.filter((i) => i.by === "attention/unanswered-ask")).toHaveLength(1);
    expect(queue.filter((i) => i.by === "attention/overdue-commitment")).toHaveLength(1);
    expect(queue.some((i) => i.by === "attention/broken-commitment")).toBe(false);

    console.log(`\n${formatBrief(queue, { today: DAY, tenantName: "YAGNI" })}\n`);
  });

  it("attention:explain shows the facts and source events behind an item", async () => {
    const { h, facts } = await acme();
    const queue = await h.rank(DAY);
    const out: string[] = [];
    const err: string[] = [];
    const ctx = (args: string[], flags: CommandContext["flags"] = {}): CommandContext => ({
      tenantId: "local",
      args,
      flags,
      store: h.store,
      models: h.router,
      stdout: (l) => out.push(l),
      stderr: (l) => err.push(l),
      log: h.host.log,
    });
    const cmd = h.host.registry.commands.get("attention:explain")!;

    expect(await cmd.run(ctx([queue[0]!.key]))).toBe(0);
    const text = out.join("\n");
    expect(text).toContain(groundTruth.facts.find((f) => f.id === "f14")!.statement);
    expect(text).toContain("2026-09-02 mail/message 'Re: Security review follow-ups'");
    expect(text).toContain(`fact ${facts.get("f14")!.id} [ask/asked, rule ground-truth v1`);

    // A key the last queue does not hold is recomputed for --today.
    out.length = 0;
    const objection = `open-objection:${facts.get("f18")!.id}`;
    await h.store.kvDelete("attention", "queue:last");
    expect(await cmd.run(ctx([objection], { today: DAY }))).toBe(0);
    expect(out.join("\n")).toContain("SOC 2 Type I");

    expect(await cmd.run(ctx(["nope:1"]))).toBe(1);
    expect(err.join("\n")).toContain('no attention item with key "nope:1"');
  });
});

describe("formatting", () => {
  const item = {
    key: "unanswered-ask:F1",
    action: "Reply to Marcus Bell about: exit terms",
    reason: "Asked 31 days ago in 'Re: Security review follow-ups'; no reply from you since.",
    score: 1,
    about: [{ entityId: "E1", name: "Marcus Bell" }],
    evidence: { factIds: ["F1"], eventIds: ["V1", "V2"] },
    dueAt: "2026-09-30",
    by: "attention/unanswered-ask",
  };

  it("renders the brief with header, headline, bar and details", () => {
    const { dueAt: _, ...undated } = item;
    const text = formatBrief([item, { ...undated, key: "k2", score: 0.43 }], {
      today: DAY,
      tenantName: "YAGNI",
      headline: "Answer Marcus first.",
      width: 72,
    });
    expect(text).toStartWith("YAGNI: Saturday, October 3, 2026\n2 items need your attention.\n\nAnswer Marcus first.");
    expect(text).toContain("1. ██████████ 1.00");
    expect(text).toContain("2. ████░░░░░░ 0.43");
    expect(text).toContain("   about Marcus Bell · due 2026-09-30 · evidence: 1 fact, 2 events");
    expect(text.split("\n").every((l) => l.length <= 72)).toBe(true);
    expect(text).not.toContain("\x1b[");
    expect(formatBrief([item], { today: DAY, color: true })).toContain("\x1b[1m");
    expect(formatBrief([], { today: DAY })).toContain("Nothing needs your attention today.");
    expect(scoreBar(0.05)).toBe("█░░░░░░░░░");
  });

  it("renders Markdown", () => {
    const md = queueToMarkdown([item]);
    expect(md).toContain("1. **Reply to Marcus Bell about: exit terms**");
    expect(md).toContain("score 1.00 · about Marcus Bell · due 2026-09-30 · evidence: 1 fact, 2 events · `unanswered-ask:F1`");
    expect(queueToMarkdown([])).toBe("_Nothing needs attention._\n");
  });
});
