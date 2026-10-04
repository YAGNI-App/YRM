# @yrm/ext-auth

Authentication for YRM's network surfaces: `yrm web` and `yrm serve --http`. It registers no tools and nothing model-facing, only the `yrm auth` command; `@yrm/ext-web` and `@yrm/ext-mcp` import its helpers. The reasoning is in [ADR 0008](../../docs/decisions/0008-static-bearer-tokens-with-loopback-bypass.md) and [the threat model](../../docs/SECURITY-MODEL.md).

## How a request gets in

1. **Loopback.** A request from 127.0.0.1 or ::1, addressed to `localhost`, `127.x.x.x` or `[::1]`, passes without a token while `allowLoopback` is true (the default). The `Host` check stops a DNS-rebinding page from riding the bypass. It runs as the server's local principal (`settings.web.principal`, `settings.mcp.principal`) with `read` and `write`.
2. **Bearer token.** `Authorization: Bearer <token>`, checked against `settings.auth.tokens` and the tokens `yrm auth token create` stored, in constant time.
3. **Session cookie** (dashboard only). `/login` takes a token and sets `yrm_session`: the token name and an expiry, HMAC-SHA256-signed with a per-install secret kept in kv `auth/secret` and created on first run. The token is looked up again on every request, so revoking it ends its sessions.

Anything else is refused: 401 (or a redirect to `/login` for a page view). A request without the `write` scope cannot write. Servers refuse to bind a non-loopback address while no token exists.

## Tokens

From the command line. The secret is printed once; kv keeps only its SHA-256 under `auth/tokens/<name>`.

```sh
yrm auth token create laptop --principal user:jack --scopes read,write
yrm auth token create bailey --principal agent:yagni/bailey --scopes read
yrm auth token list
yrm auth token revoke bailey
```

Or in config, for CI and containers:

```ts
// yrm.config.ts
settings: {
  auth: {
    tokens: [
      // Prefer tokenEnv: config files get committed and screenshotted.
      { name: "ci", tokenEnv: "YRM_CI_TOKEN", principal: "agent:ci", scopes: ["read"] },
      { name: "jack", token: "at-least-16-characters", principal: "user:jack", scopes: ["read", "write"] },
    ],
    allowLoopback: true, // false behind a reverse proxy on the same host
    sessionHours: 12,
  },
},
```

A principal looks like `user:<name>` or `agent:<name>`. It becomes `origin.by` on facts and `by` on merges and dismissals written with the token.

## API

```ts
import { loadTokens, requireAuth, assertBindAllowed, hasScope } from "@yrm/ext-auth";

const auth = await loadTokens(store, settings.auth);           // Auth
assertBindAllowed("0.0.0.0", auth, "my server");               // throws without a token
const grant = await auth.authenticate(req, peerAddress, "user:jack"); // Grant | null
await auth.verifyBearer(req);                                  // bearer only
auth.issueSession(grant);                                      // Set-Cookie value
const handler = requireAuth(auth, async (req, grant) => new Response(grant.principal), {
  peer: (req) => server.requestIP(req)?.address,
  localPrincipal: "user:jack",
  scope: "read",
});
```

A `Grant` is `{ principal, scopes, via: "loopback" | "token" | "session", tokenName? }`.
