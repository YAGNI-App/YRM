# 0005. Route models by tier with provider-agnostic BYOK adapters

Date: 2026-10-04
Status: accepted

## Context

YRM calls models for different jobs with very different cost and quality needs. Deciding whether a message contains a commitment is a few booleans; a small model does it. Extracting facts with quotes and spans from a thread needs a stronger model. Re-ranking the day's attention queue and writing reasons is one call a day where quality matters most.

Model names and prices change every few months. If extractors name a model, every model change is a code change across many packages. Some users want everything local for privacy; some want the cheapest hosted option; some have a company contract with one provider. A self-hosted project cannot pick one provider for them, and cannot pay for their usage.

Most hosted and local inference servers now speak the OpenAI chat completions protocol: vLLM, Ollama, llama.cpp's server, Together, Fireworks, Groq, DeepSeek and OpenRouter. Open-weight models in the 8B to 70B range are good enough for triage and much of extraction.

## Decision

Code asks for a tier, never a model. Config maps each tier to an ordered fallback chain of `{provider, model}`. Providers are extensions. Users bring their own keys.

Specifics, as in `packages/core/src/contracts/models.ts`:

- Tiers: `triage`, `extract`, `synthesize`, `embed`. Extensions may define more.
- Core ships two providers: `anthropic` and `openai-compatible`. The second covers every server listed above through `baseUrl`. OpenRouter is a `baseUrl`, not a dependency.
- Nothing outside `packages/provider-*` imports a provider SDK.
- The router records usage and cost per call in `model_calls`, enforces `maxCostUsd` per request and `monthlyBudgetUsd` per tenant, honors `localOnly`, and falls through the chain on failure.
- `model:before` and `model:after` hooks let extensions log, cache, redact or block calls.
- Open-weight models are first-class: defaults prefer a reachable local model for `triage` and `extract`.
- With no provider configured, YRM degrades to rule extractors and rule rankers. It does not crash.

## Consequences

Easier: switching models is a config change. A user can run fully local with `localOnly: true` and know nothing leaves the machine. Budget enforcement lives in one place.

Harder: the lowest common denominator. Features that only one provider has (specific caching semantics, batch APIs, extended reasoning controls) have to be expressed as optional hints like `cacheKey` or handled inside the provider package. Structured output support varies; the `openai-compatible` adapter must validate JSON itself because some servers ignore the schema. Prices for custom endpoints are unknown, so cost tracking depends on users filling in `pricing` on the route. Extractor quality now depends on whatever model the user configured; prompts must be tested against at least one small open-weight model and one frontier model, and bug reports need the resolved route to be reproducible.

Given up: tuning prompts for one model family. We accept somewhat worse extraction on any given model in exchange for portability.

BYOK means we cannot offer a free hosted tier funded by our keys, and users carry the setup cost of getting a key or running a local server. `yrm doctor` has to make that setup obvious.

## Alternatives considered

- **Name models in code.** Simplest, and breaks on every model release.
- **Depend on an aggregator (OpenRouter, LiteLLM) as the only path.** One integration, but adds a hop, a dependency and a third party in the data path for users who want local.
- **Use a framework (Vercel AI SDK, LangChain) for provider abstraction.** Broad coverage, but large dependency surface and its own abstractions over ours; a provider package may still use one internally.
- **Ship only local models.** Maximum privacy, but synthesis quality on small models is not yet good enough for the daily ranking.
