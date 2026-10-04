import { createHash, randomBytes } from "node:crypto";
import { ConfigError, YrmError, type Store } from "@yrm/core";
import { KV_NAMESPACE, type ResolvedSettings } from "./settings.ts";

/**
 * OAuth 2.0 for installed apps: authorization code with PKCE and a loopback
 * redirect. Google's Desktop app clients accept any `http://127.0.0.1:<port>`
 * redirect without registering it, so no fixed port is needed.
 */

/** What we keep in the kv table under `tokens:<account>`. Never written to config. */
export interface StoredTokens {
  refresh_token: string;
  access_token: string;
  /** ISO 8601 time the access token stops working. */
  expiry: string;
  account: string;
}

export class OAuthError extends YrmError {}

/** Refresh this long before the stated expiry, so a request never races it. */
export const EXPIRY_SKEW_MS = 60_000;

// ---- PKCE (RFC 7636) ---------------------------------------------------------

export interface Pkce {
  verifier: string;
  challenge: string;
  method: "S256";
}

/** 32 random bytes as base64url: 43 characters, inside the RFC's 43..128 range. */
export function createVerifier(): string {
  return randomBytes(32).toString("base64url");
}

export function challengeS256(verifier: string): string {
  return createHash("sha256").update(verifier).digest("base64url");
}

export function createPkce(): Pkce {
  const verifier = createVerifier();
  return { verifier, challenge: challengeS256(verifier), method: "S256" };
}

/** What the authorization server does with the pair: recompute and compare. */
export function verifyPkce(verifier: string, challenge: string): boolean {
  return /^[A-Za-z0-9._~-]{43,128}$/.test(verifier) && challengeS256(verifier) === challenge;
}

// ---- URLs and token endpoint -------------------------------------------------

export function redirectUri(port: number): string {
  return `http://127.0.0.1:${port}/`;
}

export function buildAuthUrl(
  s: Pick<ResolvedSettings, "authEndpoint" | "clientId" | "scopes" | "account">,
  opts: { redirectUri: string; challenge: string; state: string },
): string {
  if (!s.clientId) throw new ConfigError("gmail_no_client", "settings.gmail.clientId is not set");
  const url = new URL(s.authEndpoint);
  const q = url.searchParams;
  q.set("client_id", s.clientId);
  q.set("redirect_uri", opts.redirectUri);
  q.set("response_type", "code");
  q.set("scope", s.scopes.join(" "));
  q.set("code_challenge", opts.challenge);
  q.set("code_challenge_method", "S256");
  q.set("state", opts.state);
  // offline + consent: Google only returns a refresh token on a fresh consent.
  q.set("access_type", "offline");
  q.set("prompt", "consent");
  if (s.account) q.set("login_hint", s.account);
  return url.toString();
}

interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

type TokenSettings = Pick<ResolvedSettings, "tokenEndpoint" | "clientId" | "clientSecret" | "clientSecretEnv">;

async function postToken(s: TokenSettings, form: Record<string, string>, fetchImpl: typeof fetch): Promise<TokenResponse> {
  if (!s.clientId) throw new ConfigError("gmail_no_client", "settings.gmail.clientId is not set");
  const body = new URLSearchParams({ ...form, client_id: s.clientId });
  if (s.clientSecret) body.set("client_secret", s.clientSecret);
  const res = await fetchImpl(s.tokenEndpoint, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body,
  });
  const text = await res.text();
  let json: TokenResponse = {};
  try {
    json = JSON.parse(text) as TokenResponse;
  } catch {
    // Fall through with the status; the body is not JSON.
  }
  if (!res.ok || !json.access_token) {
    const why = json.error ? `${json.error}${json.error_description ? `: ${json.error_description}` : ""}` : `HTTP ${res.status}`;
    const hint = !s.clientSecret && json.error === "invalid_request" ? ` (is ${s.clientSecretEnv} set?)` : "";
    throw new OAuthError("gmail_token", `token endpoint refused the request: ${why}${hint}`);
  }
  return json;
}

const expiryFrom = (expiresIn: number | undefined, now: number): string => new Date(now + (expiresIn ?? 3600) * 1000).toISOString();

export async function exchangeCode(
  s: TokenSettings,
  opts: { code: string; verifier: string; redirectUri: string; account: string; now?: number },
  fetchImpl: typeof fetch = fetch,
): Promise<StoredTokens> {
  const now = opts.now ?? Date.now();
  const res = await postToken(
    s,
    { grant_type: "authorization_code", code: opts.code, code_verifier: opts.verifier, redirect_uri: opts.redirectUri },
    fetchImpl,
  );
  if (!res.refresh_token) throw new OAuthError("gmail_token", "no refresh token returned; revoke the app's access and run gmail:setup again");
  return { refresh_token: res.refresh_token, access_token: res.access_token!, expiry: expiryFrom(res.expires_in, now), account: opts.account };
}

export async function refreshTokens(s: TokenSettings, tokens: StoredTokens, fetchImpl: typeof fetch = fetch, now = Date.now()): Promise<StoredTokens> {
  const res = await postToken(s, { grant_type: "refresh_token", refresh_token: tokens.refresh_token }, fetchImpl);
  // Google may rotate the refresh token; keep the old one when it does not.
  return { ...tokens, access_token: res.access_token!, refresh_token: res.refresh_token ?? tokens.refresh_token, expiry: expiryFrom(res.expires_in, now) };
}

export const isExpired = (tokens: StoredTokens, now = Date.now()): boolean => Date.parse(tokens.expiry) - EXPIRY_SKEW_MS <= now;

