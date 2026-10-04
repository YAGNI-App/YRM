import type { NewSourceEvent, SourceEvent } from "./events.ts";
import type { Fact, NewFact } from "./facts.ts";
import type { Entity } from "./entities.ts";
import type { Store } from "./store.ts";
import type { CompletionRequest, CompletionResponse, ModelProvider, ModelRouter } from "./models.ts";

/**
 * YRM's core does almost nothing. Ingesters, extractors, resolvers, rankers,
 * providers, commands and agent tools are all extensions. An extension is a
 * module whose default export is a factory that receives the ExtensionAPI.
 *
 *   export default function (yrm: ExtensionAPI) {
 *     yrm.registerSource({ ... });
 *     yrm.on("extract:after", async (ctx, facts) => facts.filter(...));
 *   }
 *
 * Extensions load from: paths listed in yrm.config.ts, `.yrm/extensions/*.ts`
 * in the project, `~/.yrm/extensions/*.ts`, and installed packages. TypeScript
 * runs directly under Bun; no build step.
 */

export interface ExtensionManifest {
  /** Unique, kebab-case. Used as the `source` on events and `by` on facts. */
  name: string;
  version?: string;
  description?: string;
}

export type ExtensionFactory = (yrm: ExtensionAPI) => void | Promise<void>;

export interface ExtensionModule {
  default: ExtensionFactory;
  manifest?: ExtensionManifest;
}

// ---- registrations ----------------------------------------------------------

export interface SyncContext {
  tenantId: string;
  /** Last cursor this source stored, or null on first sync. */
  cursor: string | null;
  /** Hand events to the host. Returns created events (duplicates are dropped). */
  emit(events: NewSourceEvent[]): Promise<SourceEvent[]>;
  /** Persist progress. Called by the source whenever it is safe to resume from here. */
  setCursor(cursor: string): Promise<void>;
  signal: AbortSignal;
  log: Logger;
}

/** Where events come from. Sources are pull-based; the host schedules them. */
export interface SourceAdapter {
  name: string;
  description?: string;
  /** Kinds this source emits, for documentation and filtering. */
  kinds: string[];
  /** Pull everything since the cursor. Must be idempotent. */
  sync(ctx: SyncContext): Promise<void>;
  /** Optional: one-shot import of a file or directory, for fixtures and migrations. */
  importPath?(path: string, ctx: SyncContext): Promise<void>;
}

export interface ExtractContext {
  tenantId: string;
  /** Events in the same thread that precede this one, oldest first. Already trimmed to a budget. */
  thread: SourceEvent[];
  /** Entities already resolved for the event's participants. */
  participants: Entity[];
  /** Facts already known about those participants, valid now. */
  knownFacts: Fact[];
  models: ModelRouter;
  log: Logger;
  signal: AbortSignal;
}

/** Turns events into facts. Runs after resolution. */
export interface Extractor {
  name: string;
  /** Bump when the prompt or logic changes; recorded on every fact. */
  version: string;
  /** Cheap gate so expensive extractors only see relevant events. */
  applies?(event: SourceEvent): boolean;
  extract(event: SourceEvent, ctx: ExtractContext): Promise<NewFact[]>;
}

export interface ResolveContext {
  tenantId: string;
  store: Store;
  models: ModelRouter;
  log: Logger;
}

/** Maps participants to entities. Deterministic resolvers run before model-backed ones. */
export interface Resolver {
  name: string;
  /** Lower runs first. Header-based resolvers use 0; model-backed use 100+. */
  priority: number;
  resolve(event: SourceEvent, ctx: ResolveContext): Promise<Array<{ index: number; entityId: string }>>;
}

export interface QueueItem {
  /** Stable key so the same item is not re-proposed after dismissal. */
  key: string;
  /** What to do, one line. */
  action: string;
  /** Why, in terms a person can check. */
  reason: string;
  /** 0..1, higher is more urgent. */
  score: number;
  /** Entities involved. */
  about: Array<{ entityId: string; name?: string }>;
  /** Facts and events this rests on. */
  evidence: { factIds: string[]; eventIds: string[] };
  dueAt?: string;
  /** The ranker that produced it. */
  by: string;
}

export interface RankContext {
  tenantId: string;
  store: Store;
  models: ModelRouter;
  /** Today's date in the tenant's timezone, ISO date. */
  today: string;
  log: Logger;
}

/** Produces attention-queue candidates from facts. Rule rankers are free; model rankers re-order. */
export interface Ranker {
  name: string;
  rank(ctx: RankContext, candidates: QueueItem[]): Promise<QueueItem[]>;
}

export interface CommandContext {
  tenantId: string;
  args: string[];
  flags: Record<string, string | boolean>;
  store: Store;
  models: ModelRouter;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  log: Logger;
}

export interface Command {
  name: string;
  description: string;
  usage?: string;
  run(ctx: CommandContext): Promise<number | void>;
}

