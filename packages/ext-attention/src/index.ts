import type { ExtensionAPI, ExtensionManifest } from "@yrm/core";
import { briefRanker } from "./brief.ts";
import { explainCommand, LAST_QUEUE_KEY, type StoredQueue } from "./explain.ts";
import { mergeRanker, ruleRanker, RULES } from "./rules.ts";
import { readSettings } from "./settings.ts";

export { BRIEF_NAMESPACE, BRIEF_SCHEMA, briefKey, briefRanker, buildBriefRequest, type StoredBrief } from "./brief.ts";
export { explainCommand, explainItem, LAST_QUEUE_KEY, type StoredQueue } from "./explain.ts";
export { formatBrief, queueToMarkdown, scoreBar, type BriefOptions } from "./format.ts";
export {
  brokenCommitment,
  dueSoon,
  goneQuiet,
  jobChange,
  meetingPrep,
  mergeItems,
  mergeRanker,
  openObjection,
  overdueCommitment,
  ruleRanker,
  RULES,
  runRules,
  unansweredAsk,
  type Rule,
} from "./rules.ts";
export { DEFAULT_SETTINGS, readSettings, type AttentionSettings } from "./settings.ts";
export { daysBetween, endOfDay, localDate, Snapshot } from "./snapshot.ts";

export const manifest: ExtensionManifest = {
  name: "attention",
  version: "0.1.0",
  description: "Attention queue: rule rankers over facts, an optional model brief, and `attention:explain`.",
};

/**
 * Registers, in order: the eight rule rankers (minus any in `disable`), the
 * merge ranker, then the model brief. Order matters: merge dedupes and sorts
 * what the rules produced, and the brief re-scores the top of that list.
 */
export default function attention(yrm: ExtensionAPI): void {
  const settings = readSettings(yrm.config.get<Record<string, unknown>>());
  for (const [name, rule] of RULES) {
    if (!settings.disable.includes(name)) yrm.registerRanker(ruleRanker(name, rule, settings));
  }
  yrm.registerRanker(mergeRanker);
  yrm.registerRanker(briefRanker(settings));
  yrm.registerCommand(explainCommand(settings));

  // Keep the final queue (every extension's items) so `attention:explain` can answer for any key.
  yrm.on("queue:after_rank", async (ctx, items) => {
    await ctx.store.kvSet<StoredQueue>("attention", LAST_QUEUE_KEY, { at: new Date().toISOString(), items });
    return undefined;
  });
}
