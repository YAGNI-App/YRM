// A complete yrm.config.ts. `yrm init` writes a smaller one; copy what you need from here.
import { defineConfig } from "@yrm/core";

export default defineConfig({
  tenant: {
    id: "local",
    name: "Jack",
    // Participants with these addresses, or at these domains, are "you".
    selfAddresses: ["jack@yagni.example"],
    selfDomains: ["yagni.example"],
    timezone: "America/Denver",
  },

  // Relative paths resolve against this file's directory.
  storage: { driver: "sqlite", path: ".yrm/local/yrm.sqlite" },

  models: {
    // Tier -> fallback chain. The router tries each hop in order and moves on
    // when a provider is unreachable, unconfigured or refuses.
    routes: {
      triage: [
        { provider: "openai-compatible", model: "qwen3:8b" },
        { provider: "anthropic", model: "claude-haiku-4-5" },
      ],
      extract: [
        { provider: "openai-compatible", model: "qwen3:8b" },
        // { provider: "openrouter", model: "qwen/qwen3-235b-a22b", pricing: { input: 0.2, output: 0.6 } },
        { provider: "anthropic", model: "claude-sonnet-5" },
      ],
      synthesize: [{ provider: "anthropic", model: "claude-opus-5" }],
      // embed: [{ provider: "openai-compatible", model: "nomic-embed-text" }],
    },
    // Refuse model calls once this month's spend reaches the budget.
    monthlyBudgetUsd: 20,
    // Only use models marked local (loopback endpoints count as local).
    // localOnly: true,
  },

  // Provider settings, keyed by the provider name routes use. The CLI hands
  // `providers.anthropic` to @yrm/provider-anthropic and
  // `providers["openai-compatible"]` to @yrm/provider-openai. Any other key
  // registers an extra OpenAI-compatible endpoint under that name.
  providers: {
    // Ollama's default. vLLM, llama.cpp, LM Studio and hosted gateways work the same way.
    "openai-compatible": { baseUrl: "http://localhost:11434/v1" },
    // Keys come from the environment; `apiKey` also works but keeps the key in this file.
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
    // openrouter: {
    //   baseUrl: "https://openrouter.ai/api/v1",
    //   apiKeyEnv: "OPENROUTER_API_KEY",
    //   headers: { "HTTP-Referer": "https://yrm.app", "X-Title": "YRM" },
    // },
  },

  // Extensions beyond the built-ins (@yrm/ext-mail, -calendar, -notes,
  // -resolve, -extract, -attention, -mcp), which load automatically when
  // installed. `.yrm/extensions/*.ts` and `~/.yrm/extensions/*.ts` load too.
  extensions: [
    // "./extensions/my-ranker.ts",
  ],
  // Turn off a built-in or discovered extension by name.
  disable: [
    // "ext-mcp",
  ],

  // Extension-scoped settings, keyed by extension name. Read with `yrm.config.get()`.
  // For providers, keys here override the matching `providers` entry, e.g.
  // settings["provider-anthropic"] overrides providers.anthropic.
  settings: {
    // "ext-attention": { quietAfterDays: 21 },
  },
});
