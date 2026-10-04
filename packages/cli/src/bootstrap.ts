import { mkdirSync } from "node:fs";
import { dirname } from "node:path";
import {
  createHost,
  createLogger,
  createStore,
  ExtensionError,
  findConfigFile,
  loadConfig,
  MemoryUsageSink,
  normalizeConfig,
  Router,
  SqliteStore,
  type ExtensionFactory,
  type ExtensionManifest,
  type Host,
  type HostLogger,
  type ModelProvider,
  type Registry,
  type UsageSink,
  type YrmConfig,
} from "@yrm/core";
import anthropicProvider, { manifest as anthropicManifest, PROVIDER_NAME as ANTHROPIC } from "@yrm/provider-anthropic";
import openAIProvider, {
  DEFAULT_PROVIDER_NAME as OPENAI_COMPATIBLE,
  manifest as openAIManifest,
  OpenAICompatibleProvider,
  readOpenAIConfig,
} from "@yrm/provider-openai";
import { BUILTINS, BUNDLED, packageShortName } from "./builtins.ts";
import { SqliteUsageSink } from "./usage-sink.ts";

/**
 * Provider factories read their settings through `yrm.config.get()`, which
 * returns `settings[<extension name>]`. Users configure providers under
 * `providers[<provider name>]` (the documented place). Bootstrap bridges the
 * two by copying `providers.anthropic` into `settings["provider-anthropic"]`
 * and `providers["openai-compatible"]` into `settings["provider-openai"]`.
 * Keys in `settings` win over keys in `providers`.
 *
 * Any other key under `providers` (e.g. `openrouter`) is registered as an
 * extra OpenAI-compatible endpoint whose provider name is that key, so routes
 * can say `{ provider: "openrouter", model: "..." }`.
 */
export const PROVIDER_EXTENSIONS: Readonly<Record<string, string>> = {
  [ANTHROPIC]: anthropicManifest.name,
  [OPENAI_COMPATIBLE]: openAIManifest.name,
};

/** Packages the CLI wires itself; listing them in `extensions` is tolerated, not loaded twice. */
const SELF_WIRED = new Set<string>([...BUILTINS, "@yrm/provider-anthropic", "@yrm/provider-openai"]);

export function withProviderSettings(config: YrmConfig): YrmConfig {
  const settings: Record<string, Record<string, unknown>> = { ...config.settings };
  for (const [provider, ext] of Object.entries(PROVIDER_EXTENSIONS)) {
    const fromProviders = config.providers?.[provider];
    if (fromProviders) settings[ext] = { ...fromProviders, ...config.settings?.[ext] };
  }
  for (const name of extraProviderNames(config)) {
    const ext = extraProviderExtension(name);
    settings[ext] = { ...config.providers?.[name], ...config.settings?.[ext], name };
  }
  return { ...config, settings };
}

function extraProviderNames(config: YrmConfig): string[] {
  return Object.keys(config.providers ?? {}).filter((n) => !(n in PROVIDER_EXTENSIONS));
}

function extraProviderExtension(name: string): string {
  return `provider-${name}`;
}

/**
 * The Router needs a provider map at construction and the host needs the
 * router, but providers register through the host. The Router looks providers
 * up per call, so this map defers to the host registry once it is bound.
 */
export class RegistryProviderMap extends Map<string, ModelProvider> {
  private registry: Registry | undefined;

  bind(registry: Registry): void {
    this.registry = registry;
  }

  override get(name: string): ModelProvider | undefined {
    return this.registry?.providers.get(name);
  }

  override has(name: string): boolean {
    return this.registry?.providers.has(name) ?? false;
  }
}

export interface BuiltinStatus {
  specifier: string;
  status: "loaded" | "missing" | "disabled";
  /** Manifest name when loaded. */
  name?: string;
}

export interface BootstrapOptions {
  cwd: string;
  /** When false and no config file exists, boot an in-memory host with defaults. Default true. */
  needConfig?: boolean;
  log?: HostLogger;
  /** Passed to the loader; `null` skips `~/.yrm/extensions`. Defaults to the OS home dir. */
  homeDir?: string | null;
  /** Override the builtin list (tests). */
  builtins?: readonly string[];
  /** Override how builtin packages are imported (tests). */
  importModule?: (specifier: string) => Promise<unknown>;
}

export interface Booted {
  host: Host;
  config: YrmConfig;
  /** Absolute config path, or null when booted without one. */
  configFile: string | null;
  root: string;
  builtins: BuiltinStatus[];
}

