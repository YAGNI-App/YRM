import type {
  AskValue,
  CommitmentValue,
  ContextBundle,
  ContextRequest,
  Entity,
  ExtractContext,
  Fact,
  HookContext,
  Logger,
  ModelRouter,
  NewFact,
  NewSourceEvent,
  Participant,
  QueueItem,
  RankContext,
  SourceAdapter,
  SourceEvent,
  Store,
  SyncContext,
  YrmConfig,
} from "../contracts/index.ts";
import { systemTimezone } from "./config.ts";
import { ExtensionError, messageOf } from "./errors.ts";
import type { HookBus } from "./hooks.ts";
import { prefix } from "./logger.ts";
import type { Registry } from "./registry.ts";

/** Everything a pipeline stage needs. Stages are plain functions over this. */
export interface HostContext {
  config: YrmConfig;
  store: Store;
  models: ModelRouter;
  hooks: HookBus;
  registry: Registry;
  log: Logger;
}

/** Thread context handed to extractors is trimmed to roughly this many tokens. */
export const THREAD_TOKEN_BUDGET = 6000;
/** Cap on `ExtractContext.knownFacts`. */
export const KNOWN_FACTS_LIMIT = 50;
/** Facts per entity section in a context bundle. */
export const CONTEXT_FACTS_PER_ENTITY = 20;
/** Default confidence when an extractor leaves it out. */
export const DEFAULT_CONFIDENCE = 0.5;

export function hookContext(ctx: HostContext): HookContext {
  return { tenantId: ctx.config.tenant.id, store: ctx.store, models: ctx.models, log: ctx.log };
}

/** Rough token estimate: 4 characters per token. */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function eventTokens(e: SourceEvent): number {
  return e.content.tokens ?? estimateTokens(e.content.text);
}

// ---- ingest ------------------------------------------------------------------

export interface StageOptions {
  signal?: AbortSignal;
}

export interface IngestResult {
  source: string;
  /** Events newly appended to the log, in emit order. */
  events: SourceEvent[];
  /** Re-delivered events the store already had. */
  duplicates: number;
  /** Events an `ingest:before` hook vetoed. */
  dropped: number;
}

function sourceOf(ctx: HostContext, source: SourceAdapter | string): SourceAdapter {
  if (typeof source !== "string") return source;
  const found = ctx.registry.sources.get(source);
  if (!found) {
    const known = ctx.registry.sources.list().map((s) => s.name);
    throw new ExtensionError(`unknown source "${source}"; registered: ${known.join(", ") || "(none)"}`);
  }
  return found;
}

/** Mark participants that are the tenant's own user. Lowercase compare on address and domain. */
export function markSelf(participants: Participant[], config: YrmConfig): Participant[] {
  const addresses = new Set(config.tenant.selfAddresses.map((a) => a.toLowerCase()));
  const domains = new Set((config.tenant.selfDomains ?? []).map((d) => d.toLowerCase()));
  return participants.map((p) => {
    if (p.self || !p.address) return p;
    const addr = p.address.toLowerCase();
    const at = addr.lastIndexOf("@");
    const domain = at >= 0 ? addr.slice(at + 1) : undefined;
    return addresses.has(addr) || (domain !== undefined && domains.has(domain)) ? { ...p, self: true } : p;
  });
}

async function createSyncContext(
  ctx: HostContext,
  source: SourceAdapter,
  result: IngestResult,
  opts: StageOptions,
): Promise<SyncContext> {
  const tenantId = ctx.config.tenant.id;
  const hctx = hookContext(ctx);
  return {
    tenantId,
    cursor: await ctx.store.getCursor(tenantId, source.name),
    signal: opts.signal ?? new AbortController().signal,
    log: prefix(ctx.log, source.name),
    setCursor: (cursor) => ctx.store.setCursor(tenantId, source.name, cursor),
    emit: async (events: NewSourceEvent[]) => {
      const created: SourceEvent[] = [];
      for (const incoming of events) {
        const ev = await ctx.hooks.pipe("ingest:before", hctx, incoming);
        if (ev === null) {
          result.dropped++;
          continue;
        }
        const prepared: NewSourceEvent = {
          ...ev,
          tenantId: ev.tenantId ?? tenantId,
          participants: markSelf(ev.participants, ctx.config),
          content: { ...ev.content, tokens: ev.content.tokens ?? estimateTokens(ev.content.text) },
        };
        const { event, created: isNew } = await ctx.store.appendEvent(prepared);
        if (!isNew) {
          result.duplicates++;
          continue;
        }
        await ctx.hooks.emit("ingest:after", hctx, event);
        created.push(event);
        result.events.push(event);
      }
      return created;
    },
  };
}

