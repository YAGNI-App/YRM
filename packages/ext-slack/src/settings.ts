export const SOURCE_NAME = "slack";
/** kv namespace for the user map, per-channel cursors, auth info and title bookkeeping. */
export const KV_NAMESPACE = "slack";
export const USERS_KEY = "users";
export const AUTH_KEY = "auth";
export const CHANNELS_KEY = "channels";
export const LAST_SYNC_KEY = "lastSync";
export const cursorKey = (channel: string): string => `cursor/${channel}`;
export const titleKey = (userId: string): string => `title/${userId}`;

export const SLACK_API_BASE = "https://slack.com/api";
export const DEFAULT_TOKEN_ENV = "YRM_SLACK_TOKEN";
export const DEFAULT_MAX_PER_SYNC = 2000;

/** Scopes the app needs, for both bot and user tokens. */
export const SCOPES: readonly string[] = [
  "channels:history",
  "groups:history",
  "im:history",
  "mpim:history",
  "channels:read",
  "groups:read",
  "im:read",
  "mpim:read",
  "users:read",
  "users:read.email",
];

/** `settings.slack` in yrm.config.ts. */
export interface SlackSettings {
  /** Environment variable holding the token. Default `YRM_SLACK_TOKEN`. */
  tokenEnv?: string;
  /** The token itself (`xoxb-` bot or `xoxp-` user). Prefer `tokenEnv`. */
  token?: string;
  /** Channel names (`#sales` or `sales`) or ids (`C0123`). Default: every unarchived channel the token can see. */
  channels?: string[];
  /** Sync DMs and group DMs. Default true for user tokens and exports, false for bot tokens. */
  includeDMs?: boolean;
  /** Keep bot messages and bot participants. Default false. */
  includeBots?: boolean;
  /** Slack user ids that are you, marked `self` (useful when Slack has no email for you). */
  selfUserIds?: string[];
  /** Messages (thread replies included) handled per sync run. Default 2000. */
  maxPerSync?: number;
  /** Override for tests and proxies. */
  apiBase?: string;
}

export interface ResolvedSettings {
  tokenEnv: string;
  token: string | undefined;
  channels: string[];
  /** Undefined means "decide by token type". */
  includeDMs: boolean | undefined;
  includeBots: boolean;
  selfUserIds: string[];
  maxPerSync: number;
  apiBase: string;
}

export function resolveSettings(s: SlackSettings = {}, env: Record<string, string | undefined> = process.env): ResolvedSettings {
  const tokenEnv = s.tokenEnv ?? DEFAULT_TOKEN_ENV;
  const max = s.maxPerSync ?? DEFAULT_MAX_PER_SYNC;
  return {
    tokenEnv,
    token: (s.token ?? env[tokenEnv])?.trim() || undefined,
    channels: (s.channels ?? []).map((c) => c.trim()).filter((c) => c !== ""),
    includeDMs: s.includeDMs,
    includeBots: s.includeBots === true,
    selfUserIds: [...(s.selfUserIds ?? [])],
    maxPerSync: Number.isFinite(max) && max > 0 ? Math.floor(max) : DEFAULT_MAX_PER_SYNC,
    apiBase: (s.apiBase ?? SLACK_API_BASE).replace(/\/+$/, ""),
  };
}

/**
 * A user token (`xoxp-`) reads the user's own DMs, so they are on by default.
 * A bot token only sees DMs with the bot, which rarely carry relationships.
 * No token at all means an export, which is the user's own data.
 */
export function dmsEnabled(s: Pick<ResolvedSettings, "includeDMs">, token: string | undefined): boolean {
  if (s.includeDMs !== undefined) return s.includeDMs;
  return token === undefined || !token.startsWith("xoxb-");
}

/** Does a channel pass the `channels` filter? Matches the id, or the name with or without `#`. */
export function channelSelected(filter: string[], id: string, name: string | undefined): boolean {
  if (filter.length === 0) return true;
  return filter.some((f) => f === id || (name !== undefined && f.replace(/^#/, "").toLowerCase() === name.toLowerCase()));
}
