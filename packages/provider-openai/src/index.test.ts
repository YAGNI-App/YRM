import { afterAll, beforeEach, describe, expect, it } from "bun:test";
import { ModelProviderError, Router, type ExtensionAPI, type ModelProvider } from "@yrm/core";
import openAICompatibleProvider, { OpenAICompatibleProvider, isLoopback } from "./index.ts";

interface Seen {
  method: string;
  path: string;
  headers: Headers;
  body: Record<string, unknown> | undefined;
}

type Reply = (seen: Seen) => Response;

const seen: Seen[] = [];
let replies: Reply[] = [];

const server = Bun.serve({
  port: 0,
  async fetch(request) {
    const url = new URL(request.url);
    const text = await request.text();
    const entry: Seen = {
      method: request.method,
      path: url.pathname,
      headers: request.headers,
      body: text ? (JSON.parse(text) as Record<string, unknown>) : undefined,
    };
    seen.push(entry);
    const reply = replies.shift();
    return reply ? reply(entry) : new Response("no reply queued", { status: 500 });
  },
});
const baseUrl = `http://127.0.0.1:${server.port}/v1`;

afterAll(() => server.stop(true));
beforeEach(() => {
  seen.length = 0;
  replies = [];
});

const chat = (content: string, extra: Record<string, unknown> = {}): Reply => () =>
  Response.json({
    model: "served-model",
    choices: [{ message: { role: "assistant", content }, finish_reason: "stop" }],
    usage: { prompt_tokens: 100, completion_tokens: 20, prompt_tokens_details: { cached_tokens: 40 } },
    ...extra,
  });

describe("OpenAICompatibleProvider.complete", () => {
  it("sends a chat completion with system, auth, headers and json_schema", async () => {
    replies.push(chat('{"relevant":true}'));
    const p = new OpenAICompatibleProvider(
      { baseUrl, apiKeyEnv: "TEST_KEY", headers: { "x-title": "yrm" } },
      { env: { TEST_KEY: "sk-test" } },
    );
    const res = await p.complete("qwen3-8b", {
      system: "Extract.",
      messages: [{ role: "user", content: "hi" }],
      schema: { type: "object", required: ["relevant"] },
      maxTokens: 64,
      temperature: 0,
    });

    const req = seen[0]!;
    expect(req.method).toBe("POST");
    expect(req.path).toBe("/v1/chat/completions");
    expect(req.headers.get("authorization")).toBe("Bearer sk-test");
    expect(req.headers.get("x-title")).toBe("yrm");
    expect(req.body).toEqual({
      model: "qwen3-8b",
      messages: [
        { role: "system", content: "Extract." },
        { role: "user", content: "hi" },
      ],
      max_tokens: 64,
      temperature: 0,
      response_format: {
        type: "json_schema",
        json_schema: { name: "result", schema: { type: "object", required: ["relevant"] }, strict: true },
      },
    });
    expect(res.json).toEqual({ relevant: true });
    expect(res.usage).toEqual({ inputTokens: 60, outputTokens: 20, cacheReadTokens: 40 });
    expect(res.model).toBe("served-model");
    expect(res.provider).toBe("openai-compatible");
    expect(res.stopReason).toBe("stop");
  });

  it("sends no authorization header when no key is configured", async () => {
    replies.push(chat("hello"));
    await new OpenAICompatibleProvider({ baseUrl }, { env: {} }).complete("m", { messages: [{ role: "user", content: "x" }] });
    expect(seen[0]!.headers.get("authorization")).toBeNull();
    expect(seen[0]!.body?.["response_format"]).toBeUndefined();
  });

  it("falls back to json_object with the schema in the prompt when json_schema is rejected", async () => {
    replies.push(() => Response.json({ error: { message: "response_format json_schema unsupported" } }, { status: 400 }));
    replies.push(chat('```json\n{"relevant": false}\n```'));
    const p = new OpenAICompatibleProvider({ baseUrl }, { env: {} });
    const res = await p.complete("m", {
      system: "Extract.",
      messages: [{ role: "user", content: "hi" }],
      schema: { type: "object", required: ["relevant"] },
    });
    expect(seen.length).toBe(2);
    expect(seen[1]!.body?.["response_format"]).toEqual({ type: "json_object" });
    const messages = seen[1]!.body?.["messages"] as Array<{ role: string; content: string }>;
    expect(messages[0]!.role).toBe("system");
    expect(messages[0]!.content).toStartWith("Extract.\n\n");
    expect(messages[0]!.content).toContain('"required":["relevant"]');
    expect(res.json).toEqual({ relevant: false });
  });

  it("does not retry a 400 when no schema was requested", async () => {
    replies.push(() => Response.json({ error: { message: "bad model" } }, { status: 400 }));
    const err = await new OpenAICompatibleProvider({ baseUrl }, { env: {} })
      .complete("m", { messages: [{ role: "user", content: "x" }] })
      .catch((e) => e);
    expect(seen.length).toBe(1);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect([err.code, err.retryable, err.status]).toEqual(["BAD_REQUEST", false, 400]);
    expect(err.message).toContain("bad model");
  });

  it("maps 429 and 5xx to retryable and 401 to non-retryable", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl }, { env: {} });
    const call = () => p.complete("m", { messages: [{ role: "user", content: "x" }] }).then(
        () => {
          throw new Error("expected a failure");
        },
        (e: unknown) => e as ModelProviderError,
      );
    replies.push(() => new Response("slow down", { status: 429 }));
    expect((await call()).retryable).toBe(true);
    replies.push(() => new Response("oops", { status: 503 }));
    expect((await call()).code).toBe("SERVER_ERROR");
    replies.push(() => Response.json({ error: "invalid key" }, { status: 401 }));
    const auth = await call();
    expect([auth.code, auth.retryable]).toEqual(["AUTH", false]);
  });

  it("maps an unreachable server to a retryable NETWORK error", async () => {
    const p = new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1" }, { env: {} });
    const err = await p.complete("m", { messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect([err.code, err.retryable]).toEqual(["NETWORK", true]);
  });

  it("lets the router fall through to it after a hosted hop fails", async () => {
    // The router asks for model metadata before the first call.
    replies.push(() => Response.json({ data: [{ id: "m" }] }));
    replies.push(chat("local answer"));
    const failing: ModelProvider = {
      name: "hosted",
      models: async () => [],
      complete: async () => {
        throw new ModelProviderError({ message: "down", code: "SERVER_ERROR", retryable: true, provider: "hosted", status: 502 });
      },
    };
    const local = new OpenAICompatibleProvider({ baseUrl }, { env: {} });
    const router = new Router({
      policy: { routes: { triage: [{ provider: "hosted", model: "x" }, { provider: "openai-compatible", model: "m" }] } as never },
      providers: new Map<string, ModelProvider>([["hosted", failing], [local.name, local]]),
    });
    expect((await router.complete("triage", { messages: [{ role: "user", content: "x" }] })).text).toBe("local answer");
  });
});

