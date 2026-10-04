import { beforeEach, describe, expect, it } from "bun:test";
import { silentLogger, SqliteStore, type Command, type CommandContext } from "@yrm/core";
import authExtension, {
  assertBindAllowed,
  createStoredToken,
  isLoopbackAddress,
  KV_NAMESPACE,
  loadTokens,
  requireAuth,
  revokeStoredToken,
  safeEqual,
  SESSION_COOKIE,
  sha256,
  type AuthSettings,
} from "../src/index.ts";

const SECRET = "ci-secret-0123456789abcdef";
let store: SqliteStore;

beforeEach(async () => {
  store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
});

function req(headers: Record<string, string> = {}): Request {
  return new Request("http://127.0.0.1:7777/", { headers: { host: "127.0.0.1:7777", ...headers } });
}

describe("safeEqual", () => {
  it("compares equal and unequal strings of any length", () => {
    expect(safeEqual("abc", "abc")).toBe(true);
    expect(safeEqual("abc", "abd")).toBe(false);
    expect(safeEqual("abc", "abcd")).toBe(false);
    expect(safeEqual("", "x")).toBe(false);
  });
});

describe("loopback", () => {
  it("recognizes loopback peers only", () => {
    for (const a of ["127.0.0.1", "127.9.8.7", "::1", "::ffff:127.0.0.1", "[::1]"]) expect(isLoopbackAddress(a)).toBe(true);
    for (const a of ["192.168.1.5", "10.0.0.1", "::ffff:10.0.0.1", "localhost.evil.example", "", null, undefined]) expect(isLoopbackAddress(a)).toBe(false);
  });

  it("bypasses for loopback peers by default and not when allowLoopback is false", async () => {
    const on = await loadTokens(store, {});
    expect((await on.authenticate(req(), "127.0.0.1", "user:jack"))?.principal).toBe("user:jack");
    expect(await on.authenticate(req(), "192.168.1.9", "user:jack")).toBeNull();
    // A rebound name arrives from a loopback peer but is not addressed to one.
    const rebound = new Request("http://evil.example:7777/", { headers: { host: "evil.example:7777" } });
    expect(await on.authenticate(rebound, "127.0.0.1", "user:jack")).toBeNull();
    const off = await loadTokens(store, { allowLoopback: false });
    expect(await off.authenticate(req(), "127.0.0.1", "user:jack")).toBeNull();
  });
});

describe("tokens", () => {
  it("accepts a settings token from the environment", async () => {
    const settings: AuthSettings = { tokens: [{ name: "ci", tokenEnv: "YRM_CI_TOKEN", principal: "agent:ci", scopes: ["read"] }] };
    const auth = await loadTokens(store, settings, { env: { YRM_CI_TOKEN: SECRET } });
    expect(auth.hasTokens()).toBe(true);
    const g = await auth.verifyBearer(req({ authorization: `Bearer ${SECRET}` }));
    expect(g).toEqual({ principal: "agent:ci", scopes: ["read"], via: "token", tokenName: "ci" });
    expect(await auth.verifyBearer(req({ authorization: `Bearer ${SECRET}x` }))).toBeNull();
    expect(await auth.verifyBearer(req())).toBeNull();
  });

  it("skips a settings token whose env var is unset", async () => {
    const auth = await loadTokens(store, { tokens: [{ name: "ci", tokenEnv: "NOPE", principal: "agent:ci", scopes: ["read"] }] }, { env: {}, log: silentLogger });
    expect(auth.hasTokens()).toBe(false);
  });

  it("rejects bad settings", async () => {
    await expect(loadTokens(store, { tokens: [{ name: "x", token: "short", principal: "user:a", scopes: ["read"] }] })).rejects.toThrow(/16 characters/);
    await expect(loadTokens(store, { tokens: [{ name: "x", token: SECRET, principal: "jack", scopes: ["read"] }] })).rejects.toThrow(/principal/);
  });

  it("verifies a kv token by its hash and stores no secret", async () => {
    const { token, record } = await createStoredToken(store, { name: "laptop", principal: "user:jack", scopes: ["read", "write"] });
    expect(record.sha256).toBe(sha256(token));
    expect(JSON.stringify(await store.kvGet(KV_NAMESPACE, "tokens/laptop"))).not.toContain(token);
    const auth = await loadTokens(store, {});
    expect(auth.hasTokens()).toBe(true);
    expect((await auth.verifyToken(token))?.scopes).toEqual(["read", "write"]);
    await revokeStoredToken(store, "laptop");
    expect(await auth.verifyToken(token)).toBeNull();
  });

  it("refuses a non-loopback bind without tokens", async () => {
    const none = await loadTokens(store, {});
    expect(() => assertBindAllowed("0.0.0.0", none, "yrm web")).toThrow(/will not listen on 0.0.0.0/);
    expect(() => assertBindAllowed("127.0.0.1", none, "yrm web")).not.toThrow();
    await createStoredToken(store, { name: "t", principal: "user:jack", scopes: ["read"] });
    const some = await loadTokens(store, {});
    expect(() => assertBindAllowed("0.0.0.0", some, "yrm web")).not.toThrow();
  });
});

