import { createHash, createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ConfigError, type Store } from "@yrm/core";

/** What a token may do. `write` implies nothing about `read`; grant both for a full client. */
export type Scope = "read" | "write";
export const SCOPES: readonly Scope[] = ["read", "write"];

/** One entry of `settings.auth.tokens` in yrm.config.ts. Give `token` or `tokenEnv`, not both. */
export interface TokenSetting {
  name: string;
  /** The secret itself. Prefer `tokenEnv`: config files end up in backups and screenshots. */
  token?: string;
  /** Environment variable holding the secret (CI, containers). */
  tokenEnv?: string;
  /** "user:jack", "agent:yagni/bailey". Becomes `origin.by` on writes. */
  principal: string;
  scopes: Scope[];
}

/** `settings.auth` in yrm.config.ts. */
export interface AuthSettings {
  tokens?: TokenSetting[];
  /** Let requests from 127.0.0.1 / ::1 through without a token. Default true. */
  allowLoopback?: boolean;
  /** How long a web session cookie lasts. Default 12. */
  sessionHours?: number;
}

/** A token as kept in kv `auth` / `tokens/<name>`: the hash, never the secret. */
export interface StoredToken {
  name: string;
  sha256: string;
  principal: string;
  scopes: Scope[];
  createdAt: string;
}

export const KV_NAMESPACE = "auth";
export const KV_SECRET = "secret";
/** kv has no listing, so the names live in an index next to the records. */
export const KV_INDEX = "tokens";
export const kvTokenKey = (name: string): string => `tokens/${name}`;

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const PRINCIPAL_RE = /^(user|agent):[^\s]+$/;

export function sha256(value: string): string {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

/**
 * Constant-time equality. Both sides are hashed first so the comparison
 * length never depends on the secret, and an early length mismatch leaks
 * nothing.
 */
export function safeEqual(a: string, b: string): boolean {
  const ha = createHash("sha256").update(a, "utf8").digest();
  const hb = createHash("sha256").update(b, "utf8").digest();
  return timingSafeEqual(ha, hb);
}

export function hmac(secret: string, data: string): string {
  return createHmac("sha256", secret).update(data, "utf8").digest("base64url");
}

/** 32 random bytes, base64url, with a prefix so a leaked token is recognizable in a scan. */
export function generateToken(): string {
  return `yrm_${randomBytes(32).toString("base64url")}`;
}

export function validateName(name: string): string {
  if (!NAME_RE.test(name)) throw new ConfigError("AUTH_BAD_NAME", `token name must be lowercase letters, digits, ".", "_" or "-" (got "${name}")`);
  return name;
}

export function validatePrincipal(principal: string): string {
  if (!PRINCIPAL_RE.test(principal)) {
    throw new ConfigError("AUTH_BAD_PRINCIPAL", `principal must look like "user:jack" or "agent:yagni/bailey" (got "${principal}")`);
  }
  return principal;
}

export function parseScopes(raw: unknown): Scope[] {
  const list = Array.isArray(raw) ? raw : typeof raw === "string" ? raw.split(",") : [];
  const out: Scope[] = [];
  for (const s of list) {
    const v = typeof s === "string" ? s.trim() : "";
    if (v === "") continue;
    if (v !== "read" && v !== "write") throw new ConfigError("AUTH_BAD_SCOPE", `unknown scope "${v}"; use read, write or read,write`);
    if (!out.includes(v)) out.push(v);
  }
  if (out.length === 0) throw new ConfigError("AUTH_BAD_SCOPE", "a token needs at least one scope (read, write)");
  return out;
}

// ---- kv-stored tokens ----------------------------------------------------------------

export async function listStoredTokens(store: Store): Promise<StoredToken[]> {
  const names = (await store.kvGet<string[]>(KV_NAMESPACE, KV_INDEX)) ?? [];
  const out: StoredToken[] = [];
  for (const name of names) {
    const t = await store.kvGet<StoredToken>(KV_NAMESPACE, kvTokenKey(name));
    if (t) out.push(t);
  }
  return out;
}

/** Generate a token, store its hash, and return the secret. The caller shows it once. */
export async function createStoredToken(
  store: Store,
  opts: { name: string; principal: string; scopes: Scope[]; now?: Date },
): Promise<{ token: string; record: StoredToken }> {
  const name = validateName(opts.name);
  const principal = validatePrincipal(opts.principal);
  const names = (await store.kvGet<string[]>(KV_NAMESPACE, KV_INDEX)) ?? [];
  if (names.includes(name)) throw new ConfigError("AUTH_TOKEN_EXISTS", `a token named "${name}" already exists; revoke it first`);
  const token = generateToken();
  const record: StoredToken = { name, sha256: sha256(token), principal, scopes: opts.scopes, createdAt: (opts.now ?? new Date()).toISOString() };
  await store.kvSet(KV_NAMESPACE, kvTokenKey(name), record);
  await store.kvSet(KV_NAMESPACE, KV_INDEX, [...names, name]);
  return { token, record };
}

export async function revokeStoredToken(store: Store, name: string): Promise<boolean> {
  const names = (await store.kvGet<string[]>(KV_NAMESPACE, KV_INDEX)) ?? [];
  const had = (await store.kvGet<StoredToken>(KV_NAMESPACE, kvTokenKey(name))) !== null;
  await store.kvDelete(KV_NAMESPACE, kvTokenKey(name));
  if (names.includes(name)) await store.kvSet(KV_NAMESPACE, KV_INDEX, names.filter((n) => n !== name));
  return had || names.includes(name);
}

/** The per-install HMAC key for session cookies, created on first use. */
export async function installSecret(store: Store): Promise<string> {
  const existing = await store.kvGet<string>(KV_NAMESPACE, KV_SECRET);
  if (typeof existing === "string" && existing.length >= 32) return existing;
  const secret = randomBytes(32).toString("base64url");
  await store.kvSet(KV_NAMESPACE, KV_SECRET, secret);
  return secret;
}
