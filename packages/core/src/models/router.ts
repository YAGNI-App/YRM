import type {
  CompletionRequest,
  CompletionResponse,
  EmbeddingRequest,
  EmbeddingResponse,
  ModelInfo,
  ModelProvider,
  ModelRouter,
  Route,
  RoutingPolicy,
  Tier,
  Usage,
} from "../contracts/models.ts";
import { ModelProviderError, RouterError, type RouteAttempt } from "./errors.ts";
import { checkSchemaShape, parseJsonText } from "./json.ts";
import { estimateCost, estimateTokens, type ModelPricing } from "./pricing.ts";
import type { ModelCallRecord, UsageSink } from "./usage.ts";

export interface RouterHooks {
  /** Rewrite the request, return null to block the call, or undefined to leave it. */
  before?(tier: string, req: CompletionRequest): Promise<CompletionRequest | null | undefined>;
  after?(tier: string, req: CompletionRequest, res: CompletionResponse): Promise<void>;
}

export interface RouterOptions {
  policy: RoutingPolicy;
  providers: Map<string, ModelProvider>;
  usage?: UsageSink;
  hooks?: RouterHooks;
  now?: () => Date;
  /** Tenant to bill when a request does not carry `meta.tenantId`. Defaults to "local". */
  tenantId?: string;
}

/** Used for cost estimates when neither the request nor the route sets maxTokens. */
const DEFAULT_MAX_TOKENS = 4096;
/** How long a hop that failed to connect is skipped; `policy.cooldownMs` overrides. */
export const DEFAULT_COOLDOWN_MS = 60_000;

/** A route as `Router.describe()` reports it: `downUntil` is set while the hop is cooling down. */
export type DescribedRoute = Route & { downUntil?: string };

export class Router implements ModelRouter {
  private readonly policy: RoutingPolicy;
  private readonly providers: Map<string, ModelProvider>;
  private readonly usage: UsageSink | undefined;
  private readonly hooks: RouterHooks;
  private readonly now: () => Date;
  private readonly tenantId: string;
  private readonly modelCache = new Map<string, Promise<ModelInfo[]>>();
  /** `provider/model` to the epoch ms until which the hop is skipped. */
  private readonly downUntil = new Map<string, number>();

  constructor(opts: RouterOptions) {
    this.policy = opts.policy;
    this.providers = opts.providers;
    this.usage = opts.usage;
    this.hooks = opts.hooks ?? {};
    this.now = opts.now ?? (() => new Date());
    this.tenantId = opts.tenantId ?? "local";
  }

  describe(tier: Tier): DescribedRoute[] {
    return (this.policy.routes[tier] ?? []).map((r) => {
      const until = this.cooldownUntil(r);
      return until === undefined ? { ...r } : { ...r, downUntil: new Date(until).toISOString() };
    });
  }

  async spend(): Promise<{ usd: number; byTier: Record<string, number> }> {
    if (!this.usage) return { usd: 0, byTier: {} };
    return this.usage.monthToDate(this.tenantId);
  }

