import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelRouter,
  Route,
  Tier,
} from "../contracts/index.ts";

export type ScriptedResponse =
  | Partial<CompletionResponse>
  | Error
  | ((tier: Tier, req: CompletionRequest) => Partial<CompletionResponse> | Promise<Partial<CompletionResponse>>);

/**
 * ModelRouter for tests. `complete` pops the next scripted response (or throws
 * when the queue is empty, so an unexpected model call fails loudly). Every
 * call is recorded on `calls`.
 */
export class FakeRouter implements ModelRouter {
  readonly calls: Array<{ tier: Tier; req: CompletionRequest }> = [];
  readonly embedCalls: Array<{ tier: Tier; req: EmbeddingRequest }> = [];
  private readonly queue: ScriptedResponse[];

  constructor(
    responses: ScriptedResponse[] = [],
    private readonly routes: Record<string, Route[]> = {},
  ) {
    this.queue = [...responses];
  }

  push(...responses: ScriptedResponse[]): this {
    this.queue.push(...responses);
    return this;
  }

  get remaining(): number {
    return this.queue.length;
  }

  async complete<T = unknown>(tier: Tier, req: CompletionRequest): Promise<CompletionResponse<T>> {
    this.calls.push({ tier, req });
    const next = this.queue.shift();
    if (next === undefined) throw new Error(`FakeRouter: no scripted response left for tier "${tier}"`);
    if (next instanceof Error) throw next;
    const partial = typeof next === "function" ? await next(tier, req) : next;
    return {
      text: "",
      usage: { inputTokens: 0, outputTokens: 0, costUsd: 0 },
      provider: "fake",
      model: "fake",
      latencyMs: 0,
      ...partial,
    } as CompletionResponse<T>;
  }

  async embed(tier: Tier, req: EmbeddingRequest): Promise<EmbeddingResponse> {
    this.embedCalls.push({ tier, req });
    // Deterministic tiny vectors so similarity tests are reproducible.
    const vectors = req.inputs.map((s) => [s.length, [...s].reduce((n, c) => n + c.charCodeAt(0), 0) % 997, 1]);
    return { vectors, dimensions: 3, usage: { inputTokens: 0, outputTokens: 0 }, provider: "fake", model: "fake-embed" };
  }

  describe(tier: Tier): Route[] {
    return this.routes[tier] ?? [];
  }

  async spend(): Promise<{ usd: number; byTier: Record<string, number> }> {
    return { usd: 0, byTier: {} };
  }
}
