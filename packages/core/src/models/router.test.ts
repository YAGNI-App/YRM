import { describe, expect, it } from "bun:test";
import type {
  CompletionRequest,
  CompletionResponse,
  ModelInfo,
  ModelProvider,
  Route,
  RoutingPolicy,
} from "../contracts/models.ts";
import { ModelProviderError, RouterError } from "./errors.ts";
import { MemoryUsageSink } from "./usage.ts";
import { Router } from "./router.ts";
import { estimateCost, PRICE_TABLE } from "./pricing.ts";
import { parseJsonText } from "./json.ts";

type Handler = (model: string, req: CompletionRequest) => Promise<Partial<CompletionResponse>> | Partial<CompletionResponse>;

function fakeProvider(name: string, handler: Handler, models: ModelInfo[] = []) {
  const calls: Array<{ model: string; req: CompletionRequest }> = [];
  const provider: ModelProvider = {
    name,
    models: async () => models,
    async complete(model, req) {
      calls.push({ model, req });
      const out = await handler(model, req);
      return {
        text: "ok",
        usage: { inputTokens: 1000, outputTokens: 500 },
        provider: name,
        model,
        latencyMs: 5,
        ...out,
      };
    },
    async embed(model, req) {
      return {
        vectors: req.inputs.map(() => [0.1, 0.2]),
        dimensions: 2,
        usage: { inputTokens: 10, outputTokens: 0 },
        provider: name,
        model,
      };
    },
  };
  return { provider, calls };
}

const info = (id: string, extra: Partial<ModelInfo> = {}): ModelInfo => ({
  id,
  supports: { structuredOutput: true, embeddings: false },
  ...extra,
});

function router(routes: Route[], providers: ModelProvider[], extra: Partial<RoutingPolicy> = {}, opts: Partial<ConstructorParameters<typeof Router>[0]> = {}) {
  const usage = new MemoryUsageSink();
  const r = new Router({
    // Record<Tier, Route[]> demands every built-in tier; tests only configure two.
    policy: { routes: { extract: routes, embed: routes } as RoutingPolicy["routes"], ...extra },
    providers: new Map(providers.map((p) => [p.name, p])),
    usage,
    ...opts,
  });
  return { r, usage };
}

const req: CompletionRequest = { messages: [{ role: "user", content: "hello" }], maxTokens: 100 };