export async function ingest(ctx: HostContext, source: SourceAdapter | string, opts: StageOptions = {}): Promise<IngestResult> {
  const src = sourceOf(ctx, source);
  const result: IngestResult = { source: src.name, events: [], duplicates: 0, dropped: 0 };
  await src.sync(await createSyncContext(ctx, src, result, opts));
  return result;
}

export async function importPath(
  ctx: HostContext,
  source: SourceAdapter | string,
  path: string,
  opts: StageOptions = {},
): Promise<IngestResult> {
  const src = sourceOf(ctx, source);
  if (!src.importPath) throw new ExtensionError(`source "${src.name}" does not support importing a path`, src.name);
  const result: IngestResult = { source: src.name, events: [], duplicates: 0, dropped: 0 };
  await src.importPath(path, await createSyncContext(ctx, src, result, opts));
  return result;
}

// ---- resolve -----------------------------------------------------------------

export interface ResolveResult {
  /** The event with all assignments applied. */
  event: SourceEvent;
  /** Distinct entities now linked to the event's participants. */
  entities: Entity[];
  /** Participants newly assigned in this pass. */
  assigned: number;
}

export async function resolve(ctx: HostContext, event: SourceEvent): Promise<ResolveResult> {
  const tenantId = ctx.config.tenant.id;
  const participants = event.participants.map((p) => ({ ...p }));
  const fresh: Array<{ index: number; entityId: string }> = [];
  const unresolved = (): number[] =>
    participants.flatMap((p, i) => (p.entityId === undefined ? [i] : []));

  for (const resolver of ctx.registry.resolvers.list()) {
    const open = new Set(unresolved());
    if (open.size === 0) break;
    const view: SourceEvent = { ...event, participants: participants.map((p) => ({ ...p })) };
    let out: Array<{ index: number; entityId: string }>;
    try {
      out = await resolver.resolve(view, {
        tenantId,
        store: ctx.store,
        models: ctx.models,
        log: prefix(ctx.log, resolver.name),
      });
    } catch (err) {
      throw new ExtensionError(`resolver "${resolver.name}" failed on event ${event.id}: ${messageOf(err)}`, resolver.name, {
        cause: err,
      });
    }
    for (const a of out) {
      // A resolver may only fill gaps; earlier (higher-priority) answers stand.
      if (!open.has(a.index)) continue;
      const p = participants[a.index];
      if (!p) continue;
      p.entityId = a.entityId;
      open.delete(a.index);
      fresh.push(a);
    }
  }

  if (fresh.length > 0) await ctx.store.setParticipantEntities(event.id, fresh);
  const updated: SourceEvent = { ...event, participants };
  const entities = await entitiesOf(ctx, updated);
  await ctx.hooks.emit("resolve:after", hookContext(ctx), updated, entities);
  return { event: updated, entities, assigned: fresh.length };
}

async function entitiesOf(ctx: HostContext, event: SourceEvent): Promise<Entity[]> {
  const ids = [...new Set(event.participants.flatMap((p) => (p.entityId ? [p.entityId] : [])))];
  const out: Entity[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const e = (await ctx.store.resolveEntity(id)) ?? (await ctx.store.getEntity(id));
    if (e && !seen.has(e.id)) {
      seen.add(e.id);
      out.push(e);
    }
  }
  return out;
}

// ---- extract -----------------------------------------------------------------

export interface ExtractResult {
  facts: Fact[];
  /** True when `extract:before` vetoed the event. */
  skipped: boolean;
}

