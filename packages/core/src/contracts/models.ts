/**
 * Model access is routed by tier, never by model name. Extensions ask for a
 * tier ("triage", "extract", "synthesize", "embed"); the router picks a
 * provider and model from the tenant's config and falls through the chain on
 * failure. Providers are extensions. Core ships an Anthropic adapter and an
 * OpenAI-compatible adapter; the second one covers vLLM, Ollama, llama.cpp,
 * Together, Fireworks, Groq, DeepSeek and OpenRouter without naming any of them.
 */

export type Tier = "triage" | "extract" | "synthesize" | "embed" | (string & {});

export type Role = "system" | "user" | "assistant";

export interface Message {
  role: Role;
  content: string;
}

/** JSON Schema object. Kept loose on purpose. */
export type JsonSchema = Record<string, unknown>;

export interface CompletionRequest {
  system?: string;
  messages: Message[];
  /** When set, the provider must return `json` matching this schema. */
  schema?: JsonSchema;
  maxTokens?: number;
  temperature?: number;
  /** Stable prefix hint for providers that support prompt caching. */
  cacheKey?: string;
  /** Hard ceiling on spend for this call, in USD. Router rejects routes that would exceed it. */
  maxCostUsd?: number;
  /** Free-form metadata for logging: extension name, event id, tenant. */
  meta?: Record<string, unknown>;
}

export interface Usage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  /** Computed by the router from the route's price table. */
  costUsd?: number;
}

export interface CompletionResponse<T = unknown> {
  text: string;
  /** Parsed structured output when `schema` was supplied. */
  json?: T;
  usage: Usage;
  provider: string;
  model: string;
  /** Wall time in ms. */
  latencyMs: number;
  stopReason?: string;
}

export interface EmbeddingRequest {
  inputs: string[];
  meta?: Record<string, unknown>;
}

export interface EmbeddingResponse {
  vectors: number[][];
  dimensions: number;
  usage: Usage;
  provider: string;
  model: string;
}

export interface ModelInfo {
  id: string;
  contextWindow?: number;
  maxOutput?: number;
  /** USD per million tokens. */
  pricing?: { input: number; output: number; cacheRead?: number };
  supports: {
    structuredOutput: boolean;
    embeddings: boolean;
    /** Runs on hardware the tenant controls. Used by the "local only" policy. */
    local?: boolean;
  };
}

export interface ModelProvider {
  /** Unique name, e.g. "anthropic", "openai-compatible". */
  name: string;
  /** Known models; may be empty for custom endpoints. */
  models(): Promise<ModelInfo[]>;
  complete(model: string, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse>;
  embed?(model: string, req: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse>;
}

/** One hop in a tier's fallback chain. */
export interface Route {
  provider: string;
  model: string;
  /** Overrides for this hop. */
  maxTokens?: number;
  temperature?: number;
  /** Price override when the provider cannot report it (custom endpoints). */
  pricing?: { input: number; output: number; cacheRead?: number };
}

export interface RoutingPolicy {
  /** Tier name to ordered fallback chain. A tier with no chain is unavailable (NO_ROUTE). */
  routes: Record<string, Route[]>;
  /** Reject any route whose model is not marked local. */
  localOnly?: boolean;
  /** Per-tenant monthly ceiling. Router refuses calls past it. */
  monthlyBudgetUsd?: number;
}

export interface ModelRouter {
  complete<T = unknown>(tier: Tier, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse<T>>;
  embed(tier: Tier, req: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse>;
  /** Resolve what a tier would use right now, for display and dry runs. */
  describe(tier: Tier): Route[];
  /** Running spend for this tenant since the start of the current month. */
  spend(): Promise<{ usd: number; byTier: Record<string, number> }>;
}
