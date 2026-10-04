import type { NoiseOptions } from "@yrm/ext-mail";

export const SOURCE_NAME = "gmail";
/** kv namespace for tokens, backfill state and counters. */
export const KV_NAMESPACE = "gmail";

export const GMAIL_READONLY_SCOPE = "https://www.googleapis.com/auth/gmail.readonly";
export const DEFAULT_SCOPES: readonly string[] = [GMAIL_READONLY_SCOPE];
export const DEFAULT_LABELS: readonly string[] = ["INBOX", "SENT"];
export const DEFAULT_MAX_PER_SYNC = 500;
export const DEFAULT_CLIENT_SECRET_ENV = "YRM_GOOGLE_CLIENT_SECRET";

export const GOOGLE_AUTH_ENDPOINT = "https://accounts.google.com/o/oauth2/v2/auth";
export const GOOGLE_TOKEN_ENDPOINT = "https://oauth2.googleapis.com/token";
export const GMAIL_API_BASE = "https://gmail.googleapis.com";

/** `settings.gmail` in yrm.config.ts. */
export interface GmailSettings {
  /** OAuth client id of a Desktop app client in your Google Cloud project. */
  clientId?: string;
  /** OAuth client secret. Prefer `clientSecretEnv` so it stays out of the config file. */
  clientSecret?: string;
  /** Environment variable holding the client secret. Default `YRM_GOOGLE_CLIENT_SECRET`. */
  clientSecretEnv?: string;
  /** The mailbox address. Optional: setup learns it from the profile. */
  account?: string;
  scopes?: string[];
  /** Gmail label ids to backfill, each listed separately. Default `["INBOX", "SENT"]`. */
  labels?: string[];
  /** Gmail search filter applied during backfill, e.g. `newer_than:1y`. */
  query?: string;
  /** Messages fetched per sync run during backfill. Default 500. */
  maxPerSync?: number;
  /** Loopback port for the OAuth redirect. Default 0 (any free port). */
  redirectPort?: number;
  /** Same meaning as in `settings.mail`. */
  keepNoise?: boolean;
  noiseLocalParts?: string[];
  noiseDomains?: string[];
  /** Overrides for tests and proxies. */
  apiBase?: string;
  tokenEndpoint?: string;
  authEndpoint?: string;
}

export interface ResolvedSettings {
  clientId: string | undefined;
  clientSecret: string | undefined;
  clientSecretEnv: string;
  account: string | undefined;
  scopes: string[];
  labels: string[];
  query: string | undefined;
  maxPerSync: number;
  redirectPort: number;
  keepNoise: boolean;
  noise: NoiseOptions;
  apiBase: string;
  tokenEndpoint: string;
  authEndpoint: string;
}

export function resolveSettings(s: GmailSettings = {}, env: Record<string, string | undefined> = process.env): ResolvedSettings {
  const clientSecretEnv = s.clientSecretEnv ?? DEFAULT_CLIENT_SECRET_ENV;
  const noise: NoiseOptions = {};
  if (s.noiseLocalParts !== undefined) noise.localParts = s.noiseLocalParts;
  if (s.noiseDomains !== undefined) noise.domains = s.noiseDomains;
  const max = s.maxPerSync ?? DEFAULT_MAX_PER_SYNC;
  return {
    clientId: s.clientId,
    clientSecret: s.clientSecret ?? env[clientSecretEnv],
    clientSecretEnv,
    account: s.account?.trim().toLowerCase(),
    scopes: s.scopes && s.scopes.length > 0 ? [...s.scopes] : [...DEFAULT_SCOPES],
    labels: s.labels && s.labels.length > 0 ? [...s.labels] : [...DEFAULT_LABELS],
    query: s.query?.trim() || undefined,
    maxPerSync: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_PER_SYNC,
    redirectPort: s.redirectPort ?? 0,
    keepNoise: s.keepNoise === true,
    noise,
    apiBase: (s.apiBase ?? GMAIL_API_BASE).replace(/\/+$/, ""),
    tokenEndpoint: s.tokenEndpoint ?? GOOGLE_TOKEN_ENDPOINT,
    authEndpoint: s.authEndpoint ?? GOOGLE_AUTH_ENDPOINT,
  };
}