/** Events strictly before `event` in its thread, oldest first, newest kept when trimming. */
async function threadOf(ctx: HostContext, event: SourceEvent, budget = THREAD_TOKEN_BUDGET): Promise<SourceEvent[]> {
  if (!event.threadKey) return [];
  const all = await ctx.store.listEvents({ tenantId: event.tenantId, threadKey: event.threadKey });
  const before = all
    .filter((e) => e.id !== event.id && cmpEvent(e, event) < 0)
    .sort(cmpEvent);
  const kept: SourceEvent[] = [];
  let used = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const e = before[i]!;
    const t = eventTokens(e);
    if (used + t > budget && kept.length > 0) break;
    used += t;
    kept.push(e);
    if (used >= budget) break;
  }
  return kept.reverse();
}

function cmpEvent(a: SourceEvent, b: SourceEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? -1 : 1;
  return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
}

async function knownFactsFor(ctx: HostContext, entities: Entity[], validAt: string): Promise<Fact[]> {
  const out: Fact[] = [];
  const seen = new Set<string>();
  for (const e of entities) {
    if (out.length >= KNOWN_FACTS_LIMIT) break;
    const facts = await ctx.store.queryFacts({
      tenantId: ctx.config.tenant.id,
      entityId: e.id,
      validAt,
      limit: KNOWN_FACTS_LIMIT,
    });
    for (const f of facts) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      out.push(f);
      if (out.length >= KNOWN_FACTS_LIMIT) break;
    }
  }
  return out;
}

export async function extract(ctx: HostContext, event: SourceEvent, opts: StageOptions = {}): Promise<ExtractResult> {
  const hctx = hookContext(ctx);
  const tenantId = ctx.config.tenant.id;
  // Re-read so resolver assignments made since the caller fetched the event are visible.
  const latest = (await ctx.store.getEvent(event.id)) ?? event;
  const ev = await ctx.hooks.pipe("extract:before", hctx, latest);
  if (ev === null) return { facts: [], skipped: true };

  const now = new Date().toISOString();
  const participants = await entitiesOf(ctx, ev);
  const base = {
    tenantId,
    thread: await threadOf(ctx, ev),
    participants,
    knownFacts: await knownFactsFor(ctx, participants, now),
    models: ctx.models,
    signal: opts.signal ?? new AbortController().signal,
  };

  let proposed: NewFact[] = [];
  for (const extractor of ctx.registry.extractors.list()) {
    if (extractor.applies && !extractor.applies(ev)) continue;
    const ectx: ExtractContext = { ...base, log: prefix(ctx.log, extractor.name) };
    let facts: NewFact[];
    try {
      facts = await extractor.extract(ev, ectx);
    } catch (err) {
      throw new ExtensionError(`extractor "${extractor.name}" failed on event ${ev.id}: ${messageOf(err)}`, extractor.name, {
        cause: err,
      });
    }
    // Stamp the extractor version so re-extraction is auditable even if the extractor forgot.
    proposed = proposed.concat(
      facts.map((f) => (f.origin.version ? f : { ...f, origin: { ...f.origin, version: extractor.version } })),
    );
  }

  const filtered = await ctx.hooks.pipe("extract:after", hctx, ev, proposed);
  const recorded: Fact[] = [];
  for (const f of filtered) {
    const fact = await ctx.store.recordFact({
      ...f,
      tenantId: f.tenantId ?? tenantId,
      confidence: f.confidence ?? DEFAULT_CONFIDENCE,
      // Every fact must point at evidence; the event it came from is the minimum.
      provenance: f.provenance && f.provenance.length > 0 ? f.provenance : [{ eventId: ev.id }],
    });
    recorded.push(fact);
    await ctx.hooks.emit("fact:recorded", hctx, fact);
  }
  return { facts: recorded, skipped: false };
}

// ---- project -----------------------------------------------------------------

