import Anthropic from "@anthropic-ai/sdk";
import {
  ModelProviderError,
  PRICE_TABLE,
  classifyHttpStatus,
  type CompletionRequest,
  type CompletionResponse,
  type ExtensionAPI,
  type ExtensionManifest,
  type ModelInfo,
  type ModelProvider,
  type Usage,
} from "@yrm/core";

export const PROVIDER_NAME = "anthropic";

export interface AnthropicProviderConfig {
  /** Literal key. Prefer `apiKeyEnv` so keys stay out of config files. */
  apiKey?: string;
  /** Environment variable holding the key. Defaults to ANTHROPIC_API_KEY. */
  apiKeyEnv?: string;
  baseUrl?: string;
  /** SDK-level retries before the router falls through. Defaults to the SDK's own (2). */
  maxRetries?: number;
  timeoutMs?: number;
  /**
   * "adaptive" lets models that support it decide how much to think. Thinking
   * tokens count against maxTokens, so very small budgets may want "omit".
   * Defaults to "adaptive".
   */
  thinking?: "adaptive" | "omit";
}

/** The slice of the SDK client this provider uses; injectable for tests. */
export interface MessagesClient {
  messages: {
    create(
      params: Anthropic.MessageCreateParamsNonStreaming,
      options?: { signal?: AbortSignal | null },
    ): PromiseLike<Anthropic.Message>;
  };
}

export interface AnthropicProviderDeps {
  client?: MessagesClient;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

const DEFAULT_MAX_TOKENS = 4096;

/**
 * Models that reject sampling parameters (temperature/top_p/top_k return 400).
 * Older models in the table still accept them.
 */
const NO_SAMPLING = /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[78])/;
/** Models that accept `thinking: { type: "adaptive" }`. Haiku 4.5 does not. */
const ADAPTIVE_THINKING = /^claude-(fable|mythos|opus-5|sonnet-5|opus-4-[678]|sonnet-4-6)/;

export class AnthropicProvider implements ModelProvider {
  readonly name = PROVIDER_NAME;
  private readonly config: AnthropicProviderConfig;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;
  private client: MessagesClient | undefined;

  constructor(config: AnthropicProviderConfig = {}, deps: AnthropicProviderDeps = {}) {
    this.config = config;
    this.client = deps.client;
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => performance.now());
  }

  async models(): Promise<ModelInfo[]> {
    return Object.entries(PRICE_TABLE)
      .filter(([id]) => id.startsWith("claude-"))
      .map(([id, pricing]) => ({
        id,
        contextWindow: id.startsWith("claude-haiku") ? 200_000 : 1_000_000,
        pricing,
        supports: { structuredOutput: true, embeddings: false, local: false },
      }));
  }

  async complete(model: string, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const client = this.getClient();
    const params = buildMessageParams(model, req, { thinking: this.config.thinking ?? "adaptive" });
    const started = this.now();
    let message: Anthropic.Message;
    try {
      message = await client.messages.create(params, signal ? { signal } : undefined);
    } catch (err) {
      throw mapAnthropicError(err);
    }
    if (message.stop_reason === "refusal") {
      // Another model in the chain may answer, so let the router move on.
      throw new ModelProviderError({
        message: `${model} declined the request`,
        code: "REFUSAL",
        retryable: true,
        provider: PROVIDER_NAME,
      });
    }
    return parseMessage(message, req, Math.round(this.now() - started));
  }

  private getClient(): MessagesClient {
    if (this.client) return this.client;
    const apiKey = this.config.apiKey ?? this.env[this.config.apiKeyEnv ?? "ANTHROPIC_API_KEY"];
    if (!apiKey) {
      // Retryable so a chain with a local fallback still works with no key set.
      throw new ModelProviderError({
        message: `no Anthropic API key: set ${this.config.apiKeyEnv ?? "ANTHROPIC_API_KEY"} or providers.anthropic.apiKey`,
        code: "NOT_CONFIGURED",
        retryable: true,
        provider: PROVIDER_NAME,
      });
    }
    this.client = new Anthropic({
      apiKey,
      ...(this.config.baseUrl !== undefined ? { baseURL: this.config.baseUrl } : {}),
      ...(this.config.maxRetries !== undefined ? { maxRetries: this.config.maxRetries } : {}),
      ...(this.config.timeoutMs !== undefined ? { timeout: this.config.timeoutMs } : {}),
    });
    return this.client;
  }
}

