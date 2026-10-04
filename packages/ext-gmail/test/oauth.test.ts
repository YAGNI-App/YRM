import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { MemoryStore } from "../../core/src/testing/memory-store.ts";
import {
  buildAuthUrl,
  challengeS256,
  createPkce,
  DEFAULT_ACCOUNT_KEY,
  GMAIL_READONLY_SCOPE,
  GmailClient,
  isExpired,
  KV_NAMESPACE,
  loadTokens,
  resolveAccount,
  resolveSettings,
  runLoopbackLogin,
  saveTokens,
  tokenKey,
  TokenManager,
  verifyPkce,
  type StoredTokens,
} from "../src/index.ts";
import { FakeGmail } from "./fake-gmail.ts";

describe("PKCE", () => {
  test("verifier and S256 challenge verify as a pair", () => {
    const { verifier, challenge, method } = createPkce();
    expect(method).toBe("S256");
    expect(verifier).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(verifyPkce(verifier, challenge)).toBe(true);
    expect(verifyPkce(createPkce().verifier, challenge)).toBe(false);
    // Independent of our helper: BASE64URL(SHA256(ASCII(verifier))), no padding.
    expect(challenge).toBe(createHash("sha256").update(verifier, "ascii").digest("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, ""));
  });

  test("RFC 7636 appendix B example", () => {
    expect(challengeS256("dBjftJeZ4CVP-mB92K27uhbUJU1p1r_wW1gFWFOEjXk")).toBe("E9Melhoa2OwvFrEMTJguCHaoeK1t8URWbuGJSstw-cM");
  });
});

describe("authorization URL", () => {
  test("carries PKCE, offline access, consent and the loopback redirect", () => {
    const s = resolveSettings({ clientId: "client-1", account: "Jack@Yagni.example" });
    const url = new URL(buildAuthUrl(s, { redirectUri: "http://127.0.0.1:5555/", challenge: "abc", state: "st" }));
    expect(url.origin + url.pathname).toBe("https://accounts.google.com/o/oauth2/v2/auth");
    const q = url.searchParams;
    expect(q.get("client_id")).toBe("client-1");
    expect(q.get("redirect_uri")).toBe("http://127.0.0.1:5555/");
    expect(q.get("response_type")).toBe("code");
    expect(q.get("scope")).toBe(GMAIL_READONLY_SCOPE);
    expect(q.get("code_challenge")).toBe("abc");
    expect(q.get("code_challenge_method")).toBe("S256");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("state")).toBe("st");
    expect(q.get("login_hint")).toBe("jack@yagni.example");
  });

  test("requires a client id", () => {
    expect(() => buildAuthUrl(resolveSettings({}), { redirectUri: "x", challenge: "c", state: "s" })).toThrow(/clientId/);
  });
});

describe("token storage", () => {
  const tokens: StoredTokens = { account: "jack@yagni.example", refresh_token: "rt", access_token: "at", expiry: "2026-10-04T12:00:00.000Z" };

  test("round-trips through kv and records the default account", async () => {
    const store = new MemoryStore("t");
    await saveTokens(store, tokens);
    expect(await store.kvGet<StoredTokens>(KV_NAMESPACE, tokenKey("Jack@yagni.example"))).toEqual(tokens);
    expect(await loadTokens(store, "jack@yagni.example")).toEqual(tokens);
    expect(await store.kvGet<string>(KV_NAMESPACE, DEFAULT_ACCOUNT_KEY)).toBe("jack@yagni.example");
    expect(await resolveAccount(store, { account: undefined })).toBe("jack@yagni.example");
    expect(await resolveAccount(store, { account: "other@x.example" })).toBe("other@x.example");
    expect(await loadTokens(store, "nobody@x.example")).toBeNull();
  });

  test("expiry includes a 60 second margin", () => {
    const at = Date.parse(tokens.expiry);
    expect(isExpired(tokens, at - 61_000)).toBe(false);
    expect(isExpired(tokens, at - 59_000)).toBe(true);
  });
});

describe("against the fake token endpoint", () => {
  let fake: FakeGmail;
  beforeEach(() => {
    fake = new FakeGmail().start();
  });
  afterEach(() => fake.stop());

  const settings = (): ReturnType<typeof resolveSettings> =>
    resolveSettings({ clientId: "client-1", clientSecret: "secret-1", apiBase: fake.base, tokenEndpoint: `${fake.base}/token`, authEndpoint: `${fake.base}/auth` });

  test("refreshes an access token that is about to expire, before any 401", async () => {
    const store = new MemoryStore("t");
    await saveTokens(store, { account: "jack@yagni.example", refresh_token: "rt-1", access_token: "old", expiry: new Date(Date.now() + 30_000).toISOString() });
    const tm = new TokenManager(store, settings(), "jack@yagni.example");
    const client = new GmailClient({ apiBase: fake.base, tokens: tm });
    expect((await client.getProfile()).emailAddress).toBe("jack@yagni.example");
    expect(fake.refreshes).toBe(1);
    const saved = (await loadTokens(store, "jack@yagni.example"))!;
    expect(saved.access_token).toBe("at-1");
    expect(Date.parse(saved.expiry)).toBeGreaterThan(Date.now() + 3_000_000);
  });

  test("concurrent 401s share one refresh", async () => {
    const store = new MemoryStore("t");
    await saveTokens(store, { account: "jack@yagni.example", refresh_token: "rt-1", access_token: "revoked", expiry: new Date(Date.now() + 3_600_000).toISOString() });
    const client = new GmailClient({ apiBase: fake.base, tokens: new TokenManager(store, settings(), "jack@yagni.example") });
    await Promise.all([client.getProfile(), client.getProfile(), client.getProfile()]);
    expect(fake.refreshes).toBe(1);
  });

  test("a refused refresh surfaces as an error", async () => {
    const store = new MemoryStore("t");
    await saveTokens(store, { account: "jack@yagni.example", refresh_token: "revoked", access_token: "x", expiry: "2000-01-01T00:00:00.000Z" });
    const tm = new TokenManager(store, settings(), "jack@yagni.example");
    await expect(tm.accessToken()).rejects.toThrow(/invalid_grant/);
  });

  test("loopback login: redirect, state check, PKCE code exchange, tokens stored", async () => {
    const store = new MemoryStore("t");
    let seen: URL | undefined;
    const tokens = await runLoopbackLogin({
      settings: settings(),
      kv: store,
      timeoutMs: 5000,
      onUrl: async (url, redirect) => {
        seen = new URL(url);
        fake.codes.set("code-1", seen.searchParams.get("code_challenge")!);
        // A request with the wrong state is ignored, not treated as the redirect.
        const stray = await fetch(`${redirect}?code=evil&state=wrong`);
        expect(await stray.text()).toContain("Unexpected");
        // Act as the browser following Google's redirect.
        const ok = await fetch(`${redirect}?code=code-1&state=${seen.searchParams.get("state")}&scope=x`);
        expect(await ok.text()).toContain("Signed in");
      },
      lookupAccount: async (accessToken) => {
        expect(accessToken).toBe("at-login");
        return "Jack@Yagni.example";
      },
    });
    expect(seen!.searchParams.get("redirect_uri")).toMatch(/^http:\/\/127\.0\.0\.1:\d+\/$/);
    expect(tokens).toMatchObject({ account: "jack@yagni.example", refresh_token: "rt-1", access_token: "at-login" });
    expect(await loadTokens(store, "jack@yagni.example")).toEqual(tokens);
  });

  test("a denied consent rejects the login", async () => {
    await expect(
      runLoopbackLogin({
        settings: settings(),
        kv: new MemoryStore("t"),
        timeoutMs: 5000,
        onUrl: async (_url, redirect) => {
          await fetch(`${redirect}?error=access_denied`);
        },
        lookupAccount: async () => "x@y.example",
      }),
    ).rejects.toThrow(/access_denied/);
  });
});
