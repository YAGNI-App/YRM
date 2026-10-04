# @yrm/provider-anthropic

YRM model provider for the Anthropic Messages API. Registers a provider named `anthropic`.

## Config

```ts
// yrm.config.ts
export default defineConfig({
  // ...
  models: {
    routes: {
      triage: [{ provider: "anthropic", model: "claude-haiku-4-5" }],
      extract: [{ provider: "anthropic", model: "claude-sonnet-5" }],
      synthesize: [{ provider: "anthropic", model: "claude-opus-5" }],
      embed: [],
    },
  },
  providers: {
    anthropic: { apiKeyEnv: "ANTHROPIC_API_KEY" },
  },
});
```

| Setting | Default | Notes |
|---|---|---|
| `apiKeyEnv` | `ANTHROPIC_API_KEY` | Environment variable holding the key. |
| `apiKey` | | Literal key. Prefer `apiKeyEnv`. |
| `baseUrl` | SDK default | For proxies and gateways. |
| `maxRetries` | SDK default (2) | Retries inside the SDK before the router falls through to the next hop. |
| `timeoutMs` | SDK default | |
| `thinking` | `"adaptive"` | `"omit"` to leave thinking to the model's default. Thinking tokens count against `maxTokens`. |

With no key configured the provider raises a retryable `NOT_CONFIGURED` error, so a tier chain that ends in a local model keeps working.

## Behavior

- `schema` on a request becomes `output_config.format` (`json_schema`), so the reply is constrained JSON and `json` is set on the response.
- `cacheKey` marks the system prompt with `cache_control: ephemeral`. Cache read and write tokens are reported in `usage`.
- `temperature` is dropped for models that reject sampling parameters (Opus 5, Sonnet 5 and later).
- Models: `models()` returns the Anthropic ids in `@yrm/core`'s price table with their list prices. Any other model id can still be routed to; set `route.pricing` for it.
- Errors: 429, 5xx, connection errors, timeouts and refusals are retryable (the router tries the next hop); 400, 401, 403 and 404 are not.