/** Map a YRM completion request onto Messages API parameters. */
export function buildMessageParams(
  model: string,
  req: CompletionRequest,
  opts: { thinking: "adaptive" | "omit" } = { thinking: "adaptive" },
): Anthropic.MessageCreateParamsNonStreaming {
  // The Messages API takes system text separately; hoist any system-role turns.
  const systemParts = [req.system, ...req.messages.filter((m) => m.role === "system").map((m) => m.content)].filter(
    (s): s is string => typeof s === "string" && s.length > 0,
  );
  const messages: Anthropic.MessageParam[] = req.messages
    .filter((m) => m.role !== "system")
    .map((m) => ({ role: m.role === "assistant" ? "assistant" : "user", content: m.content }));

  const params: Anthropic.MessageCreateParamsNonStreaming = {
    model,
    max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    messages,
  };
  if (systemParts.length > 0) {
    const text = systemParts.join("\n\n");
    // A cacheKey means the caller keeps the system prefix stable across calls.
    params.system = req.cacheKey ? [{ type: "text", text, cache_control: { type: "ephemeral" } }] : text;
  }
  if (req.temperature !== undefined && !NO_SAMPLING.test(model)) params.temperature = req.temperature;
  if (opts.thinking === "adaptive" && ADAPTIVE_THINKING.test(model)) params.thinking = { type: "adaptive" };
  if (req.schema) params.output_config = { format: { type: "json_schema", schema: req.schema } };
  return params;
}

export function parseMessage(message: Anthropic.Message, req: CompletionRequest, latencyMs: number): CompletionResponse {
  const text = message.content
    .filter((b): b is Anthropic.TextBlock => b.type === "text")
    .map((b) => b.text)
    .join("");
  const usage: Usage = {
    inputTokens: message.usage.input_tokens,
    outputTokens: message.usage.output_tokens,
  };
  if (message.usage.cache_read_input_tokens) usage.cacheReadTokens = message.usage.cache_read_input_tokens;
  if (message.usage.cache_creation_input_tokens) usage.cacheWriteTokens = message.usage.cache_creation_input_tokens;

  const res: CompletionResponse = { text, usage, provider: PROVIDER_NAME, model: message.model, latencyMs };
  if (message.stop_reason) res.stopReason = message.stop_reason;
  if (req.schema) {
    // Structured outputs constrain decoding, so this parses unless the reply
    // was cut off; the router re-checks and handles the failure either way.
    try {
      res.json = JSON.parse(text);
    } catch {
      // leave json unset
    }
  }
  return res;
}

/** Translate SDK errors into ModelProviderError so the router can decide on fallthrough. */
export function mapAnthropicError(err: unknown): unknown {
  if (err instanceof Anthropic.APIUserAbortError) return err;
  if (err instanceof Anthropic.APIConnectionTimeoutError) {
    return new ModelProviderError({ message: err.message, code: "TIMEOUT", retryable: true, provider: PROVIDER_NAME, cause: err });
  }
  if (err instanceof Anthropic.APIConnectionError) {
    return new ModelProviderError({ message: err.message, code: "NETWORK", retryable: true, provider: PROVIDER_NAME, cause: err });
  }
  if (err instanceof Anthropic.APIError && typeof err.status === "number") {
    const { code, retryable } = classifyHttpStatus(err.status);
    return new ModelProviderError({ message: err.message, code, retryable, provider: PROVIDER_NAME, status: err.status, cause: err });
  }
  if (err instanceof ModelProviderError) return err;
  const message = err instanceof Error ? err.message : String(err);
  return new ModelProviderError({ message, code: "UNKNOWN", retryable: false, provider: PROVIDER_NAME, cause: err });
}

export function readAnthropicConfig(raw: unknown): AnthropicProviderConfig {
  const config: AnthropicProviderConfig = {};
  if (typeof raw !== "object" || raw === null) return config;
  const r = raw as Record<string, unknown>;
  if (typeof r["apiKey"] === "string") config.apiKey = r["apiKey"];
  if (typeof r["apiKeyEnv"] === "string") config.apiKeyEnv = r["apiKeyEnv"];
  if (typeof r["baseUrl"] === "string") config.baseUrl = r["baseUrl"];
  if (typeof r["maxRetries"] === "number") config.maxRetries = r["maxRetries"];
  if (typeof r["timeoutMs"] === "number") config.timeoutMs = r["timeoutMs"];
  if (r["thinking"] === "adaptive" || r["thinking"] === "omit") config.thinking = r["thinking"];
  return config;
}

export const manifest: ExtensionManifest = {
  name: "provider-anthropic",
  version: "0.1.0",
  description: "Anthropic Messages API model provider.",
};

export default function anthropicProvider(yrm: ExtensionAPI): void {
  yrm.registerProvider(new AnthropicProvider(readAnthropicConfig(yrm.config.get())));
}