/**
 * Agent-facing tools, exposed through the MCP server and to in-process agents.
 * `exposure` follows pi: "direct" tools are always listed; "deferred" tools are
 * found through search; "codemode" tools are only callable from sandboxed code
 * so results are filtered before they reach a model's context.
 */
export interface Tool<I = unknown, O = unknown> {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  outputSchema?: Record<string, unknown>;
  exposure?: "direct" | "deferred" | "codemode";
  /** Writes require confirmation in interactive hosts. */
  readOnly: boolean;
  run(input: I, ctx: ToolContext): Promise<O>;
}

export interface ToolContext {
  tenantId: string;
  store: Store;
  models: ModelRouter;
  /** Who is calling, when known: "user:jack", "agent:yagni/bailey". */
  principal?: string;
  log: Logger;
}

// ---- hooks ------------------------------------------------------------------

export interface HookContext {
  tenantId: string;
  store: Store;
  models: ModelRouter;
  log: Logger;
}

/**
 * Hooks fire at every seam. Returning a value replaces the subject; returning
 * `undefined` leaves it unchanged; returning `null` where allowed vetoes it.
 */
export interface HookMap {
  /** Before an event enters the log. Return null to drop it. */
  "ingest:before": (ctx: HookContext, event: NewSourceEvent) => Promise<NewSourceEvent | null | undefined>;
  "ingest:after": (ctx: HookContext, event: SourceEvent) => Promise<void>;
  "resolve:after": (ctx: HookContext, event: SourceEvent, entities: Entity[]) => Promise<void>;
  /** Before extractors run. Return null to skip extraction for this event. */
  "extract:before": (ctx: HookContext, event: SourceEvent) => Promise<SourceEvent | null | undefined>;
  /** After extractors run, before facts are recorded. Filter or amend. */
  "extract:after": (ctx: HookContext, event: SourceEvent, facts: NewFact[]) => Promise<NewFact[] | undefined>;
  "fact:recorded": (ctx: HookContext, fact: Fact) => Promise<void>;
  "entity:proposed": (ctx: HookContext, entity: Entity) => Promise<void>;
  "entity:confirmed": (ctx: HookContext, entity: Entity) => Promise<void>;
  "entity:merged": (ctx: HookContext, from: Entity, into: Entity) => Promise<void>;
  "queue:before_rank": (ctx: HookContext, candidates: QueueItem[]) => Promise<QueueItem[] | undefined>;
  "queue:after_rank": (ctx: HookContext, items: QueueItem[]) => Promise<QueueItem[] | undefined>;
  /** Before a model call. Rewrite the request or return null to block it. */
  "model:before": (ctx: HookContext, tier: string, req: CompletionRequest) => Promise<CompletionRequest | null | undefined>;
  "model:after": (ctx: HookContext, tier: string, req: CompletionRequest, res: CompletionResponse) => Promise<void>;
  /**
   * When an agent asks for context about entities, every extension gets to add
   * or rewrite what goes in. This is the "context layer" seam.
   */
  "context:build": (ctx: HookContext, request: ContextRequest, draft: ContextBundle) => Promise<ContextBundle | undefined>;
  "host:start": (ctx: HookContext) => Promise<void>;
  "host:stop": (ctx: HookContext) => Promise<void>;
}

export type HookName = keyof HookMap;

export interface ContextRequest {
  entityIds?: string[];
  threadKey?: string;
  /** Free text the agent is working on, for relevance. */
  query?: string;
  /** Token budget for the whole bundle. */
  budget: number;
  asOf?: string;
}

export interface ContextBundle {
  /** Ordered sections; the host trims from the end to fit the budget. */
  sections: Array<{ title: string; text: string; factIds?: string[]; eventIds?: string[] }>;
  tokens: number;
}

// ---- the API an extension receives -------------------------------------------

export interface Logger {
  debug(msg: string, data?: Record<string, unknown>): void;
  info(msg: string, data?: Record<string, unknown>): void;
  warn(msg: string, data?: Record<string, unknown>): void;
  error(msg: string, data?: Record<string, unknown>): void;
}

export interface ConfigReader {
  /** Extension-scoped config from yrm.config.ts `extensions[name]`. */
  get<T = unknown>(key?: string): T | undefined;
  tenantId: string;
}

export interface ExtensionAPI {
  manifest: ExtensionManifest;
  on<E extends HookName>(hook: E, handler: HookMap[E]): void;
  registerSource(source: SourceAdapter): void;
  registerExtractor(extractor: Extractor): void;
  registerResolver(resolver: Resolver): void;
  registerRanker(ranker: Ranker): void;
  registerProvider(provider: ModelProvider): void;
  registerCommand(command: Command): void;
  registerTool(tool: Tool): void;
  store: Store;
  models: ModelRouter;
  config: ConfigReader;
  log: Logger;
  /** Cross-extension pub/sub. Not persisted. */
  events: {
    emit(topic: string, payload: unknown): void;
    on(topic: string, handler: (payload: unknown) => void): () => void;
  };
}