describe("Router.complete", () => {
  it("throws NO_ROUTE for an unconfigured tier", async () => {
    const { r } = router([], []);
    const err = await r.complete("synthesize", req).catch((e) => e);
    expect(err).toBeInstanceOf(RouterError);
    expect(err.code).toBe("NO_ROUTE");
  });

  it("falls through on a retryable error", async () => {
    const a = fakeProvider("a", () => {
      throw new ModelProviderError({ message: "slow down", code: "RATE_LIMITED", retryable: true, provider: "a", status: 429 });
    });
    const b = fakeProvider("b", () => ({ text: "from b" }));
    const { r } = router([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }], [a.provider, b.provider]);
    const res = await r.complete("extract", req);
    expect(res.text).toBe("from b");
    expect(a.calls.length).toBe(1);
  });

  it("treats non-provider errors as network failures and falls through", async () => {
    const a = fakeProvider("a", () => {
      throw new TypeError("fetch failed");
    });
    const b = fakeProvider("b", () => ({ text: "from b" }));
    const { r } = router([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }], [a.provider, b.provider]);
    expect((await r.complete("extract", req)).text).toBe("from b");
  });

  it("does not fall through on a non-retryable error", async () => {
    const a = fakeProvider("a", () => {
      throw new ModelProviderError({ message: "bad", code: "BAD_REQUEST", retryable: false, provider: "a", status: 400 });
    });
    const b = fakeProvider("b", () => ({ text: "from b" }));
    const { r } = router([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }], [a.provider, b.provider]);
    const err = await r.complete("extract", req).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.code).toBe("BAD_REQUEST");
    expect(b.calls.length).toBe(0);
  });

  it("reports ALL_ROUTES_FAILED with attempts when every hop fails", async () => {
    const a = fakeProvider("a", () => {
      throw new ModelProviderError({ message: "down", code: "SERVER_ERROR", retryable: true, provider: "a", status: 503 });
    });
    const { r } = router([{ provider: "a", model: "m1" }, { provider: "missing", model: "x" }], [a.provider]);
    const err = await r.complete("extract", req).catch((e) => e);
    expect(err.code).toBe("ALL_ROUTES_FAILED");
    expect(err.attempts.map((x: { outcome: string }) => x.outcome)).toEqual(["failed", "skipped"]);
  });

  it("skips non-local models under localOnly", async () => {
    const cloud = fakeProvider("cloud", () => ({ text: "cloud" }), [info("big", { supports: { structuredOutput: true, embeddings: false, local: false } })]);
    const local = fakeProvider("local", () => ({ text: "local" }), [info("small", { supports: { structuredOutput: true, embeddings: false, local: true } })]);
    const { r } = router([{ provider: "cloud", model: "big" }, { provider: "local", model: "small" }], [cloud.provider, local.provider], { localOnly: true });
    expect((await r.complete("extract", req)).text).toBe("local");
    expect(cloud.calls.length).toBe(0);
  });

  it("refuses everything under localOnly when no model is local", async () => {
    const cloud = fakeProvider("cloud", () => ({ text: "cloud" }));
    const { r } = router([{ provider: "cloud", model: "big" }], [cloud.provider], { localOnly: true });
    const err = await r.complete("extract", req).catch((e) => e);
    expect(err.code).toBe("NO_ELIGIBLE_ROUTE");
  });

  it("skips hops whose estimated cost exceeds maxCostUsd", async () => {
    const pricey = fakeProvider("pricey", () => ({ text: "pricey" }), [info("p", { pricing: { input: 100, output: 1000 } })]);
    const cheap = fakeProvider("cheap", () => ({ text: "cheap" }));
    const { r } = router(
      [{ provider: "pricey", model: "p" }, { provider: "cheap", model: "c", pricing: { input: 0.1, output: 0.1 } }],
      [pricey.provider, cheap.provider],
    );
    // 100 output tokens at $1000/M = $0.10 for the pricey hop.
    const res = await r.complete("extract", { ...req, maxCostUsd: 0.01 });
    expect(res.text).toBe("cheap");
    expect(pricey.calls.length).toBe(0);
  });

  it("throws BUDGET_EXCEEDED once the month's spend reaches the budget", async () => {
    const a = fakeProvider("a", () => ({}));
    const { r, usage } = router([{ provider: "a", model: "m", pricing: { input: 1, output: 1 } }], [a.provider], { monthlyBudgetUsd: 1 });
    await usage.record({
      tenantId: "local", tier: "extract", kind: "complete", provider: "a", model: "m",
      at: new Date().toISOString(), latencyMs: 1, usage: { inputTokens: 0, outputTokens: 0, costUsd: 1.5 }, ok: true,
    });
    const err = await r.complete("extract", req).catch((e) => e);
    expect(err.code).toBe("BUDGET_EXCEEDED");
    expect(a.calls.length).toBe(0);
  });

  it("blocks when the before hook returns null", async () => {
    const a = fakeProvider("a", () => ({}));
    const { r } = router([{ provider: "a", model: "m" }], [a.provider], {}, { hooks: { before: async () => null } });
    const err = await r.complete("extract", req).catch((e) => e);
    expect(err.code).toBe("BLOCKED");
    expect(a.calls.length).toBe(0);
  });

  it("lets the before hook rewrite the request and calls the after hook", async () => {
    const a = fakeProvider("a", (_m, rq) => ({ text: rq.messages[0]?.content ?? "" }));
    const seen: string[] = [];
    const { r } = router([{ provider: "a", model: "m" }], [a.provider], {}, {
      hooks: {
        before: async (_tier, rq) => ({ ...rq, messages: [{ role: "user", content: "rewritten" }] }),
        after: async (tier, _rq, res) => {
          seen.push(`${tier}:${res.text}`);
        },
      },
    });
    const res = await r.complete("extract", req);
    expect(res.text).toBe("rewritten");
    expect(seen).toEqual(["extract:rewritten"]);
  });

  it("applies route overrides for maxTokens and temperature", async () => {
    const a = fakeProvider("a", () => ({}));
    const { r } = router([{ provider: "a", model: "m", maxTokens: 42, temperature: 0 }], [a.provider]);
    await r.complete("extract", { ...req, temperature: 1 });
    expect(a.calls[0]?.req.maxTokens).toBe(42);
    expect(a.calls[0]?.req.temperature).toBe(0);
  });

  it("parses fenced JSON when the provider returns only text", async () => {
    const a = fakeProvider("a", () => ({ text: 'Here you go:\n```json\n{"relevant": true, "kinds": []}\n```' }));
    const { r } = router([{ provider: "a", model: "m" }], [a.provider]);
    const res = await r.complete<{ relevant: boolean; kinds: string[] }>("extract", {
      ...req,
      schema: { type: "object", required: ["relevant", "kinds"] },
    });
    expect(res.json).toEqual({ relevant: true, kinds: [] });
  });

  it("falls through once on SCHEMA_MISMATCH", async () => {
    const a = fakeProvider("a", () => ({ text: '{"other": 1}' }));
    const b = fakeProvider("b", () => ({ text: '{"relevant": false}' }));
    const { r, usage } = router([{ provider: "a", model: "m1" }, { provider: "b", model: "m2" }], [a.provider, b.provider]);
    const res = await r.complete("extract", { ...req, schema: { type: "object", required: ["relevant"] } });
    expect(res.json).toEqual({ relevant: false });
    expect(usage.records.map((x) => [x.provider, x.ok, x.errorCode ?? null])).toEqual([
      ["a", false, "SCHEMA_MISMATCH"],
      ["b", true, null],
    ]);
  });

  it("throws SCHEMA_MISMATCH after the single fallthrough is used", async () => {
    const bad = () => ({ text: "not json at all" });
    const a = fakeProvider("a", bad);
    const b = fakeProvider("b", bad);
    const c = fakeProvider("c", bad);
    const { r } = router(
      [{ provider: "a", model: "m" }, { provider: "b", model: "m" }, { provider: "c", model: "m" }],
      [a.provider, b.provider, c.provider],
    );
    const err = await r.complete("extract", { ...req, schema: { type: "object", required: ["x"] } }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.code).toBe("SCHEMA_MISMATCH");
    expect(c.calls.length).toBe(0);
  });

  it("records usage with cost from route pricing, then provider pricing", async () => {
    const a = fakeProvider("a", () => ({ usage: { inputTokens: 1_000_000, outputTokens: 100_000, cacheReadTokens: 1_000_000 } }), [
      info("claude-sonnet-5", { pricing: PRICE_TABLE["claude-sonnet-5"]! }),
    ]);
    const { r, usage } = router([{ provider: "a", model: "claude-sonnet-5" }], [a.provider]);
    const res = await r.complete("extract", { ...req, meta: { tenantId: "acme" } });
    // $2 input + $1 output + $0.20 cache read
    expect(res.usage.costUsd).toBeCloseTo(3.2, 6);
    expect(usage.records[0]?.tenantId).toBe("acme");
    expect(usage.records[0]?.usage.costUsd).toBeCloseTo(3.2, 6);
    expect((await usage.monthToDate("acme")).byTier["extract"]).toBeCloseTo(3.2, 6);

    const { r: r2, usage: u2 } = router([{ provider: "a", model: "claude-sonnet-5", pricing: { input: 0, output: 10 } }], [a.provider]);
    await r2.complete("extract", req);
    expect(u2.records[0]?.usage.costUsd).toBeCloseTo(1, 6);
    expect((await r2.spend()).usd).toBeCloseTo(1, 6);
  });
});

