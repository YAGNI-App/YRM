import { ulid } from "ulid";
import type {
  Entity,
  EntityQuery,
  EventQuery,
  Fact,
  FactQuery,
  NewEntity,
  NewFact,
  NewSourceEvent,
  SourceEvent,
  Store,
  ViewDefinition,
} from "../contracts/index.ts";

const clone = <T>(v: T): T => structuredClone(v);
const asArray = <T>(v: T | T[] | undefined): T[] | undefined => (v === undefined ? undefined : Array.isArray(v) ? v : [v]);

/**
 * Map-backed Store for tests. Faithful on idempotency, supersedes and the
 * human-beats-model rule, identifier lookup, cursors and kv; bi-temporal
 * filtering is the simple interval check, not the full SQLite semantics.
 */
export class MemoryStore implements Store {
  readonly events = new Map<string, SourceEvent>();
  readonly facts = new Map<string, Fact>();
  readonly entities = new Map<string, Entity>();
  private readonly eventKeys = new Map<string, string>();
  private readonly views = new Map<string, ViewDefinition[]>();
  private readonly cursors = new Map<string, string>();
  private readonly kv = new Map<string, unknown>();
  closed = false;

  constructor(private readonly defaultTenant = "local") {}

  // ---- events ----

  async appendEvent(input: NewSourceEvent): Promise<{ event: SourceEvent; created: boolean }> {
    const tenantId = input.tenantId ?? this.defaultTenant;
    const key = `${tenantId}\u0000${input.source}\u0000${input.externalId}`;
    const existing = this.eventKeys.get(key);
    if (existing) return { event: clone(this.events.get(existing)!), created: false };
    const event: SourceEvent = { ...clone(input), id: ulid(), tenantId, ingestedAt: new Date().toISOString() };
    this.events.set(event.id, event);
    this.eventKeys.set(key, event.id);
    return { event: clone(event), created: true };
  }

  async getEvent(id: string): Promise<SourceEvent | null> {
    const e = this.events.get(id);
    return e ? clone(e) : null;
  }

  async listEvents(q: EventQuery): Promise<SourceEvent[]> {
    let out = [...this.events.values()].filter(
      (e) =>
        (q.tenantId === undefined || e.tenantId === q.tenantId) &&
        (q.source === undefined || e.source === q.source) &&
        (q.kind === undefined || e.kind === q.kind) &&
        (q.threadKey === undefined || e.threadKey === q.threadKey) &&
        (q.address === undefined || e.participants.some((p) => p.address === q.address)) &&
        (q.entityId === undefined || e.participants.some((p) => p.entityId === q.entityId)) &&
        (q.occurredAfter === undefined || e.occurredAt > q.occurredAfter) &&
        (q.occurredBefore === undefined || e.occurredAt < q.occurredBefore) &&
        (q.afterId === undefined || e.id > q.afterId),
    );
    out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
    if (q.limit !== undefined) out = out.slice(0, q.limit);
    return out.map(clone);
  }

  async setParticipantEntities(eventId: string, map: Array<{ index: number; entityId: string }>): Promise<void> {
    const e = this.events.get(eventId);
    if (!e) throw new Error(`event ${eventId} not found`);
    for (const { index, entityId } of map) {
      const p = e.participants[index];
      if (!p) throw new Error(`event ${eventId} has no participant ${index}`);
      p.entityId = entityId;
    }
  }

  // ---- facts ----

  async recordFact<V>(input: NewFact<V>): Promise<Fact<V>> {
    const recordedAt = new Date().toISOString();
    const knownAt = input.knownAt !== undefined && input.knownAt < recordedAt ? input.knownAt : recordedAt;
    if (input.supersedes) {
      const old = this.facts.get(input.supersedes);
      if (!old) throw new Error(`cannot supersede unknown fact ${input.supersedes}`);
      if (
        old.origin.kind === "human" &&
        input.origin.kind !== "human" &&
        old.subject.entityId === input.subject.entityId &&
        old.predicate === input.predicate
      ) {
        throw new Error(`a ${input.origin.kind} fact may not supersede human fact ${old.id}`);
      }
      old.retractedAt = recordedAt;
      const oldKnown = old.knownAt ?? old.recordedAt;
      old.knownUntil = knownAt > oldKnown ? knownAt : oldKnown;
    }
    const fact: Fact<V> = {
      ...clone(input),
      id: ulid(),
      tenantId: input.tenantId ?? this.defaultTenant,
      recordedAt,
      knownAt,
    };
    this.facts.set(fact.id, fact as Fact);
    return clone(fact);
  }

  async retractFact(id: string): Promise<void> {
    const f = this.facts.get(id);
    if (!f) throw new Error(`fact ${id} not found`);
    f.retractedAt ??= new Date().toISOString();
    f.knownUntil ??= f.retractedAt;
  }

  async endFactValidity(id: string, validTo: string): Promise<void> {
    const f = this.facts.get(id);
    if (!f) throw new Error(`fact ${id} not found`);
    f.validTo = validTo;
  }

  async getFact(id: string): Promise<Fact | null> {
    const f = this.facts.get(id);
    return f ? clone(f) : null;
  }

