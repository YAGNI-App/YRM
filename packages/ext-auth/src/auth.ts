import { ConfigError, type Logger, type Store } from "@yrm/core";
import {
  hmac,
  installSecret,
  KV_NAMESPACE,
  kvTokenKey,
  listStoredTokens,
  parseScopes,
  safeEqual,
  sha256,
  validateName,
  validatePrincipal,
  type AuthSettings,
  type Scope,
  type StoredToken,
} from "./tokens.ts";

/** Who a request runs as and what it may do. */
export interface Grant {
  principal: string;
  scopes: Scope[];
  /** How the caller got in: a loopback request, a bearer token, or a web session cookie. */
  via: "loopback" | "token" | "session";
  /** The token's name, for tokens and sessions. Never the secret. */
  tokenName?: string;
}

export interface LoadOptions {
  /** Where `tokenEnv` is read from. Default `process.env`. */
  env?: Record<string, string | undefined>;
  now?: () => Date;
  log?: Logger;
}

export const SESSION_COOKIE = "yrm_session";
export const DEFAULT_SESSION_HOURS = 12;

/** A settings token with its secret resolved (from the config or the environment). */
interface ConfiguredToken {
  name: string;
  secret: string;
  principal: string;
  scopes: Scope[];
}

export function hasScope(grant: Pick<Grant, "scopes">, scope: Scope): boolean {
  return grant.scopes.includes(scope);
}

/** 127.0.0.0/8, ::1 and IPv4-mapped loopback. Hostnames are not addresses and never match. */
export function isLoopbackAddress(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const a = addr.toLowerCase().replace(/^\[|\]$/g, "");
  if (a === "::1" || a === "0:0:0:0:0:0:0:1") return true;
  const v4 = a.startsWith("::ffff:") ? a.slice(7) : a;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(v4);
}

/** True for bind addresses that only the local machine can reach. */
export function isLoopbackBind(hostname: string): boolean {
  return hostname === "localhost" || isLoopbackAddress(hostname);
}

/** True when the Host header names this machine: localhost, 127.x.x.x or [::1]. */
export function addressedToLoopback(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const h = host.toLowerCase();
  const name = h.startsWith("[") ? h.slice(0, h.indexOf("]") + 1) : (h.split(":")[0] ?? "");
  return name === "localhost" || isLoopbackAddress(name);
}

/** The bearer secret from `Authorization: Bearer <token>`, or null. */
export function bearerToken(req: Request): string | null {
  const h = req.headers.get("authorization");
  if (!h) return null;
  const m = /^Bearer\s+(\S+)\s*$/i.exec(h);
  return m ? m[1]! : null;
}

function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) {
      try {
        return decodeURIComponent(v.join("="));
      } catch {
        return null;
      }
    }
  }
  return null;
}

/**
 * Verifies callers for `yrm web` and `yrm serve --http`. Tokens come from two
 * places: `settings.auth.tokens` (secrets in the config or, better, the
 * environment) and kv `auth/tokens/<name>` (SHA-256 only, written by
 * `yrm auth token create`). kv is read on every check, so a revoke takes
 * effect on the next request without a restart.
 */
export class Auth {
  readonly allowLoopback: boolean;
  readonly sessionHours: number;
  readonly #store: Store;
  readonly #configured: ConfiguredToken[];
  readonly #secret: string;
  readonly #now: () => Date;
  #storedCount: number;

  constructor(store: Store, settings: AuthSettings, configured: ConfiguredToken[], storedCount: number, secret: string, now: () => Date) {
    this.#store = store;
    this.allowLoopback = settings.allowLoopback !== false;
    this.sessionHours = settings.sessionHours && settings.sessionHours > 0 ? settings.sessionHours : DEFAULT_SESSION_HOURS;
    this.#configured = configured;
    this.#storedCount = storedCount;
    this.#secret = secret;
    this.#now = now;
  }