// ---- token storage -------------------------------------------------------------

type Kv = Pick<Store, "kvGet" | "kvSet">;

export const tokenKey = (account: string): string => `tokens:${account.toLowerCase()}`;
/** The account `gmail:setup` last signed in, used when `settings.gmail.account` is unset. */
export const DEFAULT_ACCOUNT_KEY = "account";

export async function saveTokens(kv: Kv, tokens: StoredTokens): Promise<void> {
  await kv.kvSet(KV_NAMESPACE, tokenKey(tokens.account), tokens);
  await kv.kvSet(KV_NAMESPACE, DEFAULT_ACCOUNT_KEY, tokens.account.toLowerCase());
}

export async function loadTokens(kv: Kv, account: string): Promise<StoredTokens | null> {
  return kv.kvGet<StoredTokens>(KV_NAMESPACE, tokenKey(account));
}

export async function resolveAccount(kv: Kv, s: Pick<ResolvedSettings, "account">): Promise<string | undefined> {
  return s.account ?? (await kv.kvGet<string>(KV_NAMESPACE, DEFAULT_ACCOUNT_KEY)) ?? undefined;
}

/** Hands out a valid access token, refreshing and persisting as needed. */
export class TokenManager {
  private tokens: StoredTokens | null = null;
  private refreshing: Promise<StoredTokens> | null = null;

  constructor(
    private readonly kv: Kv,
    private readonly settings: TokenSettings,
    readonly account: string,
    private readonly fetchImpl: typeof fetch = fetch,
  ) {}

  async current(): Promise<StoredTokens> {
    this.tokens ??= await loadTokens(this.kv, this.account);
    if (!this.tokens) throw new ConfigError("gmail_no_tokens", `no Gmail tokens for ${this.account}; run \`yrm gmail:setup\``);
    return this.tokens;
  }

  async accessToken(): Promise<string> {
    const t = await this.current();
    return isExpired(t) ? (await this.refresh()).access_token : t.access_token;
  }

  /** One refresh at a time: concurrent 401s share the same request. */
  refresh(): Promise<StoredTokens> {
    this.refreshing ??= (async () => {
      try {
        const next = await refreshTokens(this.settings, await this.current(), this.fetchImpl);
        await saveTokens(this.kv, next);
        this.tokens = next;
        return next;
      } finally {
        this.refreshing = null;
      }
    })();
    return this.refreshing;
  }
}

// ---- loopback login ------------------------------------------------------------

export interface LoginOptions {
  settings: ResolvedSettings;
  /** Called with the authorization URL once the listener is up. */
  onUrl: (url: string, redirectUri: string) => void | Promise<void>;
  /** Resolve the mailbox address from a fresh access token. */
  lookupAccount: (accessToken: string) => Promise<string>;
  kv: Kv;
  timeoutMs?: number;
  fetchImpl?: typeof fetch;
}

const PAGE = (title: string, body: string): Response =>
  new Response(`<!doctype html><meta charset="utf-8"><title>${title}</title><p style="font:16px system-ui;margin:3em">${body}</p>`, {
    headers: { "content-type": "text/html; charset=utf-8" },
  });

/**
 * Run the full flow: listen on 127.0.0.1, hand out the URL, wait for the
 * redirect, check `state`, exchange the code with the PKCE verifier, store tokens.
 */
export async function runLoopbackLogin(opts: LoginOptions): Promise<StoredTokens> {
  const s = opts.settings;
  const pkce = createPkce();
  const state = randomBytes(16).toString("base64url");
  let settle!: { resolve: (code: string) => void; reject: (e: Error) => void };
  const codePromise = new Promise<string>((resolve, reject) => {
    settle = { resolve, reject };
  });
  // A denial can arrive before we await; keep it from surfacing as unhandled.
  codePromise.catch(() => {});

  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: s.redirectPort,
    fetch(req) {
      const url = new URL(req.url);
      if (url.pathname !== "/") return new Response("not found", { status: 404 });
      const error = url.searchParams.get("error");
      if (error) {
        settle.reject(new OAuthError("gmail_denied", `authorization failed: ${error}`));
        return PAGE("YRM", "Authorization was not granted. You can close this tab.");
      }
      const code = url.searchParams.get("code");
      if (!code || url.searchParams.get("state") !== state) return PAGE("YRM", "Unexpected request; waiting for Google's redirect.");
      settle.resolve(code);
      return PAGE("YRM", "Signed in. You can close this tab and return to the terminal.");
    },
  });

  const timer = setTimeout(() => settle.reject(new OAuthError("gmail_timeout", "timed out waiting for the browser redirect")), opts.timeoutMs ?? 5 * 60_000);
  try {
    const uri = redirectUri(server.port ?? s.redirectPort);
    await opts.onUrl(buildAuthUrl(s, { redirectUri: uri, challenge: pkce.challenge, state }), uri);
    const code = await codePromise;
    const fetchImpl = opts.fetchImpl ?? fetch;
    // The account is only known after sign-in; exchange first, then ask Gmail whose mailbox it is.
    const provisional = await exchangeCode(s, { code, verifier: pkce.verifier, redirectUri: uri, account: s.account ?? "" }, fetchImpl);
    const account = (await opts.lookupAccount(provisional.access_token)).toLowerCase();
    const tokens = { ...provisional, account };
    await saveTokens(opts.kv, tokens);
    return tokens;
  } finally {
    clearTimeout(timer);
    server.stop(true);
  }
}
