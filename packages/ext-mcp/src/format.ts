import type { Entity, Fact, SourceEvent, Store } from "@yrm/core";

/** Default and maximum list sizes for every tool. Agents pay for every row in context. */
export const DEFAULT_LIMIT = 50;
export const MAX_LIMIT = 200;
/** Event text is cut here; facts, not raw text, are the preferred source. */
export const EVENT_TEXT_CHARS = 1500;

export function clampLimit(limit: number | undefined, fallback = DEFAULT_LIMIT): number {
  if (limit === undefined || !Number.isFinite(limit)) return fallback;
  return Math.max(1, Math.min(MAX_LIMIT, Math.floor(limit)));
}

export interface ProvenanceOut {
  eventId: string;
  speaker: string | null;
  quote: string | null;
  /** The cited event's title and date, so an agent can judge the source without another call. */
  event: { title: string | null; date: string | null; source: string | null; kind: string | null } | null;
}

export interface FactOut {
  id: string;
  type: string;
  statement: string;
  subject: { id: string; name: string | null };
  object: { id: string; name: string | null } | null;
  predicate: string;
  value: unknown;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  retractedAt: string | null;
  confidence: number;
  origin: Fact["origin"];
  supersedes: string | null;
  provenance: ProvenanceOut[];
}

/**
 * Resolves cited events once per tool call. Facts usually share a handful of
 * events, so this keeps provenance lookups to one read per distinct event.
 */
export class EventCache {
  private readonly cache = new Map<string, Promise<SourceEvent | null>>();

  constructor(private readonly store: Store) {}

  get(id: string): Promise<SourceEvent | null> {
    let hit = this.cache.get(id);
    if (!hit) {
      hit = this.store.getEvent(id);
      this.cache.set(id, hit);
    }
    return hit;
  }
}

export async function formatFact(fact: Fact, events: EventCache): Promise<FactOut> {
  const provenance: ProvenanceOut[] = [];
  for (const p of fact.provenance) {
    const ev = await events.get(p.eventId);
    provenance.push({
      eventId: p.eventId,
      speaker: p.speaker?.name ?? p.speaker?.entityId ?? null,
      quote: p.quote ?? null,
      event: ev
        ? { title: ev.content.title ?? null, date: ev.occurredAt, source: ev.source, kind: ev.kind }
        : null,
    });
  }
  return {
    id: fact.id,
    type: fact.type,
    statement: fact.statement,
    subject: { id: fact.subject.entityId, name: fact.subject.name ?? null },
    object: fact.object ? { id: fact.object.entityId, name: fact.object.name ?? null } : null,
    predicate: fact.predicate,
    value: fact.value,
    validFrom: fact.validFrom,
    validTo: fact.validTo ?? null,
    recordedAt: fact.recordedAt,
    retractedAt: fact.retractedAt ?? null,
    confidence: fact.confidence,
    origin: fact.origin,
    supersedes: fact.supersedes ?? null,
    provenance,
  };
}

export async function formatFacts(facts: Fact[], events: EventCache): Promise<FactOut[]> {
  const out: FactOut[] = [];
  for (const f of facts) out.push(await formatFact(f, events));
  return out;
}

export interface EntityOut {
  id: string;
  kind: string;
  name: string;
  status: string;
  mergedInto: string | null;
  identifiers: Array<{ type: string; value: string }>;
  summary: NonNullable<Entity["summary"]> | null;
}

export function formatEntity(e: Entity): EntityOut {
  return {
    id: e.id,
    kind: e.kind,
    name: e.name,
    status: e.status,
    mergedInto: e.mergedInto ?? null,
    identifiers: e.identifiers.map((i) => ({ type: i.type, value: i.value })),
    summary: e.summary ?? null,
  };
}

export interface EventOut {
  id: string;
  source: string;
  kind: string;
  occurredAt: string;
  title: string | null;
  threadKey: string | null;
  participants: Array<{ role: string; name?: string; address?: string; entityId?: string; self?: boolean }>;
  text?: string;
  truncated?: boolean;
}

export function formatEvent(e: SourceEvent, opts: { text: boolean } = { text: true }): EventOut {
  const out: EventOut = {
    id: e.id,
    source: e.source,
    kind: e.kind,
    occurredAt: e.occurredAt,
    title: e.content.title ?? null,
    threadKey: e.threadKey ?? null,
    participants: e.participants.map((p) => {
      const q: EventOut["participants"][number] = { role: p.role };
      if (p.name !== undefined) q.name = p.name;
      if (p.address !== undefined) q.address = p.address;
      if (p.entityId !== undefined) q.entityId = p.entityId;
      if (p.self) q.self = true;
      return q;
    }),
  };
  if (opts.text) {
    const text = e.content.text;
    out.text = text.length > EVENT_TEXT_CHARS ? text.slice(0, EVENT_TEXT_CHARS) : text;
    out.truncated = text.length > EVENT_TEXT_CHARS;
  }
  return out;
}

/** Newest first by world time, ties by id. */
export function byOccurredDesc(a: SourceEvent, b: SourceEvent): number {
  if (a.occurredAt !== b.occurredAt) return a.occurredAt < b.occurredAt ? 1 : -1;
  return a.id < b.id ? 1 : a.id > b.id ? -1 : 0;
}

export function byOccurredAsc(a: SourceEvent, b: SourceEvent): number {
  return -byOccurredDesc(a, b);
}
