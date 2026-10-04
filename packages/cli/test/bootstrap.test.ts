import { afterEach, describe, expect, test } from "bun:test";
import { silentLogger, type YrmConfig } from "@yrm/core";
import { OpenAICompatibleProvider } from "@yrm/provider-openai";
import { bootstrap, isMissingPackage, RegistryProviderMap, withProviderSettings } from "../src/bootstrap.ts";
import { SqliteUsageSink } from "../src/usage-sink.ts";
import { tempDir, writeConfig } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

const base: YrmConfig = {
  tenant: { id: "local", selfAddresses: [] },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} },
};

describe("withProviderSettings", () => {
  test("copies providers into the provider extensions' settings; settings win", () => {
    const out = withProviderSettings({
      ...base,
      providers: { anthropic: { apiKeyEnv: "A", baseUrl: "x" }, "openai-compatible": { baseUrl: "http://h/v1" }, openrouter: { baseUrl: "https://o/v1" } },
      settings: { "provider-anthropic": { baseUrl: "y" } },
    });
    expect(out.settings?.["provider-anthropic"]).toEqual({ apiKeyEnv: "A", baseUrl: "y" });
    expect(out.settings?.["provider-openai"]).toEqual({ baseUrl: "http://h/v1" });
    expect(out.settings?.["provider-openrouter"]).toEqual({ baseUrl: "https://o/v1", name: "openrouter" });
  });
});

describe("isMissingPackage", () => {
  test("only matches the package itself not being installed", () => {
    const err = (message: string) => Object.assign(new Error(message), { code: "ERR_MODULE_NOT_FOUND" });
    expect(isMissingPackage(err("Cannot find package '@yrm/ext-mail' imported from /x"), "@yrm/ext-mail")).toBe(true);
    expect(isMissingPackage(err("Cannot find package 'mailparser' imported from /ext-mail/src/index.ts"), "@yrm/ext-mail")).toBe(false);
    expect(isMissingPackage(new SyntaxError("Unexpected token"), "@yrm/ext-mail")).toBe(false);
  });
});

describe("bootstrap", () => {
  async function boot(importModule: (spec: string) => Promise<unknown>, builtins = ["@yrm/ext-a", "@yrm/ext-b"], extra = "", extraProviders = "") {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeConfig(dir, extra, extraProviders);
    return bootstrap({ cwd: dir, log: silentLogger, homeDir: null, builtins, importModule });
  }

  test("skips missing builtins, loads present ones, honors disable", async () => {
    const b = await boot(
      async (spec) => {
        if (spec === "@yrm/ext-a") throw Object.assign(new Error(`Cannot find package '${spec}' imported from /x`), { code: "ERR_MODULE_NOT_FOUND" });
        return { default: (yrm: { registerSource: (s: unknown) => void }) => yrm.registerSource({ name: "mail", kinds: [], sync: async () => {} }), manifest: { name: "ext-b" } };
      },
      ["@yrm/ext-a", "@yrm/ext-b", "@yrm/ext-c"],
      `disable: ["ext-c"],`,
      `openrouter: { baseUrl: "https://openrouter.example/api/v1" },`,
    );
    try {
      expect(b.builtins).toEqual([
        { specifier: "@yrm/ext-a", status: "missing" },
        { specifier: "@yrm/ext-b", status: "loaded", name: "ext-b" },
        { specifier: "@yrm/ext-c", status: "disabled" },
      ]);
      expect(b.host.registry.sources.has("mail")).toBe(true);
      expect(b.host.registry.providers.list().map((p) => p.name)).toEqual(["anthropic", "openai-compatible", "openrouter"]);
      const openrouter = b.host.registry.providers.get("openrouter");
      expect(openrouter).toBeInstanceOf(OpenAICompatibleProvider);
      expect((openrouter as OpenAICompatibleProvider).baseUrl).toBe("https://openrouter.example/api/v1");
      expect((b.host.registry.providers.get("openai-compatible") as OpenAICompatibleProvider).baseUrl).toBe("http://127.0.0.1:9/v1");
    } finally {
      await b.host.close();
    }
  });

  test("a builtin that is installed but broken surfaces its error", async () => {
    await expect(
      boot(async () => {
        throw Object.assign(new Error("Cannot find package 'left-pad' imported from /ext-a/src/index.ts"), { code: "ERR_MODULE_NOT_FOUND" });
      }),
    ).rejects.toThrow(/cannot import extension "@yrm\/ext-a".*left-pad/);
  });

  test("the router reaches providers registered after it was built", async () => {
    const b = await boot(async () => ({ default: () => {} }), []);
    try {
      expect(b.host.models.describe("triage")).toEqual([{ provider: "openai-compatible", model: "qwen3:8b" }]);
      // No route for extract: the router reports it rather than crashing the host.
      await expect(b.host.models.complete("extract", { messages: [] })).rejects.toThrow(/no route/);
      // The anthropic hop is registered lazily and fails as unconfigured (no key), not "not registered".
      await expect(b.host.models.complete("synthesize", { messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/no Anthropic API key/);
      expect(await b.host.models.spend()).toEqual({ usd: 0, byTier: {} });
    } finally {
      await b.host.close();
    }
  });

  test("needConfig false boots in memory without a config", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const b = await bootstrap({ cwd: dir, needConfig: false, log: silentLogger, homeDir: null, builtins: [] });
    try {
      expect(b.configFile).toBeNull();
      expect(b.config.storage.path).toBe(":memory:");
    } finally {
      await b.host.close();
    }
  });
});

describe("RegistryProviderMap", () => {
  test("is empty until bound", () => {
    const m = new RegistryProviderMap();
    expect(m.get("anthropic")).toBeUndefined();
    expect(m.has("anthropic")).toBe(false);
  });
});

describe("SqliteUsageSink", () => {
  test("records calls and sums the current month", async () => {
    const calls: unknown[] = [];
    let since = "";
    const sink = new SqliteUsageSink(
      {
        recordModelCall: async (c) => {
          calls.push(c);
          return "id";
        },
        sumModelCost: async (_t, s) => {
          since = s;
          return 1.5;
        },
      },
      () => new Date("2026-10-04T12:00:00Z"),
    );
    await sink.record({
      tenantId: "local",
      tier: "extract",
      kind: "complete",
      provider: "p",
      model: "m",
      at: "2026-10-04T12:00:00.000Z",
      latencyMs: 5,
      usage: { inputTokens: 10, outputTokens: 2, costUsd: 0.01 },
      ok: false,
      errorCode: "SCHEMA_MISMATCH",
    });
    expect(calls[0]).toMatchObject({ tier: "extract", inputTokens: 10, costUsd: 0.01, createdAt: "2026-10-04T12:00:00.000Z", meta: { kind: "complete", ok: false, errorCode: "SCHEMA_MISMATCH" } });
    expect(await sink.monthToDate("local")).toEqual({ usd: 1.5, byTier: {} });
    expect(since).toBe("2026-10-01T00:00:00.000Z");
  });
});
