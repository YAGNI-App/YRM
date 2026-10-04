import { existsSync } from "node:fs";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { Route, RoutingPolicy, StorageConfig, TenantConfig, YrmConfig } from "../contracts/index.ts";
import { ConfigError, messageOf } from "./errors.ts";

export const CONFIG_FILES = ["yrm.config.ts", "yrm.config.js", "yrm.config.json"] as const;
export const DEFAULT_SQLITE_PATH = ".yrm/local/yrm.sqlite";

export interface LoadedConfig {
  config: YrmConfig;
  /** Absolute path of the config file that was read. */
  file: string;
  /** Directory containing the config file: the project root. */
  root: string;
}

/** Walk from `cwd` up to the filesystem root looking for a config file. */
export function findConfigFile(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/**
 * Find, import, validate and fill defaults for `yrm.config.*` in `cwd` or any
 * parent. Relative SQLite paths are resolved against the config's directory so
 * the store lands in the same place no matter where the CLI was run from.
 */
export async function loadConfig(cwd: string = process.cwd()): Promise<LoadedConfig> {
  const file = findConfigFile(cwd);
  if (!file) {
    throw new ConfigError(`no ${CONFIG_FILES.join(", ")} found in ${resolve(cwd)} or any parent directory; run \`yrm init\``);
  }
  let mod: unknown;
  try {
    mod = await import(pathToFileURL(file).href);
  } catch (err) {
    throw new ConfigError(`cannot load config: ${messageOf(err)}`, file, { cause: err });
  }
  const raw = isRecord(mod) && "default" in mod ? mod["default"] : mod;
  const root = dirname(file);
  return { config: normalizeConfig(raw, { file, root }), file, root };
}

/** Validate an in-memory config and fill defaults. Throws ConfigError on the first problem. */
export function normalizeConfig(raw: unknown, opts: { file?: string; root?: string } = {}): YrmConfig {
  const fail = (msg: string): never => {
    throw new ConfigError(msg, opts.file);
  };
  if (!isRecord(raw)) fail("config must export an object (export default defineConfig({ ... }))");
  const r = raw as Record<string, unknown>;

  const config: YrmConfig = {
    tenant: tenantOf(r["tenant"], fail),
    storage: storageOf(r["storage"], opts.root, fail),
    models: modelsOf(r["models"], fail),
  };
  if (r["providers"] !== undefined) {
    config.providers = recordOfRecords(r["providers"], "providers", fail);
  }
  if (r["extensions"] !== undefined) config.extensions = stringArray(r["extensions"], "extensions", fail);
  if (r["disable"] !== undefined) config.disable = stringArray(r["disable"], "disable", fail);
  if (r["settings"] !== undefined) config.settings = recordOfRecords(r["settings"], "settings", fail);
  return config;
}

export function systemTimezone(): string {
  return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

type Fail = (msg: string) => never;

function tenantOf(v: unknown, fail: Fail): TenantConfig {
  if (v === undefined) return fail('missing required "tenant" (e.g. tenant: { id: "local", selfAddresses: ["you@example.com"] })');
  if (!isRecord(v)) return fail('"tenant" must be an object');
  const id = v["id"] ?? "local";
  if (typeof id !== "string" || id.length === 0) fail('"tenant.id" must be a non-empty string');
  const tenant: TenantConfig = {
    id: id as string,
    selfAddresses: v["selfAddresses"] === undefined ? [] : lower(stringArray(v["selfAddresses"], "tenant.selfAddresses", fail)),
    timezone: v["timezone"] === undefined ? systemTimezone() : str(v["timezone"], "tenant.timezone", fail),
  };
  if (v["name"] !== undefined) tenant.name = str(v["name"], "tenant.name", fail);
  if (v["selfDomains"] !== undefined) tenant.selfDomains = lower(stringArray(v["selfDomains"], "tenant.selfDomains", fail));
  return tenant;
}

function storageOf(v: unknown, root: string | undefined, fail: Fail): StorageConfig {
  if (v === undefined) v = { driver: "sqlite" };
  if (!isRecord(v)) return fail('"storage" must be an object');
  const driver = str(v["driver"] ?? "sqlite", "storage.driver", fail);
  const storage: StorageConfig = { driver };
  if (v["url"] !== undefined) storage.url = str(v["url"], "storage.url", fail);
  if (v["path"] !== undefined) storage.path = str(v["path"], "storage.path", fail);
  if (driver === "sqlite") {
    const p = storage.path ?? DEFAULT_SQLITE_PATH;
    storage.path = root && !isAbsolute(p) && p !== ":memory:" ? join(root, p) : p;
  } else if (storage.path === undefined && storage.url === undefined) {
    fail(`"storage.url" is required for driver "${driver}"`);
  }
  return storage;
}

function modelsOf(v: unknown, fail: Fail): RoutingPolicy {
  // No models is a valid install: ingest, resolve, project and rule ranking still work.
  // Record<Tier, Route[]> names the well-known tiers, but a tier with no route is legal: the router reports it.
  if (v === undefined) return { routes: {} as RoutingPolicy["routes"] };
  if (!isRecord(v)) return fail('"models" must be an object');
  const routesRaw = v["routes"] ?? {};
  if (!isRecord(routesRaw)) return fail('"models.routes" must be an object of tier -> route list');
  const routes: Record<string, Route[]> = {};
  for (const [tier, chain] of Object.entries(routesRaw)) {
    if (!Array.isArray(chain)) fail(`"models.routes.${tier}" must be an array of { provider, model }`);
    routes[tier] = (chain as unknown[]).map((hop, i) => {
      if (!isRecord(hop) || typeof hop["provider"] !== "string" || typeof hop["model"] !== "string") {
        return fail(`"models.routes.${tier}[${i}]" needs string "provider" and "model"`);
      }
      return hop as unknown as Route;
    });
  }
  const policy: RoutingPolicy = { routes: routes as RoutingPolicy["routes"] };
  if (v["localOnly"] !== undefined) {
    if (typeof v["localOnly"] !== "boolean") fail('"models.localOnly" must be a boolean');
    policy.localOnly = v["localOnly"] as boolean;
  }
  if (v["monthlyBudgetUsd"] !== undefined) {
    if (typeof v["monthlyBudgetUsd"] !== "number") fail('"models.monthlyBudgetUsd" must be a number');
    policy.monthlyBudgetUsd = v["monthlyBudgetUsd"] as number;
  }
  return policy;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function str(v: unknown, field: string, fail: Fail): string {
  if (typeof v !== "string") return fail(`"${field}" must be a string`);
  return v;
}

function stringArray(v: unknown, field: string, fail: Fail): string[] {
  if (!Array.isArray(v) || !v.every((s) => typeof s === "string")) return fail(`"${field}" must be an array of strings`);
  return v as string[];
}

function recordOfRecords(v: unknown, field: string, fail: Fail): Record<string, Record<string, unknown>> {
  if (!isRecord(v)) return fail(`"${field}" must be an object`);
  for (const [k, inner] of Object.entries(v)) {
    if (!isRecord(inner)) fail(`"${field}.${k}" must be an object`);
  }
  return v as Record<string, Record<string, unknown>>;
}

function lower(xs: string[]): string[] {
  return xs.map((s) => s.toLowerCase());
}
