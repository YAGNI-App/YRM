import { describe, expect, it } from "bun:test";
import Anthropic from "@anthropic-ai/sdk";
import { ModelProviderError, type ExtensionAPI, type ModelProvider } from "@yrm/core";
import anthropicProvider, {
  AnthropicProvider,
  buildMessageParams,
  mapAnthropicError,
  type MessagesClient,
} from "./index.ts";

function message(overrides: Partial<Anthropic.Message> = {}): Anthropic.Message {
  return {
    id: "msg_1",
    type: "message",
    role: "assistant",
    model: "claude-sonnet-5",
    content: [{ type: "text", text: '{"relevant":true}', citations: null }],
    stop_reason: "end_turn",
    stop_sequence: null,
    usage: {
      input_tokens: 120,
      output_tokens: 30,
      cache_read_input_tokens: 1000,
      cache_creation_input_tokens: 50,
    },
    ...overrides,
  } as Anthropic.Message;
}

function fakeClient(reply: () => Anthropic.Message | Promise<Anthropic.Message>) {
  const calls: Anthropic.MessageCreateParamsNonStreaming[] = [];
  const client: MessagesClient = {
    messages: {
      async create(params) {
        calls.push(params);
        return reply();
      },
    },
  };
  return { client, calls };
}

describe("buildMessageParams", () => {
  it("hoists system turns, maps roles and sets structured output", () => {
    const params = buildMessageParams("claude-sonnet-5", {
      system: "You extract facts.",
      messages: [
        { role: "system", content: "Be terse." },
        { role: "user", content: "hi" },
        { role: "assistant", content: "hello" },
      ],
      schema: { type: "object", required: ["relevant"] },
      maxTokens: 512,
      temperature: 0.2,
    });
    expect(params.system).toBe("You extract facts.\n\nBe terse.");
    expect(params.messages).toEqual([
      { role: "user", content: "hi" },
      { role: "assistant", content: "hello" },
    ]);
    expect(params.max_tokens).toBe(512);
    expect(params.output_config).toEqual({ format: { type: "json_schema", schema: { type: "object", required: ["relevant"] } } });
    expect(params.thinking).toEqual({ type: "adaptive" });
    // Sonnet 5 rejects sampling parameters.
    expect(params.temperature).toBeUndefined();
  });

  it("keeps temperature and skips adaptive thinking on Haiku 4.5", () => {
    const params = buildMessageParams("claude-haiku-4-5", { messages: [{ role: "user", content: "x" }], temperature: 0 });
    expect(params.temperature).toBe(0);
    expect(params.thinking).toBeUndefined();
    expect(params.output_config).toBeUndefined();
  });

  it("marks the system prompt cacheable when a cacheKey is given", () => {
    const params = buildMessageParams("claude-opus-5", { system: "stable", messages: [{ role: "user", content: "x" }], cacheKey: "k" });
    expect(params.system).toEqual([{ type: "text", text: "stable", cache_control: { type: "ephemeral" } }]);
  });

  it("omits thinking when configured to", () => {
    const params = buildMessageParams("claude-opus-5", { messages: [{ role: "user", content: "x" }] }, { thinking: "omit" });
    expect(params.thinking).toBeUndefined();
  });
});

describe("AnthropicProvider", () => {
  it("completes through the injected client and maps usage", async () => {
    const { client, calls } = fakeClient(() => message());
    const p = new AnthropicProvider({}, { client });
    const res = await p.complete("claude-sonnet-5", { messages: [{ role: "user", content: "x" }], schema: { type: "object" } });
    expect(calls[0]?.model).toBe("claude-sonnet-5");
    expect(res.json).toEqual({ relevant: true });
    expect(res.usage).toEqual({ inputTokens: 120, outputTokens: 30, cacheReadTokens: 1000, cacheWriteTokens: 50 });
    expect(res.provider).toBe("anthropic");
    expect(res.stopReason).toBe("end_turn");
  });

  it("maps a refusal to a retryable error", async () => {
    const { client } = fakeClient(() => message({ stop_reason: "refusal", content: [] }));
    const err = await new AnthropicProvider({}, { client }).complete("claude-opus-5", { messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err).toBeInstanceOf(ModelProviderError);
    expect(err.code).toBe("REFUSAL");
    expect(err.retryable).toBe(true);
  });

  it("reports a missing key as retryable NOT_CONFIGURED", async () => {
    const p = new AnthropicProvider({ apiKeyEnv: "YRM_TEST_NO_SUCH_KEY" }, { env: {} });
    const err = await p.complete("claude-opus-5", { messages: [{ role: "user", content: "x" }] }).catch((e) => e);
    expect(err.code).toBe("NOT_CONFIGURED");
    expect(err.retryable).toBe(true);
  });

  it("lists priced, non-local models with structured output", async () => {
    const models = await new AnthropicProvider({}, { env: {} }).models();
    const sonnet = models.find((m) => m.id === "claude-sonnet-5");
    expect(sonnet?.pricing).toEqual({ input: 2, output: 10, cacheRead: 0.2 });
    expect(models.every((m) => m.supports.structuredOutput && m.supports.local === false)).toBe(true);
  });

  it("registers itself from the extension factory", async () => {
    const registered: ModelProvider[] = [];
    const api = {
      config: { get: () => ({ apiKeyEnv: "X" }), tenantId: "local" },
      registerProvider: (p: ModelProvider) => registered.push(p),
    } as unknown as ExtensionAPI;
    await anthropicProvider(api);
    expect(registered[0]).toBeInstanceOf(AnthropicProvider);
  });
});

describe("mapAnthropicError", () => {
  const status = (s: number) => mapAnthropicError(Anthropic.APIError.generate(s, { error: { message: "x" } }, "x", new Headers())) as ModelProviderError;

  it("marks 429, 5xx and overloaded as retryable", () => {
    expect(status(429).code).toBe("RATE_LIMITED");
    expect(status(429).retryable).toBe(true);
    expect(status(500).retryable).toBe(true);
    expect(status(529).retryable).toBe(true);
  });

  it("marks 400 and auth failures as non-retryable", () => {
    expect(status(400).retryable).toBe(false);
    expect(status(401).code).toBe("AUTH");
    expect(status(401).retryable).toBe(false);
  });

  it("maps connection errors and timeouts", () => {
    const net = mapAnthropicError(new Anthropic.APIConnectionError({ message: "reset" })) as ModelProviderError;
    expect([net.code, net.retryable]).toEqual(["NETWORK", true]);
    const timeout = mapAnthropicError(new Anthropic.APIConnectionTimeoutError()) as ModelProviderError;
    expect([timeout.code, timeout.retryable]).toEqual(["TIMEOUT", true]);
  });

  it("passes aborts through untouched", () => {
    const abort = new Anthropic.APIUserAbortError();
    expect(mapAnthropicError(abort)).toBe(abort);
  });
});
