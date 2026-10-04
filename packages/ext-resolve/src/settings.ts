import type { ConfigReader } from "@yrm/core";

/** `settings.resolve` in yrm.config.ts. */
export interface ResolveSettings {
  /** Added to the built-in freemail list. */
  freemailDomains: string[];
  /** Merge same-name suggestions without asking. Off by default. */
  autoMergeSameName: boolean;
  /**
   * The tenant's own domains. Extensions cannot read `tenant.selfDomains`, so
   * when this is unset the self organization is created from the first
   * non-freemail domain of a participant the host marked `self`.
   */
  selfDomains: string[];
  /** Name for the self organization. Defaults to a name derived from its domain. */
  selfOrgName?: string;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim().toLowerCase()) : [];
}

export function readSettings(config: ConfigReader): ResolveSettings {
  const out: ResolveSettings = {
    freemailDomains: strings(config.get("freemailDomains")),
    autoMergeSameName: config.get("autoMergeSameName") === true,
    selfDomains: strings(config.get("selfDomains")),
  };
  const name = config.get("selfOrgName") ?? config.get("tenantName");
  if (typeof name === "string" && name.trim()) out.selfOrgName = name.trim();
  return out;
}
