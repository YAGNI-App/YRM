import type { Usage } from "../contracts/models.ts";

/** USD per million tokens. Same shape as `Route.pricing` and `ModelInfo.pricing`. */
export interface ModelPricing {
  input: number;
  output: number;
  cacheRead?: number;
}

/** Cache reads cost a tenth of input unless the table says otherwise. */
const CACHE_READ_RATIO = 0.1;
/** Prompt-cache writes (5 minute TTL) bill at 1.25x input on Anthropic. */
const CACHE_WRITE_RATIO = 1.25;

/**
 * Snapshot of list prices for well-known hosted models, USD per million tokens.
 * Prices change; this table is a convenience default and `route.pricing` in
 * yrm.config.ts always wins. Open-weight models are deliberately absent: what
 * they cost depends on where they run, so custom endpoints must set
 * `route.pricing` (or accept a cost of zero).
 */
export const PRICE_TABLE: Readonly<Record<string, ModelPricing>> = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.4 },
  "claude-opus-5": { input: 5, output: 25, cacheRead: 0.5 },
  "claude-sonnet-5": { input: 2, output: 10, cacheRead: 0.2 },
  "claude-haiku-4-5": { input: 1, output: 5, cacheRead: 0.1 },
};

export function lookupPricing(model: string): ModelPricing | undefined {
  return PRICE_TABLE[model];
}

/** Cost in USD of a call with the given usage. `inputTokens` excludes cached tokens. */
export function estimateCost(usage: Usage, pricing: ModelPricing): number {
  const perToken = (perMillion: number) => perMillion / 1_000_000;
  const cacheRead = pricing.cacheRead ?? pricing.input * CACHE_READ_RATIO;
  const cost =
    usage.inputTokens * perToken(pricing.input) +
    usage.outputTokens * perToken(pricing.output) +
    (usage.cacheReadTokens ?? 0) * perToken(cacheRead) +
    (usage.cacheWriteTokens ?? 0) * perToken(pricing.input * CACHE_WRITE_RATIO);
  return cost;
}

/** Rough token count for budgeting before a call: four characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}
