import type { Entity, Fact, FactQuery, Logger, QueueItem, SourceEvent, Store } from "@yrm/core";
import type { WebHost } from "./host.ts";
import { localDate } from "./time.ts";

/**
 * Everything the pages and the JSON API show is built here, from the store.
 * Pages and `/api/*` render the same objects, so what a browser sees and what
 * a script reads never drift apart. Nothing here calls a model.
 */

export interface WebDeps {
  store: Store;
  tenantId: string;
  log: Logger;
  /** The bound host, when there is one: ranking, hooks, projection. */
  host(): WebHost | null;
  /** IANA timezone used for "today" and for reading dates. */
  timezone(): string;
  /** Who page actions are attributed to, e.g. "user:jack". */
  actor(): string;
  now(): Date;
}

// ---- events ----------------------------------------------------------------

/** One fetch per event per request, however many facts cite it. */
export class EventCache {
  readonly #store: Store;
  readonly #seen = new Map<string, Promise<SourceEvent | null>>();

  constructor(store: Store) {
    this.#store = store;
  }

  get(id: string): Promise<SourceEvent | null> {
    let hit = this.#seen.get(id);
    if (!hit) {
      hit = this.#store.getEvent(id);
      this.#seen.set(id, hit);
    }
    return hit;
  }
}

export interface EventRef {
  id: string;
  title: string | null;
  occurredAt: string;
  source: string;
  kind: string;
  threadKey: string | null;
  from: string | null;
}

export function eventRef(e: SourceEvent): EventRef {
  const from = e.participants.find((p) => p.role === "from" || p.role === "organizer" || p.role === "author");
  return {
    id: e.id,
    title: e.content.title ?? null,
    occurredAt: e.occurredAt,
    source: e.source,
    kind: e.kind,
    threadKey: e.threadKey ?? null,
    from: from ? (from.name ?? from.address ?? null) : null,
  };
}

// ---- facts and provenance ---------------------------------------------------

/** Where a quote sits in its event: inside the new text, inside the stripped quoted text, or not found. */
export interface QuoteLocation {
  in: "text" | "stripped";
  start: number;
  end: number;
  /** "span": the extractor's span checked out; "search": found by looking for the quote. */
  how: "span" | "search";
}

export function locateQuote(e: Pick<SourceEvent, "content">, quote: string | undefined, span: { start: number; end: number } | undefined): QuoteLocation | null {
  const text = e.content.text;
  if (span && span.start >= 0 && span.end > span.start && span.end <= text.length) {
    const slice = text.slice(span.start, span.end);
    if (quote === undefined || slice === quote || slice.trim() === quote.trim()) return { in: "text", start: span.start, end: span.end, how: "span" };
  }
  if (!quote || quote.trim() === "") return null;
  const needle = quote.trim();
  const i = text.indexOf(needle);
  if (i >= 0) return { in: "text", start: i, end: i + needle.length, how: "search" };
  const stripped = e.content.stripped ?? "";
  const j = stripped.indexOf(needle);
  if (j >= 0) return { in: "stripped", start: j, end: j + needle.length, how: "search" };
  return null;
}

export interface ProvenanceView {
  eventId: string;
  quote: string | null;
  span: { start: number; end: number } | null;
  speaker: { entityId: string; name: string | null } | null;
  event: (EventRef & { text: string; stripped: string | null }) | null;
  location: QuoteLocation | null;
}

export type FactState = "current" | "ended" | "future" | "not-yet-known" | "retracted";

export interface FactView {
  id: string;
  type: string;
  predicate: string;
  statement: string;
  subject: { entityId: string; name: string | null };
  object: { entityId: string; name: string | null } | null;
  value: unknown;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  retractedAt: string | null;
  confidence: number;
  origin: Fact["origin"];
  supersedes: string | null;
  supersededBy: string | null;
  tags: string[];
  provenance: ProvenanceView[];
  /** Relative to the time machine; "current" when it is not engaged. */
  state: FactState;
  /** Known at `asOf` but retracted since: true then, no longer believed now. */
  laterRetractedAt: string | null;
}