  async queryFacts(q: FactQuery): Promise<Fact[]> {
    const now = new Date().toISOString();
    const validAt = q.validAt ?? now;
    const asOf = q.asOf ?? now;
    const types = asArray(q.type);
    let out = [...this.facts.values()].filter((f) => {
      if (q.tenantId !== undefined && f.tenantId !== q.tenantId) return false;
      if (types && !types.includes(f.type)) return false;
      if (q.predicate !== undefined && f.predicate !== q.predicate) return false;
      if (q.subjectId !== undefined && f.subject.entityId !== q.subjectId) return false;
      if (q.objectId !== undefined && f.object?.entityId !== q.objectId) return false;
      if (q.entityId !== undefined && f.subject.entityId !== q.entityId && f.object?.entityId !== q.entityId) return false;
      if (q.minConfidence !== undefined && f.confidence < q.minConfidence) return false;
      if (q.tags && !q.tags.every((t) => f.tags?.includes(t))) return false;
      if (!q.includeRetracted) {
        if ((f.knownAt ?? f.recordedAt) > asOf) return false;
        const until = f.knownUntil ?? f.retractedAt;
        if (until !== undefined && until <= asOf) return false;
        if (f.validFrom > validAt) return false;
        if (f.validTo !== undefined && f.validTo <= validAt) return false;
      }
      return true;
    });
    out.sort((a, b) => (a.id < b.id ? -1 : 1));
    if (q.limit !== undefined) out = out.slice(0, q.limit);
    return out.map(clone);
  }

  // ---- entities ----

  async createEntity(input: NewEntity): Promise<Entity> {
    const now = new Date().toISOString();
    const entity: Entity = { ...clone(input), id: ulid(), tenantId: input.tenantId ?? this.defaultTenant, createdAt: now, updatedAt: now };
    this.entities.set(entity.id, entity);
    return clone(entity);
  }

  async getEntity(id: string): Promise<Entity | null> {
    const e = this.entities.get(id);
    return e ? clone(e) : null;
  }

  async resolveEntity(id: string): Promise<Entity | null> {
    let e = this.entities.get(id);
    const seen = new Set<string>();
    while (e && e.status === "merged" && e.mergedInto && !seen.has(e.id)) {
      seen.add(e.id);
      e = this.entities.get(e.mergedInto);
    }
    return e ? clone(e) : null;
  }

  async findEntities(q: EntityQuery): Promise<Entity[]> {
    const kinds = asArray(q.kind);
    const statuses = asArray(q.status);
    const name = q.nameLike?.toLowerCase();
    let out = [...this.entities.values()].filter(
      (e) =>
        (q.tenantId === undefined || e.tenantId === q.tenantId) &&
        (!kinds || kinds.includes(e.kind)) &&
        (!statuses || statuses.includes(e.status)) &&
        (q.parentId === undefined || e.summary?.parentId === q.parentId) &&
        (name === undefined || e.name.toLowerCase().includes(name)) &&
        (q.identifier === undefined ||
          e.identifiers.some(
            (i) => i.value === q.identifier!.value && (q.identifier!.type === undefined || i.type === q.identifier!.type),
          )),
    );
    if (q.limit !== undefined) out = out.slice(0, q.limit);
    return out.map(clone);
  }

  async updateEntity(id: string, patch: Partial<Omit<Entity, "id" | "tenantId" | "createdAt">>): Promise<Entity> {
    const e = this.entities.get(id);
    if (!e) throw new Error(`entity ${id} not found`);
    Object.assign(e, clone(patch), { updatedAt: new Date().toISOString() });
    return clone(e);
  }

  async mergeEntities(from: string, into: string): Promise<Entity> {
    const a = this.entities.get(from);
    const b = this.entities.get(into);
    if (!a || !b) throw new Error("cannot merge unknown entities");
    b.identifiers.push(...a.identifiers.filter((i) => !b.identifiers.some((j) => j.type === i.type && j.value === i.value)));
    a.status = "merged";
    a.mergedInto = into;
    for (const f of this.facts.values()) {
      if (f.subject.entityId === from) f.subject.entityId = into;
      if (f.object?.entityId === from) f.object.entityId = into;
    }
    for (const e of this.events.values()) for (const p of e.participants) if (p.entityId === from) p.entityId = into;
    return clone(b);
  }

  // ---- views ----

  async defineView(tenantId: string, view: ViewDefinition): Promise<void> {
    const list = (this.views.get(tenantId) ?? []).filter((v) => v.name !== view.name);
    list.push(clone(view));
    this.views.set(tenantId, list);
  }

  async listViews(tenantId: string): Promise<ViewDefinition[]> {
    return clone(this.views.get(tenantId) ?? []);
  }

  // ---- extension state ----

  async getCursor(tenantId: string, source: string): Promise<string | null> {
    return this.cursors.get(`${tenantId}\u0000${source}`) ?? null;
  }

  async setCursor(tenantId: string, source: string, cursor: string): Promise<void> {
    this.cursors.set(`${tenantId}\u0000${source}`, cursor);
  }

  async kvGet<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const k = `${namespace}\u0000${key}`;
    return this.kv.has(k) ? (clone(this.kv.get(k)) as T) : null;
  }

  async kvSet<T = unknown>(namespace: string, key: string, value: T): Promise<void> {
    this.kv.set(`${namespace}\u0000${key}`, clone(value));
  }

  async kvDelete(namespace: string, key: string): Promise<void> {
    this.kv.delete(`${namespace}\u0000${key}`);
  }

  // ---- lifecycle ----

  async migrate(): Promise<void> {}

  async close(): Promise<void> {
    this.closed = true;
  }
}
