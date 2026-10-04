// Config for the Acme demo tenant. From this directory:
//   bun run ../../packages/cli/src/main.ts import .
//   bun run ../../packages/cli/src/main.ts today --date 2026-10-03
// Matches the `tenant` block in ground-truth.json. Everything here is fictional.
import { defineConfig } from "@yrm/core";

export default defineConfig({
  tenant: {
    id: "local",
    name: "YAGNI",
    // Jack is the tenant's user. Dana shares the domain, so selfDomains marks her as "us" too.
    selfAddresses: ["jack@yagni.example"],
    selfDomains: ["yagni.example"],
    timezone: "America/Denver",
  },

  // Relative to this file. fixtures/acme/.yrm/ is gitignored.
  storage: { driver: "sqlite", path: ".yrm/local/yrm.sqlite" },

  // The same routes `yrm init` writes. With no local model and no API keys the
  // demo still runs on rule-based extraction.
  models: {
    routes: {
      triage: [{ provider: "openai-compatible", model: "qwen3:8b" }],
      extract: [{ provider: "openai-compatible", model: "qwen3:8b" }],
      synthesize: [{ provider: "anthropic", model: "claude-opus-5" }],
    },
  },

  providers: {
    "openai-compatible": { baseUrl: "http://localhost:11434/v1" },
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
  },

  settings: {
    resolve: {
      // The corpus's stand-in for gmail.com: an address there says nothing about employment.
      freemailDomains: ["mailhub.example"],
      selfOrgName: "YAGNI",
    },
    // Views (ADR 0010): fields described in English, applied at startup.
    // `yrm view backfill <name>` fills them from facts and recent mail on the
    // extract tier; with no reachable model `yrm view show` says so. The
    // built-in rule views last_contact and open_items need no definition.
    views: {
      definitions: [
        {
          name: "economic_buyer",
          appliesTo: "organization",
          valueType: "entity",
          populatedBy: "model",
          description:
            "The person at this organization who controls the budget for our deal; usually the one who approves pricing or signs.",
        },
        {
          name: "deal_stage",
          appliesTo: "organization",
          valueType: "enum",
          enumValues: ["discovery", "evaluation", "security_review", "pilot", "closed_won", "closed_lost", "stalled"],
          populatedBy: "model",
          description: "Where our commercial conversation with this organization stands.",
        },
        {
          name: "champion",
          appliesTo: "organization",
          valueType: "entity",
          populatedBy: "model",
          description: "The person at this organization who pushes for our product internally and keeps the deal moving.",
        },
        {
          name: "risk_summary",
          appliesTo: "organization",
          valueType: "string",
          populatedBy: "model",
          description: "The biggest risk to our deal with this organization, in at most 25 words. Null if nothing points to a risk.",
        },
      ],
    },
  },
});