export async function factView(f: Fact, events: EventCache, state: FactState = "current"): Promise<FactView> {
  const provenance: ProvenanceView[] = [];
  for (const p of f.provenance) {
    const e = await events.get(p.eventId);
    provenance.push({
      eventId: p.eventId,
      quote: p.quote ?? null,
      span: p.span ?? null,
      speaker: p.speaker ? { entityId: p.speaker.entityId, name: p.speaker.name ?? null } : null,
      event: e ? { ...eventRef(e), text: e.content.text, stripped: e.content.stripped ?? null } : null,
      location: e ? locateQuote(e, p.quote, p.span) : null,
    });
  }
  return {
    id: f.id,
    type: f.type,
    predicate: f.predicate,
    statement: f.statement,
    subject: { entityId: f.subject.entityId, name: f.subject.name ?? null },
    object: f.object ? { entityId: f.object.entityId, name: f.object.name ?? null } : null,
    value: f.value,
    validFrom: f.validFrom,
    validTo: f.validTo ?? null,
    recordedAt: f.recordedAt,
    retractedAt: f.retractedAt ?? null,
    confidence: f.confidence,
    origin: f.origin,
    supersedes: f.supersedes ?? null,
    supersededBy: null,
    tags: f.tags ?? [],
    provenance,
    state,
    laterRetractedAt: null,
  };
}

/**
 * The store answers "what was true at one instant". A timeline needs every
 * fact an entity ever had, so ask at each instant that matters (the entity's
 * events, the time-machine dates, now) with retracted facts included, and
 * merge. A fact whose validity window covers none of those instants is
 * missed; facts are dated from events, so in practice that does not happen.
 */
export async function collectFacts(store: Store, base: FactQuery, instants: Iterable<string>): Promise<Fact[]> {
  const out = new Map<string, Fact>();
  for (const at of new Set(instants)) {
    for (const f of await store.queryFacts({ ...base, validAt: at, includeRetracted: true })) out.set(f.id, f);
  }
  return [...out.values()];
}

export interface TimeMachine {
  /** World time: what was true then. ISO instant. */
  validAt: string;
  /** Belief time: what we had recorded by then. ISO instant. */
  asOf: string;
  /** The dates as the controls show them (YYYY-MM-DD), when set. */
  validDate: string | null;
  asOfDate: string | null;
  engaged: boolean;
}

export function classify(f: Fact, tm: TimeMachine, nowIso: string): FactState | null {
  const validAtV = f.validFrom <= tm.validAt && (f.validTo === undefined || f.validTo > tm.validAt);
  if (f.recordedAt > tm.asOf) {
    // Learned later. Show it only if it describes the chosen moment and we still believe it.
    const believedNow = f.retractedAt === undefined || f.retractedAt > nowIso;
    return validAtV && believedNow ? "not-yet-known" : null;
  }
  if (f.retractedAt !== undefined && f.retractedAt <= tm.asOf) return "retracted";
  if (f.validFrom > tm.validAt) return "future";
  if (f.validTo !== undefined && f.validTo <= tm.validAt) return "ended";
  return "current";
}

// ---- entities ---------------------------------------------------------------

export interface EntitySummaryView {
  id: string;
  kind: string;
  name: string;
  status: Entity["status"];
  identifiers: Entity["identifiers"];
  mergedInto: string | null;
  parentId: string | null;
  eventCount: number;
  openCommitments: number;
  openAsks: number;
  firstSeen: string | null;
  lastSeen: string | null;
}

export function entitySummary(e: Entity): EntitySummaryView {
  const s = e.summary ?? {};
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    status: e.status,
    identifiers: e.identifiers,
    mergedInto: e.mergedInto ?? null,
    parentId: s.parentId ?? null,
    eventCount: s.eventCount ?? 0,
    openCommitments: s.openCommitments ?? 0,
    openAsks: s.openAsks ?? 0,
    firstSeen: s.firstSeen ?? null,
    lastSeen: s.lastSeen ?? null,
  };
}

