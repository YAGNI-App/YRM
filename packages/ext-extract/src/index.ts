import type { ExtensionAPI, ExtensionManifest } from "@yrm/core";
import { dedupeFacts } from "./dedupe.ts";
import { evalCommand } from "./eval.ts";
import { createModelExtractor, createTriageExtractor } from "./model.ts";
import { createRuleExtractor } from "./rules.ts";

export const manifest: ExtensionManifest = {
  name: "extract",
  version: "0.1.0",
  description: "Commitments, asks, decisions, objections and roles from events: rules always, models when routed.",
};

/**
 * Registration order is execution order: rules (free), then triage (writes
 * its verdict to kv), then the model extractor (reads that verdict).
 */
export default function extract(yrm: ExtensionAPI): void {
  const warned = new Set<string>();
  yrm.on("host:start", async () => {
    warned.clear();
  });
  yrm.registerExtractor(createRuleExtractor(yrm.store));
  yrm.registerExtractor(createTriageExtractor({ store: yrm.store, models: yrm.models, warned }));
  yrm.registerExtractor(createModelExtractor({ store: yrm.store, models: yrm.models, warned }));
  yrm.on("extract:after", async (_ctx, event, facts) => dedupeFacts(facts, event.id));
  yrm.registerCommand(evalCommand());
}

export { findDue, referenceDay, resolveDue, type DueMatch } from "./dates.ts";
export { dedupeFacts } from "./dedupe.ts";
export {
  evalCommand,
  formatScorecard,
  jaccard,
  scoreFacts,
  type GroundTruth,
  type GroundTruthFact,
  type Scorecard,
  type ScoreOptions,
  type TypeScore,
} from "./eval.ts";
export {
  buildExtractPrompt,
  createModelExtractor,
  createTriageExtractor,
  findSpan,
  KV_NAMESPACE,
  MODEL_EXTRACTOR,
  MODEL_VERSION,
  parseTriage,
  TRIAGE_EXTRACTOR,
  TRIAGE_VERSION,
  triageKey,
  validateModelFacts,
  type TriageResult,
  type WarnedTiers,
} from "./model.ts";
export * from "./prompts.ts";
export {
  classifySentence,
  closures,
  createRuleExtractor,
  hasRuleCandidates,
  isAsk,
  RULE_EXTRACTOR,
  RULE_VERSION,
  sentenceFacts,
  type RuleKind,
} from "./rules.ts";
export { splitSentences, type Sentence } from "./sentences.ts";