describe("sessions", () => {
  it("issues, verifies and expires a signed cookie", async () => {
    let now = new Date("2026-10-01T00:00:00Z");
    const auth = await loadTokens(store, { tokens: [{ name: "web", token: SECRET, principal: "user:jack", scopes: ["read"] }], sessionHours: 1 }, { now: () => now });
    const grant = (await auth.verifyToken(SECRET))!;
    const header = auth.issueSession(grant);
    expect(header).toContain("HttpOnly");
    expect(header).toContain("SameSite=Strict");
    const value = decodeURIComponent(header.split(";")[0]!.slice(SESSION_COOKIE.length + 1));
    expect((await auth.verifySession(value))?.principal).toBe("user:jack");
    const cookieReq = req({ cookie: `${SESSION_COOKIE}=${encodeURIComponent(value)}` });
    expect((await auth.authenticate(cookieReq, "10.0.0.2", "user:x"))?.via).toBe("session");
    // Tampering with the name or expiry breaks the signature.
    expect(await auth.verifySession(value.replace("web.", "admin."))).toBeNull();
    now = new Date("2026-10-01T01:00:01Z");
    expect(await auth.verifySession(value)).toBeNull();
  });

  it("keeps the install secret across loads", async () => {
    const a = await loadTokens(store, { tokens: [{ name: "web", token: SECRET, principal: "user:jack", scopes: ["read"] }] });
    const cookie = a.issueSession((await a.verifyToken(SECRET))!);
    const value = decodeURIComponent(cookie.split(";")[0]!.split("=")[1]!);
    const b = await loadTokens(store, { tokens: [{ name: "web", token: SECRET, principal: "user:jack", scopes: ["read"] }] });
    expect(await b.verifySession(value)).not.toBeNull();
  });
});

describe("requireAuth", () => {
  it("answers 401, 403 and passes the grant through", async () => {
    const auth = await loadTokens(store, { allowLoopback: false, tokens: [{ name: "ro", token: SECRET, principal: "agent:ro", scopes: ["read"] }] });
    const ok = async (_r: Request, g: { principal: string }) => new Response(g.principal);
    const read = requireAuth(auth, ok, { peer: () => "127.0.0.1", localPrincipal: "user:jack" });
    const write = requireAuth(auth, ok, { peer: () => "127.0.0.1", localPrincipal: "user:jack", scope: "write" });
    const none = await read(req());
    expect(none.status).toBe(401);
    expect(none.headers.get("www-authenticate")).toContain("Bearer");
    expect(await (await read(req({ authorization: `Bearer ${SECRET}` }))).text()).toBe("agent:ro");
    expect((await write(req({ authorization: `Bearer ${SECRET}` }))).status).toBe(403);
  });
});

describe("yrm auth command", () => {
  it("creates, lists and revokes tokens", async () => {
    let cmd: Command | undefined;
    authExtension({ registerCommand: (c: Command) => (cmd = c), config: { get: () => ({}) } } as never);
    const out: string[] = [];
    const err: string[] = [];
    const ctx = (args: string[], flags: Record<string, string | boolean> = {}): CommandContext =>
      ({ tenantId: "local", args, flags, store, models: {} as never, stdout: (l: string) => out.push(l), stderr: (l: string) => err.push(l), log: silentLogger }) as CommandContext;
    expect(await cmd!.run(ctx(["token", "create", "laptop"], { principal: "user:jack", scopes: "read,write" }))).toBe(0);
    const token = out.pop()!;
    expect(token.startsWith("yrm_")).toBe(true);
    expect((await (await loadTokens(store, {})).verifyToken(token))?.principal).toBe("user:jack");
    await cmd!.run(ctx(["token", "list"]));
    expect(out.join("\n")).toContain("laptop\tuser:jack\tread,write");
    expect(out.join("\n")).not.toContain(token);
    expect(await cmd!.run(ctx(["token", "revoke", "laptop"]))).toBe(0);
    expect(await cmd!.run(ctx(["token", "create", "x"], { principal: "user:jack", scopes: "admin" }))).toBe(2);
    expect(err.join("\n")).toContain("unknown scope");
  });
});