const ENTITY_EVENT_LIMIT = 50;
/** Instants sampled for the timeline; more events than this and the oldest stop adding instants. */
const TIMELINE_SAMPLE_LIMIT = 400;

export interface EntityPage {
  entity: EntitySummaryView;
  /** Set when the requested id was merged away and we followed it. */
  mergedFrom: string | null;
  organization: EntitySummaryView | null;
  people: EntitySummaryView[];
  timeMachine: TimeMachine;
  facts: FactView[];
  /** Facts the current time-machine setting leaves out, by reason. */
  hidden: { retracted: number; laterOrFuture: number };
  events: EventRef[];
}

export async function entityPage(deps: WebDeps, id: string, tm: TimeMachine): Promise<EntityPage | null> {
  const { store, tenantId } = deps;
  const entity = await store.resolveEntity(id);
  if (!entity) return null;
  const parentId = entity.summary?.parentId;
  const parent = parentId ? await store.resolveEntity(parentId) : null;
  const people =
    entity.kind === "organization"
      ? (await store.findEntities({ tenantId, parentId: entity.id })).filter((p) => p.status !== "merged")
      : [];

  // An organization's events are its people's events.
  const eventMap = new Map<string, SourceEvent>();
  for (const who of [entity, ...people]) {
    for (const e of await store.listEvents({ tenantId, entityId: who.id })) eventMap.set(e.id, e);
  }
  const events = [...eventMap.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt));

  const nowIso = deps.now().toISOString();
  const instants = [nowIso, tm.validAt, ...events.slice(0, TIMELINE_SAMPLE_LIMIT).map((e) => e.occurredAt)];
  const all = await collectFacts(store, { tenantId, entityId: entity.id }, instants);
  const supersededBy = new Map<string, string>();
  for (const f of all) if (f.supersedes) supersededBy.set(f.supersedes, f.id);

  const cache = new EventCache(store);
  const facts: FactView[] = [];
  const hidden = { retracted: 0, laterOrFuture: 0 };
  for (const f of all) {
    const state = classify(f, tm, nowIso);
    if (state === null) {
      hidden.laterOrFuture++;
      continue;
    }
    // Without the time machine, the page shows what we believe now; history is one click away.
    if (!tm.engaged && state === "retracted") {
      hidden.retracted++;
      continue;
    }
    const v = await factView(f, cache, state);
    v.supersededBy = supersededBy.get(f.id) ?? null;
    if (state !== "retracted" && state !== "not-yet-known" && f.retractedAt !== undefined && f.retractedAt <= nowIso) {
      v.laterRetractedAt = f.retractedAt;
    }
    facts.push(v);
  }
  facts.sort((a, b) => a.validFrom.localeCompare(b.validFrom) || a.recordedAt.localeCompare(b.recordedAt));

  return {
    entity: entitySummary(entity),
    mergedFrom: entity.id !== id ? id : null,
    organization: parent ? entitySummary(parent) : null,
    people: people.map(entitySummary),
    timeMachine: tm,
    facts,
    hidden,
    events: events.slice(0, ENTITY_EVENT_LIMIT).map(eventRef),
  };
}

export interface DirectoryGroup {
  organization: EntitySummaryView | null;
  people: EntitySummaryView[];
}

export interface MergeSuggestionView {
  key: string;
  from: EntitySummaryView;
  into: EntitySummaryView;
  reason: string;
  score: number;
  evidence: string[];
}

/** People grouped under their organization, organizations by name, the unaffiliated last. */
export async function peopleDirectory(deps: WebDeps): Promise<{ groups: DirectoryGroup[]; rejected: EntitySummaryView[] }> {
  const { store, tenantId } = deps;
  const people = (await store.findEntities({ tenantId, kind: "person" })).filter((p) => p.status !== "merged");
  const orgs = new Map((await store.findEntities({ tenantId, kind: "organization" })).map((o) => [o.id, o]));
  const groups = new Map<string, DirectoryGroup>();
  const rejected: EntitySummaryView[] = [];
  for (const p of people) {
    if (p.status === "rejected") {
      rejected.push(entitySummary(p));
      continue;
    }
    const org = p.summary?.parentId ? orgs.get(p.summary.parentId) : undefined;
    const key = org?.id ?? "";
    let g = groups.get(key);
    if (!g) {
      g = { organization: org ? entitySummary(org) : null, people: [] };
      groups.set(key, g);
    }
    g.people.push(entitySummary(p));
  }
  for (const g of groups.values()) g.people.sort(byLastSeenThenName);
  const ordered = [...groups.values()].sort((a, b) => {
    if (!a.organization) return 1;
    if (!b.organization) return -1;
    return a.organization.name.localeCompare(b.organization.name);
  });
  return { groups: ordered, rejected: rejected.sort(byLastSeenThenName) };
}

