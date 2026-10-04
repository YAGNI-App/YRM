import type { RoutingPolicy } from "./models.ts";

/**
 * yrm.config.ts lives at the project root:
 *
 *   import { defineConfig } from "@yrm/core";
 *   export default defineConfig({
 *     tenant: { id: "local", name: "Jack", selfAddresses: ["jack@example.com"], timezone: "America/Denver" },
 *     storage: { driver: "sqlite", path: ".yrm/local/yrm.sqlite" },
 *     models: { routes: { triage: [{ provider: "openai-compatible", model: "qwen3-8b" }], ... } },
 *     providers: { "openai-compatible": { baseUrl: "http://localhost:11434/v1" } },
 *     extensions: ["@yrm/ext-mail", "./extensions/my-ranker.ts"],
 *   });
 */

export interface TenantConfig {
  id: string;
  name?: string;
  /** Addresses that belong to the tenant's own users. Used to mark `self` participants. */
  selfAddresses: string[];
  /** Domains that belong to the tenant's own organization. */
  selfDomains?: string[];
  /** IANA timezone for "today". */
  timezone?: string;
}

export interface StorageConfig {
  driver: "sqlite" | "postgres" | (string & {});
  /** SQLite file path or Postgres connection string. */
  path?: string;
  url?: string;
}

export interface YrmConfig {
  tenant: TenantConfig;
  storage: StorageConfig;
  models: RoutingPolicy;
  /** Provider-specific settings keyed by provider name: baseUrl, apiKeyEnv, headers. */
  providers?: Record<string, Record<string, unknown>>;
  /** Package names or paths. Built-ins are loaded unless listed in `disable`. */
  extensions?: string[];
  disable?: string[];
  /** Extension-scoped settings keyed by extension name. */
  settings?: Record<string, Record<string, unknown>>;
}

export function defineConfig(config: YrmConfig): YrmConfig {
  return config;
}
