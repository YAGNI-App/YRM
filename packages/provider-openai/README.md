# @yrm/provider-openai

YRM model provider for any OpenAI-compatible `/chat/completions` and `/embeddings` endpoint. No SDK; plain `fetch`. Registers a provider named `openai-compatible` unless you give it another `name`.

One adapter covers local servers (Ollama, vLLM, llama.cpp, LM Studio) and hosted gateways (OpenRouter, Together, Groq, Fireworks, DeepSeek). Each is just a `baseUrl` and, for hosted ones, the environment variable that holds the key.

## Config

| Setting | Default | Notes |
|---|---|---|
| `baseUrl` | `http://localhost:11434/v1` (Ollama) | Up to and including `/v1`. |
| `apiKeyEnv` | | Environment variable holding the key. Sent as `Authorization: Bearer`. Omit for servers that need none. |
| `apiKey` | | Literal key. Prefer `apiKeyEnv`. |
| `headers` | | Extra headers on every request. |
| `local` | `true` for localhost / 127.0.0.1, else `false` | Marks models as running on hardware you control. The router's `localOnly` policy only allows local models. |
| `name` | `openai-compatible` | Provider name routes refer to. |
| `timeoutMs` | | Per-request timeout. |

### Ollama

```ts
providers: { "openai-compatible": { baseUrl: "http://localhost:11434/v1" } },
models: { routes: { triage: [{ provider: "openai-compatible", model: "qwen3:8b" }], embed: [{ provider: "openai-compatible", model: "nomic-embed-text" }] } },
```

### vLLM

```ts
providers: { "openai-compatible": { baseUrl: "http://localhost:8000/v1" } },
// vllm serve Qwen/Qwen3-8B --port 8000; route with model: "Qwen/Qwen3-8B"
```

If vLLM runs on another machine you control, set `local: true` explicitly.

### OpenRouter

```ts
providers: { "openai-compatible": { baseUrl: "https://openrouter.ai/api/v1", apiKeyEnv: "OPENROUTER_API_KEY" } },
```

### Together

```ts
providers: { "openai-compatible": { baseUrl: "https://api.together.xyz/v1", apiKeyEnv: "TOGETHER_API_KEY" } },
```

### Groq

```ts
providers: { "openai-compatible": { baseUrl: "https://api.groq.com/openai/v1", apiKeyEnv: "GROQ_API_KEY" } },
```

### Pricing

Open-weight and gateway prices depend on where the model runs, so this provider reports none. Set `pricing` on the route (USD per million tokens) if you want `maxCostUsd`, `monthlyBudgetUsd` and `yrm doctor` to account for it; unpriced routes count as zero cost.

```ts
extract: [{ provider: "openai-compatible", model: "meta-llama/Llama-3.3-70B-Instruct-Turbo", pricing: { input: 0.88, output: 0.88 } }],
```

## Behavior

- Structured output: requests with a `schema` send `response_format: { type: "json_schema", json_schema: { name: "result", schema, strict: true } }`. If the server answers 400, the provider retries once with `response_format: { type: "json_object" }` and the schema described in the system prompt. The text is parsed into `json` (code fences tolerated); the router checks the shape.
- Usage: cached prompt tokens (`prompt_tokens_details.cached_tokens`) are reported as `cacheReadTokens` and excluded from `inputTokens`.
- `models()` lists `GET /models`; if the endpoint is unreachable it returns `[]` and routes can still name models directly.
- Errors: 408, 409, 429, 5xx, connection failures and timeouts are retryable (the router tries the next hop); 400, 401, 403 and 404 are not.
