import {
  ModelProviderError,
  parseJsonText,
  providerErrorFromStatus,
  type CompletionRequest,
  type CompletionResponse,
  type EmbeddingRequest,
  type EmbeddingResponse,
  type ExtensionAPI,
  type ExtensionManifest,
  type JsonSchema,
  type ModelInfo,
  type ModelProvider,
  type Usage,
} from "@yrm/core";

export const DEFAULT_PROVIDER_NAME = "openai-compatible";
export const DEFAULT_BASE_URL = "http://localhost:11434/v1";

export interface OpenAICompatibleConfig {
  /** Provider name routes refer to. Set it to run several endpoints side by side. */
  name?: string;
  /** Up to and including the version segment, e.g. https://openrouter.ai/api/v1. */
  baseUrl?: string;
  /** Environment variable holding the key. Many local servers need none. */
  apiKeyEnv?: string;
  apiKey?: string;
  /** Extra headers on every request (OpenRouter's HTTP-Referer, for example). */
  headers?: Record<string, string>;
  /** Whether models here run on hardware the tenant controls. Defaults to true for loopback hosts. */
  local?: boolean;
  timeoutMs?: number;
}

export interface OpenAICompatibleDeps {
  fetch?: (input: string, init: RequestInit) => Promise<Response>;
  env?: Record<string, string | undefined>;
  now?: () => number;
}

type ChatMessage = { role: "system" | "user" | "assistant"; content: string };

type ResponseFormat =
  | { type: "json_schema"; json_schema: { name: string; schema: JsonSchema; strict: boolean } }
  | { type: "json_object" };

interface ChatCompletionBody {
  model?: string;
  choices?: Array<{ message?: { content?: string | null }; finish_reason?: string | null }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number; prompt_tokens_details?: { cached_tokens?: number } };
}

interface EmbeddingBody {
  model?: string;
  data?: Array<{ embedding: number[]; index?: number }>;
  usage?: { prompt_tokens?: number };
}

const DEFAULT_MAX_TOKENS = 4096;
const LOOPBACK = new Set(["localhost", "127.0.0.1", "::1", "[::1]", "0.0.0.0"]);

export function isLoopback(baseUrl: string): boolean {
  try {
    return LOOPBACK.has(new URL(baseUrl).hostname);
  } catch {
    return false;
  }
}

export class OpenAICompatibleProvider implements ModelProvider {
  readonly name: string;
  readonly baseUrl: string;
  readonly local: boolean;
  private readonly config: OpenAICompatibleConfig;
  private readonly fetch: (input: string, init: RequestInit) => Promise<Response>;
  private readonly env: Record<string, string | undefined>;
  private readonly now: () => number;

  constructor(config: OpenAICompatibleConfig = {}, deps: OpenAICompatibleDeps = {}) {
    this.config = config;
    this.name = config.name ?? DEFAULT_PROVIDER_NAME;
    this.baseUrl = (config.baseUrl ?? DEFAULT_BASE_URL).replace(/\/+$/, "");
    this.local = config.local ?? isLoopback(this.baseUrl);
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
    this.env = deps.env ?? process.env;
    this.now = deps.now ?? (() => performance.now());
  }

  async models(): Promise<ModelInfo[]> {
    try {
      const res = await this.request("GET", "/models");
      if (!res.ok) return [];
      const body = (await res.json()) as { data?: Array<{ id?: unknown }> };
      return (body.data ?? [])
        .map((m) => m.id)
        .filter((id): id is string => typeof id === "string")
        .map((id) => ({
          id,
          supports: { structuredOutput: true, embeddings: /embed/i.test(id), local: this.local },
        }));
    } catch {
      // An unreachable endpoint lists nothing; routes to it can still be tried.
      return [];
    }
  }