export async function orgDirectory(deps: WebDeps): Promise<Array<EntitySummaryView & { people: number; domains: string[] }>> {
  const { store, tenantId } = deps;
  const orgs = (await store.findEntities({ tenantId, kind: "organization" })).filter((o) => o.status !== "merged");
  const people = await store.findEntities({ tenantId, kind: "person" });
  const count = new Map<string, number>();
  for (const p of people) {
    const pid = p.summary?.parentId;
    if (pid && p.status !== "merged" && p.status !== "rejected") count.set(pid, (count.get(pid) ?? 0) + 1);
  }
  return orgs
    .map((o) => ({
      ...entitySummary(o),
      people: count.get(o.id) ?? 0,
      domains: o.identifiers.filter((i) => i.type === "domain").map((i) => i.value),
    }))
    .sort((a, b) => (a.status === "rejected" ? 1 : 0) - (b.status === "rejected" ? 1 : 0) || byLastSeenThenName(a, b));
}

function byLastSeenThenName(a: EntitySummaryView, b: EntitySummaryView): number {
  return (b.lastSeen ?? "").localeCompare(a.lastSeen ?? "") || a.name.localeCompare(b.name);
}

// ---- merge suggestions (owned by @yrm/ext-resolve) -------------------------

/**
 * `@yrm/ext-resolve` keeps suggestions at `suggest:<a>:<b>` in its `resolve`
 * kv namespace and, because the store cannot list kv keys, an index of open
 * keys at `suggestions:<tenant>`. Read through the index; when a merge is done
 * here, drop the key from both the same way `resolve:merge` does.
 */
const RESOLVE_NS = "resolve";
const suggestionsIndexKey = (tenantId: string): string => `suggestions:${tenantId}`;
export const suggestionKey = (a: string, b: string): string => `suggest:${[a, b].sort().join(":")}`;

interface StoredSuggestion {
  from: string;
  into: string;
  reason: string;
  evidence: string[];
  score: number;
}

function isStoredSuggestion(v: unknown): v is StoredSuggestion {
  if (typeof v !== "object" || v === null) return false;
  const s = v as Record<string, unknown>;
  return typeof s["from"] === "string" && typeof s["into"] === "string" && typeof s["score"] === "number";
}

export async function mergeSuggestions(deps: WebDeps): Promise<MergeSuggestionView[]> {
  const { store, tenantId } = deps;
  const keys = (await store.kvGet<string[]>(RESOLVE_NS, suggestionsIndexKey(tenantId))) ?? [];
  const out: MergeSuggestionView[] = [];
  for (const key of Array.isArray(keys) ? keys : []) {
    const s = await store.kvGet<unknown>(RESOLVE_NS, key);
    if (!isStoredSuggestion(s)) continue;
    const from = await store.getEntity(s.from);
    const into = await store.resolveEntity(s.into);
    // Already merged (here or by the CLI), or one side rejected: nothing left to suggest.
    if (!from || !into || from.status === "merged" || from.status === "rejected" || into.status === "rejected" || from.id === into.id) continue;
    out.push({
      key,
      from: entitySummary(from),
      into: entitySummary(into),
      reason: typeof s.reason === "string" ? s.reason : "",
      score: s.score,
      evidence: Array.isArray(s.evidence) ? s.evidence.filter((x): x is string => typeof x === "string") : [],
    });
  }
  return out.sort((a, b) => b.score - a.score);
}