  async complete<T = unknown>(tier: Tier, request: CompletionRequest, signal?: AbortSignal): Promise<CompletionResponse<T>> {
    const routes = this.routesFor(tier);
    const tenantId = this.tenantFor(request.meta);
    await this.checkBudget(tier, tenantId);

    let req = request;
    if (this.hooks.before) {
      const rewritten = await this.hooks.before(tier, req);
      if (rewritten === null) throw new RouterError("BLOCKED", tier, `model:before blocked the ${tier} call`);
      if (rewritten !== undefined) req = rewritten;
    }

    const attempts: RouteAttempt[] = [];
    let lastError: unknown;
    let schemaFallthroughUsed = false;
    const inputTokens = estimateTokens([req.system ?? "", ...req.messages.map((m) => m.content)].join("\n"));

    for (const route of routes) {
      const hop = await this.prepareHop(route, attempts);
      if (!hop) continue;
      const maxTokens = route.maxTokens ?? req.maxTokens ?? DEFAULT_MAX_TOKENS;
      if (req.maxCostUsd !== undefined && hop.pricing) {
        const estimate = estimateCost({ inputTokens, outputTokens: maxTokens }, hop.pricing);
        if (estimate > req.maxCostUsd) {
          attempts.push(skip(route, `estimated $${estimate.toFixed(4)} exceeds maxCostUsd $${req.maxCostUsd}`));
          continue;
        }
      }

      const hopReq: CompletionRequest = { ...req, maxTokens };
      const temperature = route.temperature ?? req.temperature;
      if (temperature !== undefined) hopReq.temperature = temperature;

      const started = this.now();
      let res: CompletionResponse;
      try {
        res = await hop.provider.complete(route.model, hopReq, signal);
      } catch (err) {
        if (signal?.aborted || !isRetryable(err)) throw err;
        this.noteFailure(route, err);
        attempts.push(fail(route, err));
        lastError = err;
        continue;
      }

      const usage = this.price(res.usage, hop.pricing);
      res = { ...res, usage };
      let schemaError: ModelProviderError | undefined;
      if (req.schema) {
        const json = res.json !== undefined ? res.json : parseJsonText(res.text);
        const problem = json === undefined ? "response was not valid JSON" : checkSchemaShape(json, req.schema);
        if (problem) {
          schemaError = new ModelProviderError({
            message: `${route.provider}/${route.model} did not match the schema: ${problem}`,
            code: "SCHEMA_MISMATCH",
            retryable: false,
            provider: route.provider,
          });
        } else {
          res = { ...res, json };
        }
      }

      await this.record({
        tenantId,
        tier,
        kind: "complete",
        provider: res.provider,
        model: res.model,
        at: started.toISOString(),
        latencyMs: res.latencyMs,
        usage,
        ok: schemaError === undefined,
        ...(schemaError ? { errorCode: schemaError.code } : {}),
        ...(req.meta ? { meta: req.meta } : {}),
      });

      if (schemaError) {
        // A different model may comply, so allow one fallthrough; after that
        // the schema itself is the likelier problem.
        if (schemaFallthroughUsed) throw schemaError;
        schemaFallthroughUsed = true;
        attempts.push(fail(route, schemaError));
        lastError = schemaError;
        continue;
      }

      if (this.hooks.after) await this.hooks.after(tier, req, res);
      return res as CompletionResponse<T>;
    }

    throw this.exhausted(tier, attempts, lastError);
  }

  async embed(tier: Tier, req: EmbeddingRequest, signal?: AbortSignal): Promise<EmbeddingResponse> {
    const routes = this.routesFor(tier);
    const tenantId = this.tenantFor(req.meta);
    await this.checkBudget(tier, tenantId);

    const attempts: RouteAttempt[] = [];
    let lastError: unknown;
    for (const route of routes) {
      const hop = await this.prepareHop(route, attempts);
      if (!hop) continue;
      const embed = hop.provider.embed?.bind(hop.provider);
      if (!embed) {
        attempts.push(skip(route, `provider ${route.provider} does not support embeddings`));
        continue;
      }
      const started = this.now();
      let res: EmbeddingResponse;
      try {
        res = await embed(route.model, req, signal);
      } catch (err) {
        if (signal?.aborted || !isRetryable(err)) throw err;
        this.noteFailure(route, err);
        attempts.push(fail(route, err));
        lastError = err;
        continue;
      }
      const usage = this.price(res.usage, hop.pricing);
      res = { ...res, usage };
      await this.record({
        tenantId,
        tier,
        kind: "embed",
        provider: res.provider,
        model: res.model,
        at: started.toISOString(),
        latencyMs: this.now().getTime() - started.getTime(),
        usage,
        ok: true,
        ...(req.meta ? { meta: req.meta } : {}),
      });
      return res;
    }
    throw this.exhausted(tier, attempts, lastError);
  }

  // ---- internals --------------------------------------------------------------

  private routesFor(tier: Tier): Route[] {
    const routes = this.policy.routes[tier];
    if (!routes || routes.length === 0) {
      throw new RouterError("NO_ROUTE", tier, `no route configured for tier "${tier}"`);
    }
    return routes;
  }

  private tenantFor(meta: Record<string, unknown> | undefined): string {
    const t = meta?.["tenantId"];
    return typeof t === "string" && t.length > 0 ? t : this.tenantId;
  }

  private async checkBudget(tier: string, tenantId: string): Promise<void> {
    const budget = this.policy.monthlyBudgetUsd;
    if (budget === undefined || !this.usage) return;
    const { usd } = await this.usage.monthToDate(tenantId);
    if (usd >= budget) {
      throw new RouterError(
        "BUDGET_EXCEEDED",
        tier,
        `monthly budget of $${budget} reached ($${usd.toFixed(2)} spent this month)`,
      );
    }
  }

