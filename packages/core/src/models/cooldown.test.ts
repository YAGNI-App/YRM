import { describe, expect, it } from "bun:test";
import type { CompletionRequest, CompletionResponse, ModelProvider, Route, RoutingPolicy } from "../contracts/models.ts";
import { ModelProviderError } from "./errors.ts";
import { Router } from "./router.ts";

type Handler = () => Partial<CompletionResponse>;

function fakeProvider(name: string, handler: Handler) {
  const calls: string[] = [];
  const provider: ModelProvider = {
    name,
    models: async () => [],
    async complete(model) {
      calls.push(model);
      return { text: "ok", usage: { inputTokens: 1, outputTokens: 1 }, provider: name, model, latencyMs: 1, ...handler() };
    },
  };
  return { provider, calls };
}

const refused: Handler = () => {
  throw new ModelProviderError({ message: "Unable to connect", code: "NETWORK", retryable: true, provider: "local" });
};

const req: CompletionRequest = { messages: [{ role: "user", content: "hello" }], maxTokens: 10 };

function clocked(routes: Route[], providers: ModelProvider[], extra: Partial<RoutingPolicy> = {}) {
  let now = new Date("2026-10-04T12:00:00.000Z");
  const r = new Router({
    policy: { routes: { extract: routes } as RoutingPolicy["routes"], ...extra },
    providers: new Map(providers.map((p) => [p.name, p])),
    now: () => now,
  });
  return { r, advance: (ms: number) => (now = new Date(now.getTime() + ms)) };
}

describe("Router cooldown", () => {
  it("skips a hop that failed to connect, without a request, until the cooldown ends", async () => {
    const local = fakeProvider("local", refused);
    const { r, advance } = clocked([{ provider: "local", model: "m" }], [local.provider]);
    expect((await r.complete("extract", req).catch((e) => e)).code).toBe("ALL_ROUTES_FAILED");
    expect(local.calls.length).toBe(1);

    const second = await r.complete("extract", req).catch((e) => e);
    expect(second.code).toBe("NO_ELIGIBLE_ROUTE");
    expect(second.attempts[0].reason).toContain("down (cooldown");
    expect(local.calls.length).toBe(1);
    expect(r.describe("extract")[0]!.downUntil).toBe("2026-10-04T12:01:00.000Z");

    advance(60_000);
    expect(r.describe("extract")[0]!.downUntil).toBeUndefined();
    await r.complete("extract", req).catch(() => undefined);
    expect(local.calls.length).toBe(2);
  });

  it("falls through to the next hop while one is cooling down", async () => {
    const local = fakeProvider("local", refused);
    const hosted = fakeProvider("hosted", () => ({ text: "hosted" }));
    const { r } = clocked([{ provider: "local", model: "m" }, { provider: "hosted", model: "h" }], [local.provider, hosted.provider]);
    expect((await r.complete("extract", req)).text).toBe("hosted");
    expect((await r.complete("extract", req)).text).toBe("hosted");
    expect(local.calls.length).toBe(1);
    expect(r.describe("extract").map((x) => x.downUntil !== undefined)).toEqual([true, false]);
  });

  it("treats a thrown non-provider error (fetch TypeError) as a connection failure", async () => {
    const local = fakeProvider("local", () => {
      throw new TypeError("fetch failed");
    });
    const { r } = clocked([{ provider: "local", model: "m" }], [local.provider]);
    await r.complete("extract", req).catch(() => undefined);
    await r.complete("extract", req).catch(() => undefined);
    expect(local.calls.length).toBe(1);
  });

  it("does not trip on errors from a server that answered", async () => {
    const limited = fakeProvider("local", () => {
      throw new ModelProviderError({ message: "slow down", code: "RATE_LIMITED", retryable: true, provider: "local", status: 429 });
    });
    const { r } = clocked([{ provider: "local", model: "m" }], [limited.provider]);
    await r.complete("extract", req).catch(() => undefined);
    await r.complete("extract", req).catch(() => undefined);
    expect(limited.calls.length).toBe(2);
    expect(r.describe("extract")[0]!.downUntil).toBeUndefined();
  });

  it("honours policy.cooldownMs, and 0 disables the breaker", async () => {
    const a = fakeProvider("local", refused);
    const short = clocked([{ provider: "local", model: "m" }], [a.provider], { cooldownMs: 1000 });
    await short.r.complete("extract", req).catch(() => undefined);
    short.advance(1000);
    await short.r.complete("extract", req).catch(() => undefined);
    expect(a.calls.length).toBe(2);

    const b = fakeProvider("local", refused);
    const off = clocked([{ provider: "local", model: "m" }], [b.provider], { cooldownMs: 0 });
    await off.r.complete("extract", req).catch(() => undefined);
    await off.r.complete("extract", req).catch(() => undefined);
    expect(b.calls.length).toBe(2);
  });
});