describe("Router.embed and describe", () => {
  it("embeds through the chain and records usage", async () => {
    const a = fakeProvider("a", () => ({}));
    const { r, usage } = router([{ provider: "a", model: "e", pricing: { input: 1_000_000, output: 0 } }], [a.provider]);
    const res = await r.embed("embed", { inputs: ["x", "y"] });
    expect(res.vectors.length).toBe(2);
    expect(usage.records[0]?.kind).toBe("embed");
    expect(usage.records[0]?.usage.costUsd).toBeCloseTo(10, 6);
  });

  it("skips providers without embed", async () => {
    const noEmbed: ModelProvider = { name: "n", models: async () => [], complete: async () => { throw new Error("unused"); } };
    const a = fakeProvider("a", () => ({}));
    const { r } = router([{ provider: "n", model: "x" }, { provider: "a", model: "e" }], [noEmbed, a.provider]);
    expect((await r.embed("embed", { inputs: ["x"] })).provider).toBe("a");
  });

  it("describes a tier's chain as a copy", () => {
    const { r } = router([{ provider: "a", model: "m" }], []);
    const d = r.describe("extract");
    d[0]!.model = "changed";
    expect(r.describe("extract")).toEqual([{ provider: "a", model: "m" }]);
    expect(r.describe("unknown")).toEqual([]);
  });
});

describe("pricing and json helpers", () => {
  it("prices cache writes at 1.25x input and defaults cache reads to 10%", () => {
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, cacheWriteTokens: 1_000_000 }, { input: 4, output: 20 })).toBeCloseTo(5, 6);
    expect(estimateCost({ inputTokens: 0, outputTokens: 0, cacheReadTokens: 1_000_000 }, { input: 4, output: 20 })).toBeCloseTo(0.4, 6);
  });

  it("parses bare, fenced and wrapped JSON", () => {
    expect(parseJsonText('{"a":1}')).toEqual({ a: 1 });
    expect(parseJsonText("```\n[1,2]\n```")).toEqual([1, 2]);
    expect(parseJsonText('Sure! {"a": {"b": 2}} Hope that helps.')).toEqual({ a: { b: 2 } });
    expect(parseJsonText("nope")).toBeUndefined();
  });
});