describe("OpenAICompatibleProvider.embed and models", () => {
  it("embeds via /embeddings in input order", async () => {
    replies.push(() =>
      Response.json({
        model: "nomic-embed-text",
        data: [
          { index: 1, embedding: [0, 1] },
          { index: 0, embedding: [1, 0] },
        ],
        usage: { prompt_tokens: 7 },
      }),
    );
    const res = await new OpenAICompatibleProvider({ baseUrl }, { env: {} }).embed("nomic-embed-text", { inputs: ["a", "b"] });
    expect(seen[0]!.path).toBe("/v1/embeddings");
    expect(seen[0]!.body).toEqual({ model: "nomic-embed-text", input: ["a", "b"] });
    expect(res.vectors).toEqual([[1, 0], [0, 1]]);
    expect(res.dimensions).toBe(2);
    expect(res.usage.inputTokens).toBe(7);
  });

  it("lists models and marks them local for loopback hosts", async () => {
    replies.push(() => Response.json({ data: [{ id: "qwen3-8b" }, { id: "nomic-embed-text" }] }));
    const models = await new OpenAICompatibleProvider({ baseUrl }, { env: {} }).models();
    expect(seen[0]!.method).toBe("GET");
    expect(seen[0]!.path).toBe("/v1/models");
    expect(models.map((m) => [m.id, m.supports.local, m.supports.embeddings])).toEqual([
      ["qwen3-8b", true, false],
      ["nomic-embed-text", true, true],
    ]);
  });

  it("honors an explicit local flag and returns [] when listing fails", async () => {
    replies.push(() => new Response("nope", { status: 404 }));
    const p = new OpenAICompatibleProvider({ baseUrl, local: false }, { env: {} });
    expect(p.local).toBe(false);
    expect(await p.models()).toEqual([]);
    expect(await new OpenAICompatibleProvider({ baseUrl: "http://127.0.0.1:1/v1" }, { env: {} }).models()).toEqual([]);
  });

  it("detects loopback hosts", () => {
    expect(isLoopback("http://localhost:11434/v1")).toBe(true);
    expect(isLoopback("http://127.0.0.1:8000/v1")).toBe(true);
    expect(isLoopback("https://openrouter.ai/api/v1")).toBe(false);
  });
});

describe("extension factory", () => {
  it("registers a provider configured from yrm.config", async () => {
    const registered: ModelProvider[] = [];
    const api = {
      config: { get: () => ({ name: "groq", baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" }), tenantId: "local" },
      registerProvider: (p: ModelProvider) => registered.push(p),
    } as unknown as ExtensionAPI;
    await openAICompatibleProvider(api);
    const p = registered[0] as OpenAICompatibleProvider;
    expect(p.name).toBe("groq");
    expect(p.local).toBe(false);
    expect(p.baseUrl).toBe("https://api.groq.com/openai/v1");
  });
});
