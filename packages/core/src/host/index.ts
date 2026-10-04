import type {
  ContextBundle,
  ExtensionFactory,
  ExtensionManifest,
  ContextRequest,
  Entity,
  Logger,
  ModelRouter,
  QueueItem,
  SourceAdapter,
  SourceEvent,
  Store,
  YrmConfig,
} from "../contracts/index.ts";
import { EventBus } from "./extension-api.ts";
import { HookBus } from "./hooks.ts";
import { applyExtension, loadExtensions, type LoadedExtension, type LoadOptions } from "./loader.ts";
import { createLogger } from "./logger.ts";
import * as stages from "./pipeline.ts";
import { Registry } from "./registry.ts";

export { HookBus, type NotifyHook, type PipeHook, type PipeResult } from "./hooks.ts";
export { NamedRegistry, Registry, ResolverRegistry } from "./registry.ts";
export { createConfigReader, createExtensionAPI, EventBus, type ExtensionApiDeps } from "./extension-api.ts";
export { applyExtension, loadExtensions, type ExtensionOrigin, type LoadedExtension, type LoadOptions } from "./loader.ts";
export {
  CONFIG_FILES,
  DEFAULT_SQLITE_PATH,
  findConfigFile,
  loadConfig,
  normalizeConfig,
  systemTimezone,
  type LoadedConfig,
} from "./config.ts";
export {
  createLogger,
  prefix,
  silentLogger,
  stderrSink,
  type HostLogger,
  type LogLevel,
  type LogRecord,
  type LogSink,
} from "./logger.ts";
export {
  bundleTokens,
  hookContext,
  markSelf,
  sortAndDedupe,
  todayIn,
  type ExtractResult,
  type HostContext,
  type IngestResult,
  type RankOptions,
  type ResolveResult,
  type RunSummary,
  type StageOptions,
} from "./pipeline.ts";
// ConfigError is deliberately not re-exported here; see errors.ts.
export { ExtensionError, HookError } from "./errors.ts";

/**
 * Topic on the extension event bus (`yrm.events`) carrying the `Host` itself,
 * emitted at the start of `host.start()` once every extension has loaded.
 * Extensions that need more than `ExtensionAPI` (ranking, context bundles,
 * the full tool registry) subscribe at load time. Extensions loaded after
 * `start()` do not see it.
 */
export const HOST_READY_TOPIC = "host:ready";

export interface HostDeps {
  store: Store;
  models: ModelRouter;
  log?: Logger;
  /** Where `.yrm/extensions` and relative extension paths resolve. Defaults to `process.cwd()`. */
  projectRoot?: string;
}

export interface Host extends stages.HostContext {
  events: EventBus;
  projectRoot: string;
  /** Everything loaded so far, in load order, for `yrm doctor`. */
  extensions: LoadedExtension[];
  /**
   * Load extensions: `specifiers` (default `config.extensions`), then the
   * project's `.yrm/extensions`, then `~/.yrm/extensions`.
   */
  loadExtensions(specifiers?: string[], opts?: Partial<Pick<LoadOptions, "homeDir" | "disable">>): Promise<LoadedExtension[]>;
  /** Register an in-process extension (built-ins, embedding hosts, tests). Same rules as a loaded one. */
  use(factory: ExtensionFactory, manifest: ExtensionManifest): Promise<void>;
  run(sourceName?: string, opts?: stages.StageOptions & { today?: string }): Promise<stages.RunSummary>;
  ingest(source: SourceAdapter | string, opts?: stages.StageOptions): Promise<stages.IngestResult>;
  importPath(source: SourceAdapter | string, path: string, opts?: stages.StageOptions): Promise<stages.IngestResult>;
  resolve(event: SourceEvent): Promise<stages.ResolveResult>;
  extract(event: SourceEvent, opts?: stages.StageOptions): Promise<stages.ExtractResult>;
  project(entityIds: Iterable<string>): Promise<Entity[]>;
  rank(today?: string, opts?: stages.RankOptions): Promise<QueueItem[]>;
  buildContext(request: ContextRequest): Promise<ContextBundle>;
  /** Emits `HOST_READY_TOPIC` with the host on the event bus, then fires `host:start`. Once per start. */
  start(): Promise<void>;
  /** Fires `host:stop`. */
  stop(): Promise<void>;
  /** Stops if started, then closes the store. */
  close(): Promise<void>;
}

export function createHost(config: YrmConfig, deps: HostDeps): Host {
  const log = deps.log ?? createLogger("info");
  const hooks = new HookBus(log);
  const registry = new Registry();
  const events = new EventBus(log);
  const projectRoot = deps.projectRoot ?? process.cwd();
  const ctx: stages.HostContext = { config, store: deps.store, models: deps.models, hooks, registry, log };
  const loadedNames = new Set<string>();
  const loaded: LoadedExtension[] = [];
  let started = false;
  let closed = false;

  const host: Host = {
    ...ctx,
    events,
    projectRoot,
    extensions: loaded,
    async loadExtensions(specifiers, opts = {}) {
      const options: LoadOptions = {
        specifiers: specifiers ?? config.extensions ?? [],
        projectRoot,
        loaded: loadedNames,
      };
      if (opts.homeDir !== undefined) options.homeDir = opts.homeDir;
      if (opts.disable !== undefined) options.disable = opts.disable;
      const result = await loadExtensions({ ...ctx, events }, options);
      loaded.push(...result);
      return result;
    },
    async use(factory, manifest) {
      await applyExtension({ ...ctx, events }, factory, manifest, loadedNames);
      loaded.push({ manifest, path: "(in-process)", origin: "explicit" });
    },
    run: (sourceName, opts) => stages.run(ctx, sourceName, opts),
    ingest: (source, opts) => stages.ingest(ctx, source, opts),
    importPath: (source, path, opts) => stages.importPath(ctx, source, path, opts),
    resolve: (event) => stages.resolve(ctx, event),
    extract: (event, opts) => stages.extract(ctx, event, opts),
    project: (ids) => stages.project(ctx, ids),
    rank: (today, opts) => stages.rank(ctx, today, opts),
    buildContext: (request) => stages.buildContext(ctx, request),
    async start() {
      if (started) return;
      started = true;
      events.emit(HOST_READY_TOPIC, host);
      await hooks.emit("host:start", stages.hookContext(ctx));
    },
    async stop() {
      if (!started) return;
      started = false;
      await hooks.emit("host:stop", stages.hookContext(ctx));
    },
    async close() {
      if (closed) return;
      closed = true;
      await host.stop();
      await deps.store.close();
    },
  };
  return host;
}
