import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { WebStandardStreamableHTTPServerTransport } from "@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js";
import { assertBindAllowed, isLoopbackBind, requireAuth, type Auth, type Grant } from "@yrm/ext-auth";
import type { Logger } from "@yrm/core";

export const DEFAULT_HTTP_PORT = 7788;
export const DEFAULT_HTTP_HOST = "127.0.0.1";
export const MCP_PATH = "/mcp";
export const HEALTH_PATH = "/healthz";

export interface HttpServeOptions {
  auth: Auth;
  log: Logger;
  /** A fresh, unconnected server whose tools run as `grant`. Called once per request. */
  serverFor(grant: Grant): McpServer;
  /** Who loopback callers act as when the loopback bypass is on. */
  localPrincipal: string;
  /** Default 7788; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  hostname?: string;
}

export interface RunningHttp {
  server: ReturnType<typeof Bun.serve>;
  /** The MCP endpoint, e.g. http://127.0.0.1:7788/mcp. */
  url: string;
  stop(): Promise<void>;
}

const LOOPBACK_HOSTS = new Set(["localhost", "127.0.0.1", "[::1]"]);

function hostOnly(hostHeader: string): string {
  const h = hostHeader.toLowerCase();
  if (h.startsWith("[")) return h.slice(0, h.indexOf("]") + 1);
  return h.split(":")[0] ?? "";
}

/**
 * DNS rebinding defense for a loopback bind: a web page at evil.example that
 * re-resolves to 127.0.0.1 would otherwise ride the loopback bypass. Its
 * requests carry `Host: evil.example` and a foreign `Origin`, so both are
 * checked. Non-browser clients send no Origin.
 */
function rebindingRefused(req: Request, loopbackBind: boolean): string | null {
  if (!loopbackBind) return null;
  const host = req.headers.get("host");
  if (!host) return "missing Host header";
  const name = hostOnly(host);
  if (!LOOPBACK_HOSTS.has(name) && !name.startsWith("127.")) return `Host ${name} is not a loopback name`;
  const origin = req.headers.get("origin");
  if (origin) {
    try {
      const o = new URL(origin).hostname;
      if (!LOOPBACK_HOSTS.has(o) && !LOOPBACK_HOSTS.has(`[${o}]`) && !o.startsWith("127.")) return `Origin ${origin} is not local`;
    } catch {
      return "malformed Origin";
    }
  }
  return null;
}

function json(status: number, body: unknown, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", ...headers } });
}

/**
 * MCP over Streamable HTTP on `Bun.serve`. Stateless: every POST gets its own
 * transport and server (the SDK refuses to reuse a stateless transport), so
 * each request runs with exactly the principal and scopes its token grants.
 * Responses are plain JSON; there is no standalone SSE stream, so GET and
 * DELETE on /mcp answer 405 as the spec allows.
 */
export function serveHttp(opts: HttpServeOptions): RunningHttp {
  const hostname = opts.hostname ?? DEFAULT_HTTP_HOST;
  assertBindAllowed(hostname, opts.auth, "yrm serve --http");
  const loopbackBind = isLoopbackBind(hostname);

  const handleMcp = async (req: Request, grant: Grant): Promise<Response> => {
    if (req.method !== "POST") {
      return json(405, { jsonrpc: "2.0", error: { code: -32000, message: "Method not allowed: this server is stateless; POST JSON-RPC to /mcp." }, id: null }, { allow: "POST" });
    }
    // No sessionIdGenerator: stateless mode.
    const transport = new WebStandardStreamableHTTPServerTransport({ enableJsonResponse: true });
    const server = opts.serverFor(grant);
    try {
      await server.connect(transport);
      // authInfo.token is the token's name: the secret never travels past this point.
      return await transport.handleRequest(req, {
        authInfo: { token: grant.tokenName ?? grant.via, clientId: grant.principal, scopes: grant.scopes },
      });
    } finally {
      await server.close();
    }
  };

  let server: ReturnType<typeof Bun.serve>;
  const peer = (req: Request): string | null => server.requestIP(req)?.address ?? null;
  const guarded = requireAuth(opts.auth, handleMcp, { peer, localPrincipal: opts.localPrincipal });

  server = Bun.serve({
    port: opts.port ?? DEFAULT_HTTP_PORT,
    hostname,
    async fetch(req) {
      const url = new URL(req.url);
      if (url.pathname === HEALTH_PATH && (req.method === "GET" || req.method === "HEAD")) return json(200, { ok: true });
      if (url.pathname !== MCP_PATH) return json(404, { error: { code: "NOT_FOUND", message: `MCP lives at ${MCP_PATH}` } });
      const refused = rebindingRefused(req, loopbackBind);
      if (refused) {
        opts.log.warn("mcp http request refused", { reason: refused });
        return json(403, { error: { code: "FORBIDDEN", message: refused } });
      }
      try {
        const res = await guarded(req);
        if (res.status === 401 || res.status === 403) opts.log.warn("mcp http auth refused", { status: res.status });
        return res;
      } catch (err) {
        opts.log.error("mcp http request failed", { error: err instanceof Error ? err.message : String(err) });
        return json(500, { jsonrpc: "2.0", error: { code: -32603, message: "Internal error" }, id: null });
      }
    },
  });
  const shown = hostname.includes(":") ? `[${hostname}]` : hostname;
  return {
    server,
    url: `http://${shown}:${server.port}${MCP_PATH}`,
    async stop() {
      await server.stop(true);
    },
  };
}
