import { todayIn } from "@yrm/core";
import type { Command, CommandContext, Fact, QueueItem, Store } from "@yrm/core";
import { runRules } from "./rules.ts";
import type { AttentionSettings } from "./settings.ts";
import { localDate, Snapshot } from "./snapshot.ts";

/** Where the `queue:after_rank` hook keeps the last ranked queue, so explain can see every ranker's items. */
export const LAST_QUEUE_KEY = "queue:last";

export interface StoredQueue {
  at: string;
  items: QueueItem[];
}

async function findItem(ctx: CommandContext, key: string, settings: AttentionSettings): Promise<QueueItem | undefined> {
  const last = await ctx.store.kvGet<StoredQueue>("attention", LAST_QUEUE_KEY);
  const hit = last?.items.find((i) => i.key === key);
  if (hit) return hit;
  // Not in the last ranked queue: recompute this extension's rules for the requested day.
  const today = typeof ctx.flags.today === "string" ? ctx.flags.today : todayIn(settings.timezone);
  const snap = new Snapshot({ tenantId: ctx.tenantId, store: ctx.store, models: ctx.models, today, log: ctx.log }, settings);
  return (await runRules(snap)).find((i) => i.key === key);
}

/** Render one item and the facts and events behind it, with provenance. */
export async function explainItem(store: Store, it: QueueItem, timezone = "UTC"): Promise<string[]> {
  const day = (iso: string): string => localDate(iso, timezone);
  const out: string[] = [];
  out.push(`${it.key}  (score ${it.score.toFixed(2)}, by ${it.by})`);
  out.push(`Action: ${it.action}`);
  out.push(`Reason: ${it.reason}`);
  if (it.about.length > 0) out.push(`About:  ${it.about.map((a) => `${a.name ?? a.entityId} [${a.entityId}]`).join(", ")}`);
  if (it.dueAt) out.push(`Due:    ${it.dueAt}`);
  out.push("");
  out.push(`Evidence: ${it.evidence.factIds.length} fact(s), ${it.evidence.eventIds.length} event(s)`);

  const covered = new Set<string>();
  for (const id of it.evidence.factIds) {
    const f: Fact | null = await store.getFact(id);
    if (!f) {
      out.push(`  fact ${id} (not found)`);
      continue;
    }
    const origin = [f.origin.kind, f.origin.by, f.origin.model, f.origin.version && `v${f.origin.version}`].filter(Boolean).join(" ");
    out.push(`  fact ${f.id} [${f.type}/${f.predicate}, ${origin}, confidence ${f.confidence}]`);
    out.push(`    ${f.statement}`);
    out.push(
      `    valid ${f.validFrom.slice(0, 10)}${f.validTo ? `..${f.validTo.slice(0, 10)}` : ""}, recorded ${f.recordedAt.slice(0, 10)}` +
        (f.knownAt && f.knownAt.slice(0, 10) !== f.recordedAt.slice(0, 10) ? `, known ${f.knownAt.slice(0, 10)}` : "") +
        (f.supersedes ? `, supersedes ${f.supersedes}` : ""),
    );
    for (const p of f.provenance) {
      covered.add(p.eventId);
      const e = await store.getEvent(p.eventId);
      const where = e ? `${day(e.occurredAt)} ${e.source}/${e.kind} '${e.content.title ?? "(untitled)"}'` : "(event not found)";
      out.push(`    - event ${p.eventId}: ${where}`);
      if (p.speaker) out.push(`      speaker: ${p.speaker.name ?? p.speaker.entityId}`);
      if (p.quote) out.push(`      "${p.quote}"`);
    }
  }
  for (const id of it.evidence.eventIds) {
    if (covered.has(id)) continue;
    const e = await store.getEvent(id);
    out.push(`  event ${id}: ${e ? `${day(e.occurredAt)} ${e.source}/${e.kind} '${e.content.title ?? "(untitled)"}'` : "(not found)"}`);
  }
  return out;
}

export function explainCommand(settings: AttentionSettings): Command {
  return {
    name: "attention:explain",
    description: "Show why an attention item is in the queue: its facts, quotes and source events.",
    usage: "attention:explain <key> [--today YYYY-MM-DD]",
    async run(ctx) {
      const key = ctx.args[0];
      if (!key) {
        ctx.stderr("usage: yrm attention:explain <key> [--today YYYY-MM-DD]");
        return 2;
      }
      const it = await findItem(ctx, key, settings);
      if (!it) {
        ctx.stderr(`no attention item with key "${key}"; run \`yrm today\` to see current keys`);
        return 1;
      }
      for (const line of await explainItem(ctx.store, it, settings.timezone)) ctx.stdout(line);
      return 0;
    },
  };
}