  /** At least one token exists (as of load). Servers refuse a non-loopback bind without one. */
  hasTokens(): boolean {
    return this.#configured.length + this.#storedCount > 0;
  }

  /** Check a presented secret against every configured and stored token. */
  async verifyToken(secret: string | null | undefined): Promise<Grant | null> {
    if (!secret) return null;
    // Walk every entry rather than stopping at the first hit, so timing says nothing about which one matched.
    let hit: Grant | null = null;
    for (const t of this.#configured) {
      if (safeEqual(secret, t.secret) && !hit) hit = { principal: t.principal, scopes: t.scopes, via: "token", tokenName: t.name };
    }
    const digest = sha256(secret);
    const stored = await listStoredTokens(this.#store);
    this.#storedCount = stored.length;
    for (const t of stored) {
      if (safeEqual(digest, t.sha256) && !hit) hit = { principal: t.principal, scopes: t.scopes, via: "token", tokenName: t.name };
    }
    return hit;
  }

  /** `Authorization: Bearer <token>` checked against both token sources. */
  verifyBearer(req: Request): Promise<Grant | null> {
    return this.verifyToken(bearerToken(req));
  }

  /**
   * The loopback bypass: a grant for `localPrincipal` when the bypass is on,
   * the peer is this machine, and the request was addressed to a loopback
   * name. The last check matters on a 0.0.0.0 bind: a page at evil.example
   * that rebinds its name to 127.0.0.1 arrives from a loopback peer, but with
   * `Host: evil.example`.
   */
  loopbackGrant(req: Request, peer: string | null | undefined, localPrincipal: string): Grant | null {
    if (!this.allowLoopback || !isLoopbackAddress(peer) || !addressedToLoopback(req)) return null;
    return { principal: localPrincipal, scopes: ["read", "write"], via: "loopback" };
  }

  /**
   * Who is calling: the loopback bypass, then a bearer token, then a session
   * cookie. Null means unauthenticated.
   */
  async authenticate(req: Request, peer: string | null | undefined, localPrincipal: string): Promise<Grant | null> {
    const local = this.loopbackGrant(req, peer, localPrincipal);
    if (local) return local;
    const bearer = await this.verifyBearer(req);
    if (bearer) return bearer;
    const session = readCookie(req, SESSION_COOKIE);
    return session ? this.verifySession(session) : null;
  }

  /** A `Set-Cookie` value for a signed session naming the token, valid for `sessionHours`. */
  issueSession(grant: Grant): string {
    if (!grant.tokenName) throw new ConfigError("AUTH_NO_TOKEN", "a session can only be issued for a token");
    const exp = Math.floor(this.#now().getTime() / 1000) + Math.round(this.sessionHours * 3600);
    const payload = `${grant.tokenName}.${exp}`;
    const value = `${payload}.${hmac(this.#secret, payload)}`;
    return `${SESSION_COOKIE}=${encodeURIComponent(value)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${Math.round(this.sessionHours * 3600)}`;
  }

  /** Clears the session cookie. */
  clearSession(): string {
    return `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0`;
  }

  /**
   * A session is the token name and an expiry, signed with the install
   * secret. The token is looked up again, so revoking it ends its sessions.
   */
  async verifySession(value: string): Promise<Grant | null> {
    const lastDot = value.lastIndexOf(".");
    if (lastDot <= 0) return null;
    const payload = value.slice(0, lastDot);
    const mac = value.slice(lastDot + 1);
    if (!safeEqual(mac, hmac(this.#secret, payload))) return null;
    const expDot = payload.lastIndexOf(".");
    if (expDot <= 0) return null;
    const name = payload.slice(0, expDot);
    const exp = Number(payload.slice(expDot + 1));
    if (!Number.isInteger(exp) || exp * 1000 <= this.#now().getTime()) return null;
    const t = this.#configured.find((c) => c.name === name) ?? (await this.#store.kvGet<StoredToken>(KV_NAMESPACE, kvTokenKey(name)));
    if (!t) return null;
    return { principal: t.principal, scopes: t.scopes, via: "session", tokenName: name };
  }
}

/**
 * Build an `Auth` from `settings.auth` and the store: resolve settings
 * secrets (from `token` or the `tokenEnv` variable), count kv tokens, and
 * load or create the per-install session secret.
 */
export async function loadTokens(store: Store, settings: AuthSettings | undefined, opts: LoadOptions = {}): Promise<Auth> {
  const s = settings ?? {};
  const env = opts.env ?? process.env;
  const configured: ConfiguredToken[] = [];
  for (const t of s.tokens ?? []) {
    const name = validateName(t.name);
    if (configured.some((c) => c.name === name)) throw new ConfigError("AUTH_DUPLICATE", `settings.auth.tokens has two tokens named "${name}"`);
    if (t.token !== undefined && t.tokenEnv !== undefined) {
      throw new ConfigError("AUTH_BAD_TOKEN", `settings.auth.tokens "${name}": give token or tokenEnv, not both`);
    }
    const secret = t.token ?? (t.tokenEnv !== undefined ? env[t.tokenEnv] : undefined);
    if (!secret) {
      // Missing env in one environment (a laptop without the CI secret) should not stop the others.
      opts.log?.warn(`auth: token "${name}" has no secret${t.tokenEnv ? ` ($${t.tokenEnv} is unset)` : ""}; skipping it`);
      continue;
    }
    if (secret.length < 16) throw new ConfigError("AUTH_WEAK_TOKEN", `settings.auth.tokens "${name}": secrets must be at least 16 characters`);
    configured.push({ name, secret, principal: validatePrincipal(t.principal), scopes: parseScopes(t.scopes) });
  }
  const stored = await listStoredTokens(store);
  const secret = await installSecret(store);
  return new Auth(store, s, configured, stored.length, secret, opts.now ?? (() => new Date()));
}

export interface RequireAuthOptions {
  /** The remote address of the request, e.g. from `server.requestIP(req)`. */
  peer(req: Request): string | null | undefined;
  /** Who loopback callers act as. */
  localPrincipal: string;
  /** Scope the whole handler needs. Default "read". */
  scope?: Scope;
}

/**
 * Wrap a handler so it only runs for an authenticated caller with `scope`.
 * Answers 401 with `WWW-Authenticate: Bearer` when nobody is presented and
 * 403 when the scope is missing.
 */
export function requireAuth(
  auth: Auth,
  handler: (req: Request, grant: Grant) => Promise<Response>,
  opts: RequireAuthOptions,
): (req: Request) => Promise<Response> {
  const scope = opts.scope ?? "read";
  return async (req) => {
    const grant = await auth.authenticate(req, opts.peer(req), opts.localPrincipal);
    if (!grant) {
      return Response.json(
        { error: { code: "UNAUTHORIZED", message: "Send Authorization: Bearer <token>. Create one with `yrm auth token create`." } },
        { status: 401, headers: { "www-authenticate": 'Bearer realm="yrm"' } },
      );
    }
    if (!hasScope(grant, scope)) {
      return Response.json({ error: { code: "FORBIDDEN", message: `This token lacks the "${scope}" scope.` } }, { status: 403 });
    }
    return handler(req, grant);
  };
}

/** The refuse-to-bind rule shared by `yrm web` and `yrm serve --http`. */
export function assertBindAllowed(hostname: string, auth: Auth, what: string): void {
  if (isLoopbackBind(hostname) || auth.hasTokens()) return;
  throw new ConfigError(
    "AUTH_REQUIRED_TO_BIND",
    `${what} will not listen on ${hostname} without a token: anyone on the network could read and change your data. ` +
      `Create one with \`yrm auth token create <name> --principal user:<you> --scopes read,write\`, ` +
      `or add settings.auth.tokens to yrm.config.ts, or bind 127.0.0.1.`,
  );
}