  async complete(model: string, req: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse> {
    const started = this.now();
    const messages = toChatMessages(req);
    const body: Record<string, unknown> = {
      model,
      messages,
      max_tokens: req.maxTokens ?? DEFAULT_MAX_TOKENS,
    };
    if (req.temperature !== undefined) body["temperature"] = req.temperature;
    if (req.schema) body["response_format"] = jsonSchemaFormat(req.schema);

    let res = await this.request("POST", "/chat/completions", body, signal);
    if (res.status === 400 && req.schema) {
      // Plenty of servers (older vLLM, llama.cpp, some hosted gateways) reject
      // json_schema. JSON mode plus the schema in the prompt is the fallback;
      // the router validates the shape afterwards.
      await res.body?.cancel();
      body["response_format"] = { type: "json_object" } satisfies ResponseFormat;
      body["messages"] = withSchemaInstruction(messages, req.schema);
      res = await this.request("POST", "/chat/completions", body, signal);
    }
    if (!res.ok) throw await this.httpError(res);

    const data = (await res.json()) as ChatCompletionBody;
    const choice = data.choices?.[0];
    const text = choice?.message?.content ?? "";
    const out: CompletionResponse = {
      text,
      usage: mapUsage(data.usage),
      provider: this.name,
      model: data.model ?? model,
      latencyMs: Math.round(this.now() - started),
    };
    if (choice?.finish_reason) out.stopReason = choice.finish_reason;
    if (req.schema) {
      const json = parseJsonText(text);
      if (json !== undefined) out.json = json;
    }
    return out;
  }

  async embed(model: string, req: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse> {
    const res = await this.request("POST", "/embeddings", { model, input: req.inputs }, signal);
    if (!res.ok) throw await this.httpError(res);
    const data = (await res.json()) as EmbeddingBody;
    const vectors = [...(data.data ?? [])]
      .sort((a, b) => (a.index ?? 0) - (b.index ?? 0))
      .map((d) => d.embedding);
    return {
      vectors,
      dimensions: vectors[0]?.length ?? 0,
      usage: { inputTokens: data.usage?.prompt_tokens ?? 0, outputTokens: 0 },
      provider: this.name,
      model: data.model ?? model,
    };
  }

  private async request(method: "GET" | "POST", path: string, body?: unknown, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { ...this.config.headers };
    if (body !== undefined) headers["content-type"] = "application/json";
    const key = this.config.apiKey ?? (this.config.apiKeyEnv ? this.env[this.config.apiKeyEnv] : undefined);
    if (key) headers["authorization"] = `Bearer ${key}`;

    const signals = [signal, this.config.timeoutMs ? AbortSignal.timeout(this.config.timeoutMs) : undefined].filter(
      (s): s is AbortSignal => s !== undefined,
    );
    const init: RequestInit = { method, headers };
    if (body !== undefined) init.body = JSON.stringify(body);
    if (signals.length > 0) init.signal = AbortSignal.any(signals);

    try {
      return await this.fetch(`${this.baseUrl}${path}`, init);
    } catch (err) {
      if (signal?.aborted) throw err;
      const timedOut = err instanceof Error && err.name === "TimeoutError";
      throw new ModelProviderError({
        message: `${method} ${this.baseUrl}${path} failed: ${err instanceof Error ? err.message : String(err)}`,
        code: timedOut ? "TIMEOUT" : "NETWORK",
        retryable: true,
        provider: this.name,
        cause: err,
      });
    }
  }

  private async httpError(res: Response): Promise<ModelProviderError> {
    const raw = await res.text().catch(() => "");
    let detail = raw;
    try {
      const parsed = JSON.parse(raw) as { error?: { message?: unknown } | string; message?: unknown };
      if (typeof parsed.error === "string") detail = parsed.error;
      else if (typeof parsed.error?.message === "string") detail = parsed.error.message;
      else if (typeof parsed.message === "string") detail = parsed.message;
    } catch {
      // not JSON; keep the raw text
    }
    return providerErrorFromStatus(this.name, res.status, `${this.name} returned ${res.status}: ${detail.slice(0, 500)}`);
  }
}

function toChatMessages(req: CompletionRequest): ChatMessage[] {
  const messages: ChatMessage[] = [];
  if (req.system) messages.push({ role: "system", content: req.system });
  for (const m of req.messages) messages.push({ role: m.role, content: m.content });
  return messages;
}

function jsonSchemaFormat(schema: JsonSchema): ResponseFormat {
  return { type: "json_schema", json_schema: { name: "result", schema, strict: true } };
}

function withSchemaInstruction(messages: ChatMessage[], schema: JsonSchema): ChatMessage[] {
  const instruction = `Respond with a single JSON object and nothing else. It must conform to this JSON Schema:\n${JSON.stringify(schema)}`;
  const [first, ...rest] = messages;
  if (first?.role === "system") return [{ role: "system", content: `${first.content}\n\n${instruction}` }, ...rest];
  return [{ role: "system", content: instruction }, ...messages];
}

/** OpenAI counts cached tokens inside prompt_tokens; YRM's inputTokens excludes them. */
function mapUsage(u: ChatCompletionBody["usage"]): Usage {
  const prompt = u?.prompt_tokens ?? 0;
  const cached = u?.prompt_tokens_details?.cached_tokens ?? 0;
  const usage: Usage = { inputTokens: prompt - cached, outputTokens: u?.completion_tokens ?? 0 };
  if (cached > 0) usage.cacheReadTokens = cached;
  return usage;
}

export function readOpenAIConfig(raw: unknown): OpenAICompatibleConfig {
  const config: OpenAICompatibleConfig = {};
  if (typeof raw !== "object" || raw === null) return config;
  const r = raw as Record<string, unknown>;
  if (typeof r["name"] === "string") config.name = r["name"];
  if (typeof r["baseUrl"] === "string") config.baseUrl = r["baseUrl"];
  if (typeof r["apiKeyEnv"] === "string") config.apiKeyEnv = r["apiKeyEnv"];
  if (typeof r["apiKey"] === "string") config.apiKey = r["apiKey"];
  if (typeof r["local"] === "boolean") config.local = r["local"];
  if (typeof r["timeoutMs"] === "number") config.timeoutMs = r["timeoutMs"];
  const headers = r["headers"];
  if (typeof headers === "object" && headers !== null) {
    config.headers = Object.fromEntries(
      Object.entries(headers).filter((e): e is [string, string] => typeof e[1] === "string"),
    );
  }
  return config;
}

export const manifest: ExtensionManifest = {
  name: "provider-openai",
  version: "0.1.0",
  description: "Model provider for any OpenAI-compatible /chat/completions endpoint.",
};

export default function openAICompatibleProvider(yrm: ExtensionAPI): void {
  yrm.registerProvider(new OpenAICompatibleProvider(readOpenAIConfig(yrm.config.get())));
}
