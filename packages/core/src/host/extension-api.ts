import type {
  ConfigReader,
  ExtensionAPI,
  ExtensionManifest,
  Logger,
  ModelRouter,
  Store,
  YrmConfig,
} from "../contracts/index.ts";
import { messageOf } from "./errors.ts";
import type { HookBus } from "./hooks.ts";
import { prefix } from "./logger.ts";
import type { Registry } from "./registry.ts";

type Handler = (payload: unknown) => void;

/** In-process pub/sub shared by every extension in a host. Not persisted. */
export class EventBus {
  private readonly topics = new Map<string, Set<Handler>>();

  constructor(private readonly log: Logger) {}

  on(topic: string, handler: Handler): () => void {
    const set = this.topics.get(topic) ?? new Set<Handler>();
    set.add(handler);
    this.topics.set(topic, set);
    return () => {
      set.delete(handler);
    };
  }

  /**
   * Deliver to every subscriber, then rethrow the first failure so a broken
   * subscriber is loud without starving the others.
   */
  emit(topic: string, payload: unknown): void {
    let first: unknown;
    let failed = false;
    for (const handler of [...(this.topics.get(topic) ?? [])]) {
      try {
        handler(payload);
      } catch (err) {
        this.log.error("event subscriber failed", { topic, error: messageOf(err) });
        if (!failed) first = err;
        failed = true;
      }
    }
    if (failed) throw first;
  }
}

export interface ExtensionApiDeps {
  config: YrmConfig;
  store: Store;
  models: ModelRouter;
  hooks: HookBus;
  registry: Registry;
  events: EventBus;
  log: Logger;
}

export function createConfigReader(config: YrmConfig, extension: string): ConfigReader {
  return {
    tenantId: config.tenant.id,
    get<T = unknown>(key?: string): T | undefined {
      const scoped = config.settings?.[extension];
      if (scoped === undefined) return undefined;
      if (key === undefined) return scoped as T;
      return scoped[key] as T | undefined;
    },
  };
}

/** Build the API object handed to one extension's factory. */
export function createExtensionAPI(manifest: ExtensionManifest, deps: ExtensionApiDeps): ExtensionAPI {
  const name = manifest.name;
  const { registry, hooks } = deps;
  return {
    manifest,
    on: (hook, handler) => {
      hooks.on(hook, handler, name);
    },
    registerSource: (source) => registry.sources.register(source, name),
    registerExtractor: (extractor) => registry.extractors.register(extractor, name),
    registerResolver: (resolver) => registry.resolvers.register(resolver, name),
    registerRanker: (ranker) => registry.rankers.register(ranker, name),
    registerProvider: (provider) => registry.providers.register(provider, name),
    registerCommand: (command) => registry.commands.register(command, name),
    registerTool: (tool) => registry.tools.register(tool, name),
    store: deps.store,
    models: deps.models,
    config: createConfigReader(deps.config, name),
    log: prefix(deps.log, name),
    events: {
      emit: (topic, payload) => deps.events.emit(topic, payload),
      on: (topic, handler) => deps.events.on(topic, handler),
    },
  };
}