export async function project(ctx: HostContext, entityIds: Iterable<string>): Promise<Entity[]> {
  const tenantId = ctx.config.tenant.id;
  const now = new Date().toISOString();
  const out: Entity[] = [];
  for (const id of new Set(entityIds)) {
    const entity = await ctx.store.getEntity(id);
    if (!entity) continue;
    const events = await ctx.store.listEvents({ tenantId, entityId: id });
    let firstSeen: string | undefined;
    let lastSeen: string | undefined;
    for (const e of events) {
      if (firstSeen === undefined || e.occurredAt < firstSeen) firstSeen = e.occurredAt;
      if (lastSeen === undefined || e.occurredAt > lastSeen) lastSeen = e.occurredAt;
    }
    const commitments = await ctx.store.queryFacts({ tenantId, entityId: id, type: "commitment", validAt: now });
    const asks = await ctx.store.queryFacts({ tenantId, entityId: id, type: "ask", validAt: now });
    const summary: NonNullable<Entity["summary"]> = {
      ...entity.summary,
      eventCount: events.length,
      openCommitments: commitments.filter((f) => (f.value as Partial<CommitmentValue> | null)?.status === "open").length,
      openAsks: asks.filter((f) => (f.value as Partial<AskValue> | null)?.answered === false).length,
    };
    if (firstSeen !== undefined) summary.firstSeen = firstSeen;
    if (lastSeen !== undefined) summary.lastSeen = lastSeen;
    out.push(await ctx.store.updateEntity(id, { summary }));
  }
  return out;
}

// ---- rank --------------------------------------------------------------------

