import { ConfigError, systemTimezone, type TenantConfig } from "@yrm/core";

/**
 * Settings live under `settings.attention` in yrm.config.ts. Who "you" are and
 * the timezone come from the tenant block (`yrm.config.tenant`); the same keys
 * here override it.
 */
export interface AttentionSettings {
  /** The tenant's own addresses. Their person entities are "you". */
  selfAddresses: string[];
  /** Fallback when no address matches: people at these domains are "you". */
  selfDomains: string[];
  /** IANA timezone used to turn fact and event instants into calendar days. */
  timezone: string;
  /** An unanswered ask surfaces once it is this many days old. */
  askMinDays: number;
  /** Open commitments due within this many days are "due soon". */
  dueSoonDays: number;
  /** Broken commitments surface for this many days after they broke. */
  brokenWithinDays: number;
  /** An organization with open items is "quiet" after this many days without inbound contact. */
  quietDays: number;
  /** Meetings starting within this many days get a prep item. */
  meetingWithinDays: number;
  /** Job-change signals recorded within this many days surface. */
  jobChangeWithinDays: number;
  /** Set false to skip the model brief even when a `synthesize` route exists. */
  brief: boolean;
  /** How many top items the model brief sees. */
  briefTopN: number;
  /** Spend ceiling for the one brief call, in USD. */
  briefMaxCostUsd?: number;
  /** Rule names to skip, e.g. ["gone-quiet"]. */
  disable: string[];
}

export const DEFAULT_SETTINGS: Readonly<AttentionSettings> = {
  selfAddresses: [],
  selfDomains: [],
  timezone: systemTimezone(),
  askMinDays: 2,
  dueSoonDays: 3,
  brokenWithinDays: 14,
  quietDays: 14,
  meetingWithinDays: 2,
  jobChangeWithinDays: 30,
  brief: true,
  briefTopN: 12,
  disable: [],
};

const NUMBER_KEYS = [
  "askMinDays",
  "dueSoonDays",
  "brokenWithinDays",
  "quietDays",
  "meetingWithinDays",
  "jobChangeWithinDays",
  "briefTopN",
  "briefMaxCostUsd",
] as const;

function stringList(key: string, v: unknown, lower: boolean): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) {
    throw new ConfigError("INVALID_SETTING", `settings.attention.${key} must be an array of strings`);
  }
  return v.map((s: string) => (lower ? s.trim().toLowerCase() : s.trim())).filter((s) => s.length > 0);
}

/**
 * Validate and fill defaults. Throws ConfigError on a wrong type rather than guessing.
 * `selfAddresses`, `selfDomains` and `timezone` default to the tenant block;
 * keys under `settings.attention` override them.
 */
export function readSettings(raw: Record<string, unknown> | undefined, tenant?: Readonly<TenantConfig>): AttentionSettings {
  const s: AttentionSettings = {
    ...DEFAULT_SETTINGS,
    selfAddresses: (tenant?.selfAddresses ?? []).map((a) => a.trim().toLowerCase()),
    selfDomains: (tenant?.selfDomains ?? []).map((d) => d.trim().toLowerCase()),
    disable: [],
  };
  if (tenant?.timezone !== undefined) s.timezone = tenant.timezone;
  if (raw === undefined) return s;
  if (raw.selfAddresses !== undefined) s.selfAddresses = stringList("selfAddresses", raw.selfAddresses, true);
  if (raw.selfDomains !== undefined) s.selfDomains = stringList("selfDomains", raw.selfDomains, true);
  if (raw.disable !== undefined) s.disable = stringList("disable", raw.disable, false);
  if (raw.timezone !== undefined) {
    if (typeof raw.timezone !== "string") throw new ConfigError("INVALID_SETTING", "settings.attention.timezone must be a string");
    try {
      new Intl.DateTimeFormat("en-CA", { timeZone: raw.timezone });
    } catch {
      throw new ConfigError("INVALID_SETTING", `settings.attention.timezone is not an IANA timezone: ${raw.timezone}`);
    }
    s.timezone = raw.timezone;
  }
  if (raw.brief !== undefined) {
    if (typeof raw.brief !== "boolean") throw new ConfigError("INVALID_SETTING", "settings.attention.brief must be a boolean");
    s.brief = raw.brief;
  }
  for (const key of NUMBER_KEYS) {
    const v = raw[key];
    if (v === undefined) continue;
    if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
      throw new ConfigError("INVALID_SETTING", `settings.attention.${key} must be a non-negative number`);
    }
    s[key] = v;
  }
  return s;
}