export async function bootstrap(opts: BootstrapOptions): Promise<Booted> {
  const log = opts.log ?? createLogger("warn");
  const needConfig = opts.needConfig ?? true;

  let raw: YrmConfig;
  let configFile: string | null = null;
  let root = opts.cwd;
  if (needConfig || findConfigFile(opts.cwd)) {
    const loaded = await loadConfig(opts.cwd);
    raw = loaded.config;
    configFile = loaded.file;
    root = loaded.root;
  } else {
    raw = normalizeConfig({ tenant: { id: "local" }, storage: { driver: "sqlite", path: ":memory:" } });
  }
  const config = withProviderSettings(raw);

  const { driver, path } = config.storage;
  // SQLite creates the file but not its directory; a fresh clone has no .yrm/local yet.
  if (driver === "sqlite" && path && path !== ":memory:" && !path.startsWith("file:")) {
    mkdirSync(dirname(path), { recursive: true });
  }
  const store = await createStore(config.storage);
  try {
    const usage: UsageSink = store instanceof SqliteStore ? new SqliteUsageSink(store) : new MemoryUsageSink();
    const providers = new RegistryProviderMap();
    // Assigned right after createHost; the router only calls hooks during a completion.
    let host: Host | undefined;
    const router = new Router({
      policy: config.models,
      providers,
      usage,
      tenantId: config.tenant.id,
      hooks: {
        before: async (tier, req) => (host ? host.hooks.pipe("model:before", hookCtx(host), tier, req) : undefined),
        after: async (tier, req, res) => {
          if (host) await host.hooks.emit("model:after", hookCtx(host), tier, req, res);
        },
      },
    });
    host = createHost(config, { store, models: router, log, projectRoot: root });
    providers.bind(host.registry);

    const disabled = new Set(config.disable ?? []);
    if (!disabled.has(anthropicManifest.name)) await host.use(anthropicProvider, anthropicManifest);
    if (!disabled.has(openAIManifest.name)) await host.use(openAIProvider, openAIManifest);
    for (const name of extraProviderNames(config)) {
      const ext = extraProviderExtension(name);
      if (disabled.has(ext)) continue;
      const factory: ExtensionFactory = (yrm) => {
        yrm.registerProvider(new OpenAICompatibleProvider({ ...readOpenAIConfig(yrm.config.get()), name }));
      };
      await host.use(factory, { name: ext, description: `OpenAI-compatible endpoint "${name}"` });
    }

    const builtins: BuiltinStatus[] = [];
    const importModule = opts.importModule ?? ((spec: string) => importBuiltin(spec, root));
    for (const spec of opts.builtins ?? BUILTINS) {
      builtins.push(await loadBuiltin(host, spec, disabled, importModule, log));
    }

    // First-party packages named in `extensions` (ext-gmail) come from the
    // bundled map, not from disk: a compiled binary has no node_modules to
    // resolve them from. They load before paths and third-party packages.
    const extra = (config.extensions ?? []).filter((s) => !SELF_WIRED.has(s));
    for (const spec of extra.filter((s) => s in BUNDLED)) {
      builtins.push(await loadBuiltin(host, spec, disabled, importModule, log));
    }
    await host.loadExtensions(
      extra.filter((s) => !(s in BUNDLED)),
      opts.homeDir === undefined ? {} : { homeDir: opts.homeDir },
    );
    await host.start();
    return { host, config, configFile, root, builtins };
  } catch (err) {
    await store.close();
    throw err;
  }
}

function hookCtx(host: Host) {
  return { tenantId: host.config.tenant.id, store: host.store, models: host.models, log: host.log };
}

/**
 * Bundled packages import statically (see BUNDLED), so a compiled binary and
 * a source checkout load the same code. Anything else resolves from the
 * project first, like the loader, then from the CLI install.
 */
async function importBuiltin(spec: string, root: string): Promise<unknown> {
  const bundled = BUNDLED[spec];
  if (bundled) return bundled();
  let target = spec;
  try {
    target = Bun.resolveSync(spec, root);
  } catch {
    // Not installed in the project; fall back to the CLI's own resolution.
  }
  return import(target);
}

/**
 * True only when `spec` itself is not installed. A builtin that is installed
 * but fails to import (a missing transitive dependency, a syntax error) is a
 * real error and must surface.
 */
export function isMissingPackage(err: unknown, spec: string): boolean {
  if (typeof err !== "object" || err === null) return false;
  const e = err as { code?: unknown; message?: unknown };
  const message = typeof e.message === "string" ? e.message : "";
  const notFound = e.code === "ERR_MODULE_NOT_FOUND" || /Cannot find (package|module)/.test(message);
  return notFound && (message.includes(`'${spec}'`) || message.includes(`"${spec}"`));
}

async function loadBuiltin(
  host: Host,
  spec: string,
  disabled: Set<string>,
  importModule: (spec: string) => Promise<unknown>,
  log: HostLogger,
): Promise<BuiltinStatus> {
  const short = packageShortName(spec);
  if (disabled.has(spec) || disabled.has(short)) return { specifier: spec, status: "disabled" };
  let mod: Record<string, unknown>;
  try {
    mod = (await importModule(spec)) as Record<string, unknown>;
  } catch (err) {
    if (isMissingPackage(err, spec)) {
      log.debug("builtin extension not installed; skipping", { specifier: spec });
      return { specifier: spec, status: "missing" };
    }
    throw new ExtensionError(`cannot import extension "${spec}": ${err instanceof Error ? err.message : String(err)}`, short, {
      cause: err,
    });
  }
  const factory = mod["default"];
  if (typeof factory !== "function") {
    throw new ExtensionError(`extension "${spec}" must default-export a factory function`, short);
  }
  const manifest = manifestOf(mod["manifest"], short);
  if (disabled.has(manifest.name)) return { specifier: spec, status: "disabled" };
  await host.use(factory as ExtensionFactory, manifest);
  return { specifier: spec, status: "loaded", name: manifest.name };
}

function manifestOf(m: unknown, fallback: string): ExtensionManifest {
  if (typeof m === "object" && m !== null && typeof (m as { name?: unknown }).name === "string") return m as ExtensionManifest;
  return { name: fallback };
}