  /** Resolve provider, model info and pricing for a hop, or record why it is skipped. */
  private async prepareHop(
    route: Route,
    attempts: RouteAttempt[],
  ): Promise<{ provider: ModelProvider; pricing: ModelPricing | undefined } | null> {
    const until = this.cooldownUntil(route);
    if (until !== undefined) {
      attempts.push(skip(route, `down (cooldown until ${new Date(until).toISOString()})`));
      return null;
    }
    const provider = this.providers.get(route.provider);
    if (!provider) {
      attempts.push(skip(route, `provider ${route.provider} is not registered`));
      return null;
    }
    const info = (await this.modelsOf(provider)).find((m) => m.id === route.model);
    if (this.policy.localOnly && info?.supports.local !== true) {
      attempts.push(skip(route, "policy is localOnly and the model is not marked local"));
      return null;
    }
    return { provider, pricing: route.pricing ?? info?.pricing };
  }

  /** Epoch ms the hop is down until, or undefined when it is usable. Expired entries are dropped. */
  private cooldownUntil(route: Route): number | undefined {
    const key = hopKey(route);
    const until = this.downUntil.get(key);
    if (until === undefined) return undefined;
    if (this.now().getTime() >= until) {
      this.downUntil.delete(key);
      return undefined;
    }
    return until;
  }

  /** Only connection failures trip the breaker; rate limits and 5xx mean the server is there. */
  private noteFailure(route: Route, err: unknown): void {
    const ms = this.policy.cooldownMs ?? DEFAULT_COOLDOWN_MS;
    if (ms <= 0 || !isConnectionFailure(err)) return;
    this.downUntil.set(hopKey(route), this.now().getTime() + ms);
  }

  private modelsOf(provider: ModelProvider): Promise<ModelInfo[]> {
    let cached = this.modelCache.get(provider.name);
    if (!cached) {
      // A provider that cannot list models is still usable; it just has no
      // metadata, so localOnly rejects it and cost falls back to route pricing.
      cached = provider.models().catch(() => []);
      this.modelCache.set(provider.name, cached);
    }
    return cached;
  }

  /** Unpriced routes (local or custom endpoints without `route.pricing`) cost zero. */
  private price(usage: Usage, pricing: ModelPricing | undefined): Usage & { costUsd: number } {
    return { ...usage, costUsd: pricing ? estimateCost(usage, pricing) : 0 };
  }

  private async record(entry: ModelCallRecord): Promise<void> {
    if (this.usage) await this.usage.record(entry);
  }

  private exhausted(tier: string, attempts: RouteAttempt[], lastError: unknown): RouterError {
    const summary = attempts.map((a) => `${a.provider}/${a.model} ${a.outcome}: ${a.reason}`).join("; ");
    if (lastError === undefined) {
      return new RouterError("NO_ELIGIBLE_ROUTE", tier, `no eligible route for tier "${tier}": ${summary}`, attempts);
    }
    return new RouterError("ALL_ROUTES_FAILED", tier, `every route for tier "${tier}" failed: ${summary}`, attempts, lastError);
  }
}

/**
 * Provider errors say whether they are retryable. Anything else thrown by a
 * provider (a fetch TypeError, a socket reset) is treated as a network failure
 * and worth trying on the next hop.
 */
function isRetryable(err: unknown): boolean {
  if (err instanceof ModelProviderError) return err.retryable;
  if (err instanceof Error && err.name === "AbortError") return false;
  return true;
}

/** A provider that says NETWORK, or anything thrown that is not a provider error (a fetch TypeError). */
function isConnectionFailure(err: unknown): boolean {
  if (err instanceof ModelProviderError) return err.code === "NETWORK";
  return !(err instanceof Error && err.name === "AbortError");
}

function hopKey(route: Route): string {
  return `${route.provider}/${route.model}`;
}

function skip(route: Route, reason: string): RouteAttempt {
  return { provider: route.provider, model: route.model, outcome: "skipped", reason };
}

function fail(route: Route, err: unknown): RouteAttempt {
  const reason = err instanceof ModelProviderError ? `${err.code}: ${err.message}` : String(err);
  return { provider: route.provider, model: route.model, outcome: "failed", reason };
}