/** Today's ISO date in the tenant's timezone. */
export function todayIn(timezone: string = systemTimezone(), at: Date = new Date()): string {
  // en-CA formats as YYYY-MM-DD.
  return new Intl.DateTimeFormat("en-CA", { timeZone: timezone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** Score descending; on equal keys the first (highest-scored, earliest) wins. */
export function sortAndDedupe(items: QueueItem[]): QueueItem[] {
  const sorted = items
    .map((item, i) => ({ item, i }))
    .sort((a, b) => b.item.score - a.item.score || a.i - b.i)
    .map((x) => x.item);
  const seen = new Set<string>();
  return sorted.filter((q) => (seen.has(q.key) ? false : (seen.add(q.key), true)));
}

export async function rank(ctx: HostContext, today?: string): Promise<QueueItem[]> {
  const hctx = hookContext(ctx);
  const rctx: Omit<RankContext, "log"> = {
    tenantId: ctx.config.tenant.id,
    store: ctx.store,
    models: ctx.models,
    today: today ?? todayIn(ctx.config.tenant.timezone),
  };
  let candidates = await ctx.hooks.pipe("queue:before_rank", hctx, []);
  for (const ranker of ctx.registry.rankers.list()) {
    try {
      candidates = await ranker.rank({ ...rctx, log: prefix(ctx.log, ranker.name) }, candidates);
    } catch (err) {
      throw new ExtensionError(`ranker "${ranker.name}" failed: ${messageOf(err)}`, ranker.name, { cause: err });
    }
  }
  const ranked = await ctx.hooks.pipe("queue:after_rank", hctx, sortAndDedupe(candidates));
  return sortAndDedupe(ranked);
}

// ---- run ---------------------------------------------------------------------

export interface RunSummary {
  sources: Array<{ name: string; created: number; duplicates: number; dropped: number }>;
  events: number;
  /** Participants newly linked to entities. */
  resolved: number;
  facts: number;
  /** Events an `extract:before` hook skipped. */
  extractSkipped: number;
  entitiesProjected: number;
  queue: QueueItem[];
  timing: { ingestMs: number; resolveMs: number; extractMs: number; projectMs: number; rankMs: number; totalMs: number };
}

export async function run(ctx: HostContext, sourceName?: string, opts: StageOptions & { today?: string } = {}): Promise<RunSummary> {
  const t0 = performance.now();
  const sources = sourceName ? [sourceOf(ctx, sourceName)] : ctx.registry.sources.list();

  let mark = performance.now();
  const ingested: IngestResult[] = [];
  for (const s of sources) ingested.push(await ingest(ctx, s, opts));
  const ingestMs = performance.now() - mark;

  const created = ingested.flatMap((r) => r.events);
  const touched = new Set<string>();

  mark = performance.now();
  let resolved = 0;
  const resolvedEvents: SourceEvent[] = [];
  for (const e of created) {
    const r = await resolve(ctx, e);
    resolved += r.assigned;
    for (const ent of r.entities) touched.add(ent.id);
    resolvedEvents.push(r.event);
  }
  const resolveMs = performance.now() - mark;

  mark = performance.now();
  let facts = 0;
  let extractSkipped = 0;
  for (const e of resolvedEvents) {
    const r = await extract(ctx, e, opts);
    if (r.skipped) extractSkipped++;
    facts += r.facts.length;
    for (const f of r.facts) {
      touched.add(f.subject.entityId);
      if (f.object) touched.add(f.object.entityId);
    }
  }
  const extractMs = performance.now() - mark;

  mark = performance.now();
  const projected = await project(ctx, touched);
  const projectMs = performance.now() - mark;

  mark = performance.now();
  const queue = await rank(ctx, opts.today);
  const rankMs = performance.now() - mark;

  return {
    sources: ingested.map((r) => ({ name: r.source, created: r.events.length, duplicates: r.duplicates, dropped: r.dropped })),
    events: created.length,
    resolved,
    facts,
    extractSkipped,
    entitiesProjected: projected.length,
    queue,
    timing: { ingestMs, resolveMs, extractMs, projectMs, rankMs, totalMs: performance.now() - t0 },
  };
}

// ---- serve: context bundles ----------------------------------------------------

type Section = ContextBundle["sections"][number];

function sectionTokens(s: Section): number {
  return estimateTokens(s.title) + estimateTokens(s.text);
}

export function bundleTokens(sections: Section[]): number {
  return sections.reduce((n, s) => n + sectionTokens(s), 0);
}

function factLine(f: Fact): string {
  const p = f.provenance[0];
  const parts = [`source: ${p?.eventId ?? "unknown"}`];
  const speaker = p?.speaker?.name ?? p?.speaker?.entityId;
  if (speaker) parts.push(speaker);
  parts.push(f.validFrom.slice(0, 10));
  return `- ${f.statement} (${parts.join(", ")})`;
}

function isOpen(f: Fact): boolean {
  if (f.type === "commitment") return (f.value as Partial<CommitmentValue> | null)?.status === "open";
  if (f.type === "ask") return (f.value as Partial<AskValue> | null)?.answered === false;
  return false;
}

export async function buildContext(ctx: HostContext, request: ContextRequest): Promise<ContextBundle> {
  const tenantId = ctx.config.tenant.id;
  const at = request.asOf ?? new Date().toISOString();

  const ids: string[] = [...(request.entityIds ?? [])];
  if (request.threadKey) {
    for (const e of await ctx.store.listEvents({ tenantId, threadKey: request.threadKey })) {
      for (const p of e.participants) if (p.entityId && !p.self) ids.push(p.entityId);
    }
  }

  const sections: Section[] = [];
  const open: Fact[] = [];
  const seenEntities = new Set<string>();
  const seenOpen = new Set<string>();
  for (const id of ids) {
    const entity = (await ctx.store.resolveEntity(id)) ?? (await ctx.store.getEntity(id));
    if (!entity || seenEntities.has(entity.id)) continue;
    seenEntities.add(entity.id);
    const facts = await ctx.store.queryFacts({ tenantId, entityId: entity.id, validAt: at, asOf: at });
    const lines = [
      `Name: ${entity.name}`,
      `Identifiers: ${entity.identifiers.map((i) => `${i.type}:${i.value}`).join(", ") || "(none)"}`,
      ...facts.slice(0, CONTEXT_FACTS_PER_ENTITY).map(factLine),
    ];
    sections.push({
      title: `${entity.name} (${entity.kind})`,
      text: lines.join("\n"),
      factIds: facts.slice(0, CONTEXT_FACTS_PER_ENTITY).map((f) => f.id),
    });
    for (const f of facts) {
      if (isOpen(f) && !seenOpen.has(f.id)) {
        seenOpen.add(f.id);
        open.push(f);
      }
    }
  }
  if (open.length > 0) {
    sections.push({ title: "Open commitments and asks", text: open.map(factLine).join("\n"), factIds: open.map((f) => f.id) });
  }

  const draft: ContextBundle = { sections, tokens: bundleTokens(sections) };
  const built = await ctx.hooks.pipe("context:build", hookContext(ctx), request, draft);

  // Trim from the end: sections are ordered most-important first.
  const kept = [...built.sections];
  while (kept.length > 0 && bundleTokens(kept) > request.budget) kept.pop();
  return { sections: kept, tokens: bundleTokens(kept) };
}