export async function dropSuggestion(store: Store, tenantId: string, from: string, into: string): Promise<void> {
  const key = suggestionKey(from, into);
  await store.kvDelete(RESOLVE_NS, key);
  const index = (await store.kvGet<string[]>(RESOLVE_NS, suggestionsIndexKey(tenantId))) ?? [];
  if (Array.isArray(index) && index.includes(key)) {
    await store.kvSet(RESOLVE_NS, suggestionsIndexKey(tenantId), index.filter((k) => k !== key));
  }
}

// ---- the attention queue ----------------------------------------------------

/**
 * Shared with `@yrm/ext-attention` and `@yrm/ext-mcp`: the last ranked queue
 * lives at `attention/queue:last`, dismissals at `attention/dismiss:<key>`.
 */
export const ATTENTION_NS = "attention";
const LAST_QUEUE_KEY = "queue:last";
export const dismissKey = (key: string): string => `dismiss:${key}`;

export interface Dismissal {
  key: string;
  until: string | null;
  by: string;
  at: string;
}

export interface QueueItemView {
  key: string;
  action: string;
  reason: string;
  score: number;
  dueAt: string | null;
  by: string;
  about: Array<{ entityId: string; name: string; kind: string | null; status: string | null }>;
  evidence: { facts: FactView[]; events: EventRef[]; missing: string[] };
}

export interface TodayPage {
  date: string;
  /** "ranked": host.rank ran for this date; "stored": the last queue a ranker saved; "none": nothing to show. */
  source: "ranked" | "stored" | "none";
  rankedAt: string | null;
  items: QueueItemView[];
  rankers: boolean;
}

interface StoredQueue {
  at: string;
  items: QueueItem[];
}

/**
 * Ranking can run the model brief when a `synthesize` route is configured, so
 * results are kept per date for the life of the server: browsing never costs
 * more than one rank per day shown. "Re-rank" clears the entry; so does any
 * write made through the dashboard.
 */
export class RankCache {
  readonly #byDate = new Map<string, Promise<{ at: string; items: QueueItem[] }>>();

