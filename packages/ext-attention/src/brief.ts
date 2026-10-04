import type { CompletionRequest, JsonSchema, QueueItem, RankContext, Ranker } from "@yrm/core";
import type { AttentionSettings } from "./settings.ts";

/**
 * The one model call a day. It sees the top items and the statements of the
 * facts behind them, never event text (ADR 0007: the expensive model sees
 * facts, not corpora). It may re-score and re-word what it is given; it cannot
 * add items, and keys it invents are ignored.
 */

export const BRIEF_NAMESPACE = "attention";
export const briefKey = (today: string): string => `brief:${today}`;

export interface StoredBrief {
  headline: string;
  at: string;
}

interface BriefResponse {
  items: Array<{ key: string; score: number; reason: string }>;
  headline: string;
}

export const BRIEF_SCHEMA: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["items", "headline"],
  properties: {
    items: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["key", "score", "reason"],
        properties: {
          key: { type: "string" },
          score: { type: "number", minimum: 0, maximum: 1 },
          reason: { type: "string" },
        },
      },
    },
    headline: { type: "string" },
  },
};

const SYSTEM = [
  "You order a salesperson's attention queue for today.",
  "You are given candidate items produced by rules, each with the facts it rests on. You do not see any messages.",
  "Re-score every item from 0 to 1 by what matters most today: unanswered questions from decision makers and promises the user has broken come first.",
  "Rewrite each reason as one specific sentence a person can verify against the cited fact: name who, what, and the date.",
  "Do not invent facts, people or dates that are not in the input. Return only the keys you were given.",
  "Also write a one-sentence headline for the day.",
].join(" ");

function parse(json: unknown): BriefResponse | undefined {
  if (typeof json !== "object" || json === null) return undefined;
  const r = json as Record<string, unknown>;
  if (!Array.isArray(r.items) || typeof r.headline !== "string") return undefined;
  const items = r.items.flatMap((x: unknown) => {
    if (typeof x !== "object" || x === null) return [];
    const i = x as Record<string, unknown>;
    if (typeof i.key !== "string" || typeof i.score !== "number" || !Number.isFinite(i.score) || typeof i.reason !== "string") return [];
    return [{ key: i.key, score: i.score, reason: i.reason }];
  });
  return { items, headline: r.headline };
}

/** Build the request. Exported so tests can assert exactly what leaves the machine. */
export async function buildBriefRequest(ctx: RankContext, top: QueueItem[], settings: AttentionSettings): Promise<CompletionRequest> {
  const payload = [];
  for (const it of top) {
    const facts = [];
    for (const id of it.evidence.factIds.slice(0, 6)) {
      const f = await ctx.store.getFact(id);
      // Statement and dates only: provenance quotes are verbatim event text.
      if (f) facts.push({ id: f.id, type: f.type, statement: f.statement, validFrom: f.validFrom.slice(0, 10) });
    }
    payload.push({
      key: it.key,
      score: it.score,
      action: it.action,
      reason: it.reason,
      about: it.about.map((a) => a.name ?? a.entityId),
      ...(it.dueAt ? { dueAt: it.dueAt } : {}),
      facts,
    });
  }
  const req: CompletionRequest = {
    system: SYSTEM,
    messages: [{ role: "user", content: JSON.stringify({ today: ctx.today, items: payload }, null, 2) }],
    schema: BRIEF_SCHEMA,
    temperature: 0,
    meta: { extension: "attention", ranker: "attention/brief", tenant: ctx.tenantId, today: ctx.today },
  };
  if (settings.briefMaxCostUsd !== undefined) req.maxCostUsd = settings.briefMaxCostUsd;
  return req;
}

export function briefRanker(settings: AttentionSettings): Ranker {
  return {
    name: "attention/brief",
    async rank(ctx, candidates) {
      if (!settings.brief || candidates.length === 0) return candidates;
      if (ctx.models.describe("synthesize").length === 0) return candidates;

      const sorted = [...candidates].sort((a, b) => b.score - a.score);
      const top = sorted.slice(0, settings.briefTopN);
      let parsed: BriefResponse | undefined;
      try {
        const res = await ctx.models.complete("synthesize", await buildBriefRequest(ctx, top, settings));
        parsed = parse(res.json);
        if (!parsed) ctx.log.info("brief: model returned no usable JSON; keeping rule order");
      } catch (err) {
        ctx.log.info("brief: model call failed; keeping rule order", { error: err instanceof Error ? err.message : String(err) });
      }
      if (!parsed) return candidates;

      const allowed = new Set(top.map((t) => t.key));
      const updates = new Map(parsed.items.filter((u) => allowed.has(u.key)).map((u) => [u.key, u]));
      const out = sorted.map((it) => {
        const u = updates.get(it.key);
        if (!u) return it;
        const reason = u.reason.trim();
        return { ...it, score: Math.min(1, Math.max(0, u.score)), reason: reason.length > 0 ? reason : it.reason };
      });
      const headline = parsed.headline.trim();
      if (headline) await ctx.store.kvSet<StoredBrief>(BRIEF_NAMESPACE, briefKey(ctx.today), { headline, at: new Date().toISOString() });
      return out.sort((a, b) => b.score - a.score);
    },
  };
}
