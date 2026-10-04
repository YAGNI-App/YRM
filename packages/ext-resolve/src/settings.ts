import type { ConfigReader } from "@yrm/core";

/** `settings.resolve` in yrm.config.ts. */
export interface ResolveSettings {
  /** Added to the built-in freemail list. */
  freemailDomains: string[];
  /** Merge same-name suggestions without asking. Off by default. */
  autoMergeSameName: boolean;
  /**
   * The tenant's own domains. Defaults to `tenant.selfDomains`; set it here
   * only to override. When neither is set, the self organization is created
   * from the first non-freemail domain of a participant the host marked `self`.
   */
  selfDomains: string[];
  /**
   * Name for the self organization. Defaults to a name derived from its domain.
   * Not taken from `tenant.name`, which is usually the person (`yrm init --name Jack`).
   */
  selfOrgName?: string;
}

function strings(v: unknown): string[] {
  return Array.isArray(v) ? v.filter((x): x is string => typeof x === "string").map((s) => s.trim().toLowerCase()) : [];
}

export function readSettings(config: ConfigReader): ResolveSettings {
  const selfDomains = config.get("selfDomains");
  const out: ResolveSettings = {
    freemailDomains: strings(config.get("freemailDomains")),
    autoMergeSameName: config.get("autoMergeSameName") === true,
    selfDomains: strings(selfDomains === undefined ? config.tenant.selfDomains : selfDomains),
  };
  const name = config.get("selfOrgName") ?? config.get("tenantName");
  if (typeof name === "string" && name.trim()) out.selfOrgName = name.trim();
  return out;
}