  get(host: WebHost, date: string, now: () => Date): Promise<{ at: string; items: QueueItem[] }> {
    let hit = this.#byDate.get(date);
    if (!hit) {
      hit = host.rank(date).then((items) => ({ at: now().toISOString(), items }));
      hit.catch(() => this.#byDate.delete(date));
      this.#byDate.set(date, hit);
    }
    return hit;
  }

  clear(date?: string): void {
    if (date === undefined) this.#byDate.clear();
    else this.#byDate.delete(date);
  }
}

async function isDismissed(store: Store, key: string, date: string): Promise<boolean> {
  const d = await store.kvGet<Dismissal>(ATTENTION_NS, dismissKey(key));
  if (d === null) return false;
  return d.until === null || d.until.slice(0, 10) > date;
}

export async function todayPage(deps: WebDeps, cache: RankCache, date: string): Promise<TodayPage> {
  const { store } = deps;
  const host = deps.host();
  let raw: QueueItem[] = [];
  let source: TodayPage["source"] = "none";
  let rankedAt: string | null = null;
  if (host) {
    const ranked = await cache.get(host, date, () => deps.now());
    raw = ranked.items;
    rankedAt = ranked.at;
    source = "ranked";
  } else {
    // No host to rank with: show the queue the last `yrm today` saved, and say so.
    const last = await store.kvGet<StoredQueue>(ATTENTION_NS, LAST_QUEUE_KEY);
    if (last && Array.isArray(last.items)) {
      raw = last.items;
      rankedAt = last.at;
      source = "stored";
    }
  }

  const events = new EventCache(store);
  const entities = new Map<string, Entity | null>();
  const entity = async (id: string): Promise<Entity | null> => {
    if (!entities.has(id)) entities.set(id, await store.resolveEntity(id));
    return entities.get(id) ?? null;
  };

  const items: QueueItemView[] = [];
  for (const it of raw) {
    if (await isDismissed(store, it.key, date)) continue;
    const about: QueueItemView["about"] = [];
    for (const a of it.about) {
      const e = await entity(a.entityId);
      about.push({ entityId: e?.id ?? a.entityId, name: e?.name ?? a.name ?? a.entityId, kind: e?.kind ?? null, status: e?.status ?? null });
    }
    const facts: FactView[] = [];
    const missing: string[] = [];
    const cited = new Set<string>();
    for (const id of it.evidence.factIds) {
      const f = await store.getFact(id);
      if (!f) {
        missing.push(id);
        continue;
      }
      const v = await factView(f, events);
      for (const p of v.provenance) cited.add(p.eventId);
      facts.push(v);
    }
    const evs: EventRef[] = [];
    for (const id of it.evidence.eventIds) {
      if (cited.has(id)) continue;
      const e = await events.get(id);
      if (e) evs.push(eventRef(e));
      else missing.push(id);
    }
    items.push({
      key: it.key,
      action: it.action,
      reason: it.reason,
      score: it.score,
      dueAt: it.dueAt ?? null,
      by: it.by,
      about,
      evidence: { facts, events: evs, missing },
    });
  }
  return { date, source, rankedAt, items, rankers: host !== null };
}

// ---- facts list -------------------------------------------------------------

export interface FactsFilter {
  type?: string;
  predicate?: string;
  q?: string;
  tm: TimeMachine;
}

const FACTS_LIMIT = 500;

export async function factsPage(deps: WebDeps, filter: FactsFilter): Promise<{ facts: FactView[]; truncated: boolean; predicates: string[] }> {
  const { store, tenantId } = deps;
  const q: FactQuery = { tenantId, validAt: filter.tm.validAt, asOf: filter.tm.asOf, limit: FACTS_LIMIT + 1 };
  if (filter.type) q.type = filter.type;
  if (filter.predicate) q.predicate = filter.predicate;
  let facts = await store.queryFacts(q);
  const truncated = facts.length > FACTS_LIMIT;
  facts = facts.slice(0, FACTS_LIMIT);
  const predicates = [...new Set(facts.map((f) => f.predicate))].sort();
  const needle = filter.q?.trim().toLowerCase();
  if (needle) {
    facts = facts.filter((f) =>
      [f.statement, f.predicate, f.subject.name ?? "", f.object?.name ?? "", ...f.provenance.map((p) => p.quote ?? "")]
        .join("\n")
        .toLowerCase()
        .includes(needle),
    );
  }
  facts.sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const cache = new EventCache(store);
  const out: FactView[] = [];
  for (const f of facts) out.push(await factView(f, cache));
  return { facts: out, truncated, predicates };
}

// ---- threads and events -----------------------------------------------------

export interface ParticipantView {
  role: string;
  address: string | null;
  name: string | null;
  self: boolean;
  entity: { id: string; name: string; status: string } | null;
}

export interface EventPage {
  event: EventRef & { text: string; stripped: string | null; ingestedAt: string; meta: Record<string, unknown> };
  participants: ParticipantView[];
  facts: FactView[];
}

/** Facts whose provenance cites this event. Found through the event's participants' facts. */
async function factsFromEvent(deps: WebDeps, e: SourceEvent, events: EventCache): Promise<FactView[]> {
  const ids = [...new Set(e.participants.map((p) => p.entityId).filter((x): x is string => x !== undefined))];
  const instants = [e.occurredAt, deps.now().toISOString()];
  const found = new Map<string, Fact>();
  for (const id of ids) {
    for (const f of await collectFacts(deps.store, { tenantId: deps.tenantId, entityId: id }, instants)) {
      if (f.provenance.some((p) => p.eventId === e.id)) found.set(f.id, f);
    }
  }
  const nowIso = deps.now().toISOString();
  const out: FactView[] = [];
  for (const f of [...found.values()].sort((a, b) => a.recordedAt.localeCompare(b.recordedAt))) {
    const retracted = f.retractedAt !== undefined && f.retractedAt <= nowIso;
    out.push(await factView(f, events, retracted ? "retracted" : "current"));
  }
  return out;
}

export async function eventPage(deps: WebDeps, e: SourceEvent, events = new EventCache(deps.store)): Promise<EventPage> {
  const participants: ParticipantView[] = [];
  for (const p of e.participants) {
    const ent = p.entityId ? await deps.store.resolveEntity(p.entityId) : null;
    participants.push({
      role: p.role,
      address: p.address ?? null,
      name: p.name ?? null,
      self: p.self === true,
      entity: ent ? { id: ent.id, name: ent.name, status: ent.status } : null,
    });
  }
  return {
    event: { ...eventRef(e), text: e.content.text, stripped: e.content.stripped ?? null, ingestedAt: e.ingestedAt, meta: e.meta },
    participants,
    facts: await factsFromEvent(deps, e, events),
  };
}

export async function threadPage(deps: WebDeps, threadKey: string): Promise<EventPage[]> {
  const list = await deps.store.listEvents({ tenantId: deps.tenantId, threadKey });
  list.sort((a, b) => a.occurredAt.localeCompare(b.occurredAt) || a.id.localeCompare(b.id));
  const cache = new EventCache(deps.store);
  const out: EventPage[] = [];
  for (const e of list) out.push(await eventPage(deps, e, cache));
  return out;
}

// ---- writes ----------------------------------------------------------------

function hookCtx(deps: WebDeps, host: WebHost) {
  return { tenantId: deps.tenantId, store: deps.store, models: host.models, log: host.log };
}

export async function setEntityStatus(deps: WebDeps, id: string, status: "confirmed" | "rejected"): Promise<Entity | null> {
  const entity = await deps.store.resolveEntity(id);
  if (!entity) return null;
  const updated = await deps.store.updateEntity(entity.id, { status });
  const host = deps.host();
  // There is no entity:rejected hook in the contract; confirmation is the only one to fire.
  if (status === "confirmed" && host) await host.hooks.emit("entity:confirmed", hookCtx(deps, host), updated);
  deps.log.info(`entity ${status}`, { id: updated.id, by: deps.actor() });
  return updated;
}

export async function mergeEntities(deps: WebDeps, fromId: string, intoId: string): Promise<{ from: Entity; into: Entity }> {
  const { store } = deps;
  const by = deps.actor();
  const into = await store.mergeEntities(fromId, intoId, by);
  const from = await store.getEntity(fromId);
  await dropSuggestion(store, deps.tenantId, fromId, intoId);
  const host = deps.host();
  if (host && from) {
    await host.hooks.emit("entity:merged", hookCtx(deps, host), from, into);
    await host.project([into.id]);
  }
  deps.log.info("entities merged", { from: fromId, into: into.id, by });
  return { from: from ?? into, into };
}

export async function dismissItem(deps: WebDeps, key: string, until: string | null): Promise<Dismissal> {
  const d: Dismissal = { key, until, by: deps.actor(), at: deps.now().toISOString() };
  await deps.store.kvSet(ATTENTION_NS, dismissKey(key), d);
  return d;
}

// ---- time machine -------------------------------------------------------------

export function timeMachine(
  nowIso: string,
  tz: string,
  valid: { iso?: string; date?: string },
  asOf: { iso?: string; date?: string },
): TimeMachine {
  return {
    validAt: valid.iso ?? nowIso,
    asOf: asOf.iso ?? nowIso,
    validDate: valid.date ?? null,
    asOfDate: asOf.date ?? null,
    engaged: valid.iso !== undefined || asOf.iso !== undefined,
  };
}

/** The earliest day the time machine's slider should reach: the oldest event, or a year back. */
export async function earliestDay(deps: WebDeps, tz: string): Promise<string> {
  // The log sorts by ingest, not occurrence; the oldest of the first few hundred is close enough for a slider.
  const sample = await deps.store.listEvents({ tenantId: deps.tenantId, limit: 500 });
  const today = localDate(deps.now().toISOString(), tz);
  let min = today;
  for (const e of sample) {
    const d = localDate(e.occurredAt, tz);
    if (d < min) min = d;
  }
  return min === today ? `${Number(today.slice(0, 4)) - 1}${today.slice(4)}` : min;
}
