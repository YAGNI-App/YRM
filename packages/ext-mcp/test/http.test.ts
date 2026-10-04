import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import type { Transport } from "@modelcontextprotocol/sdk/shared/transport.js";
import { createHost, silentLogger, SqliteStore, type Entity, type Host, type YrmConfig } from "@yrm/core";
import { hasScope, loadTokens, type Auth } from "@yrm/ext-auth";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { createMcpExtension, createServerForHost, manifest, serveHttp, type RunningHttp } from "../src/index.ts";

const RW = "rw-secret-0123456789abcdef";
const RO = "ro-secret-0123456789abcdef";

const config: YrmConfig = {
  tenant: { id: "local", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} },
};

let store: SqliteStore;
let host: Host;
let marcus: Entity;
let running: RunningHttp;

async function start(auth: Auth): Promise<RunningHttp> {
  return serveHttp({
    auth,
    log: silentLogger,
    port: 0,
    localPrincipal: "user:local",
    serverFor: (grant) => createServerForHost(host, { principal: grant.principal, canWrite: hasScope(grant, "write") }),
  });
}

async function connect(url: string, token?: string): Promise<Client> {
  const client = new Client({ name: "http-test", version: "0.0.0" });
  const opts = token ? { requestInit: { headers: { authorization: `Bearer ${token}` } } } : {};
  // The SDK's own types disagree under exactOptionalPropertyTypes (sessionId?: string vs string | undefined).
  await client.connect(new StreamableHTTPClientTransport(new URL(url), opts) as Transport);
  return client;
}

function payload(res: unknown): Record<string, unknown> {
  const content = (res as { content: Array<{ text: string }> }).content;
  return JSON.parse(content[0]!.text) as Record<string, unknown>;
}

beforeAll(async () => {
  store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  await host.use(createMcpExtension({ host }), manifest);
  marcus = await store.createEntity({ kind: "person", name: "Marcus Bell", identifiers: [], status: "proposed" });
  const auth = await loadTokens(store, {
    allowLoopback: false,
    tokens: [
      { name: "rw", token: RW, principal: "user:jack", scopes: ["read", "write"] },
      { name: "ro", token: RO, principal: "agent:yagni/bailey", scopes: ["read"] },
    ],
  });
  running = await start(auth);
});

afterAll(async () => {
  await running.stop();
  await store.close();
});

describe("serve --http", () => {
  it("answers /healthz without a token", async () => {
    const res = await fetch(running.url.replace(/\/mcp$/, "/healthz"));
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true });
  });

  it("lists tools and searches entities with a bearer token", async () => {
    const client = await connect(running.url, RW);
    const { tools } = await client.listTools();
    expect(tools.map((t) => t.name)).toContain("yrm_search_entities");
    const found = payload(await client.callTool({ name: "yrm_search_entities", arguments: { query: "Marcus" } }));
    expect(JSON.stringify(found)).toContain(marcus.id);
    await client.close();
  });

  it("answers 401 without a token or with a wrong one when loopback is not trusted", async () => {
    const init = { jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "x", version: "0" } } };
    const post = (headers: Record<string, string>) =>
      fetch(running.url, {
        method: "POST",
        headers: { "content-type": "application/json", accept: "application/json, text/event-stream", ...headers },
        body: JSON.stringify(init),
      });
    const none = await post({});
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect((await post({ authorization: "Bearer wrong-token-0123456789" })).status).toBe(401);
    expect((await post({ authorization: `Bearer ${RO}` })).status).toBe(200);
    await expect(connect(running.url)).rejects.toThrow();
  });

  it("refuses write tools for a read-only token, even with confirm: true", async () => {
    const client = await connect(running.url, RO);
    const res = await client.callTool({ name: "yrm_confirm_entity", arguments: { id: marcus.id, confirm: true } });
    expect(res.isError).toBe(true);
    expect(JSON.stringify(res.content)).toContain("WRITE_SCOPE_REQUIRED");
    expect((await store.getEntity(marcus.id))?.status).toBe("proposed");
    await client.close();
  });

  it("runs writes as the token's principal", async () => {
    const client = await connect(running.url, RW);
    const res = await client.callTool({ name: "yrm_confirm_entity", arguments: { id: marcus.id, confirm: true } });
    expect(res.isError).toBeFalsy();
    expect(payload(res)["by"]).toBe("user:jack");
    await client.close();
  });

  it("lets loopback callers in without a token by default", async () => {
    const open = await start(await loadTokens(store, {}));
    try {
      const client = await connect(open.url);
      const { tools } = await client.listTools();
      expect(tools.length).toBeGreaterThan(0);
      await client.close();
      // A browser page that rebinds its name to 127.0.0.1 is still refused.
      const rebind = await fetch(open.url, { method: "POST", headers: { origin: "http://evil.example", "content-type": "application/json" }, body: "{}" });
      expect(rebind.status).toBe(403);
    } finally {
      await open.stop();
    }
  });

  it("refuses a non-loopback bind without a token", async () => {
    const bare = new SqliteStore({ path: ":memory:" });
    await bare.migrate();
    const empty = await loadTokens(bare, {});
    expect(() => serveHttp({ auth: empty, log: silentLogger, port: 0, hostname: "0.0.0.0", localPrincipal: "user:local", serverFor: () => createServerForHost(host) })).toThrow(
      /without a token/,
    );
    await bare.close();
  });
});
