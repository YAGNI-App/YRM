import type { EventQuery, NewSourceEvent, SourceEvent } from "./events.ts";
import type { Fact, FactQuery, NewFact } from "./facts.ts";
import type { Entity, EntityQuery, NewEntity, ViewDefinition } from "./entities.ts";

/**
 * The store is the only thing that touches persistence. Core ships a SQLite
 * implementation (bun:sqlite). Postgres is a second implementation of this
 * interface, not a rewrite. Extensions never see SQL.
 */
export interface Store {
  // ---- events (append-only) -------------------------------------------------

  /**
   * Append an event. Idempotent on (tenantId, source, externalId): a duplicate
   * returns the existing event and `created: false`.
   */
  appendEvent(event: NewSourceEvent): Promise<{ event: SourceEvent; created: boolean }>;
  getEvent(id: string): Promise<SourceEvent | null>;
  listEvents(query: EventQuery): Promise<SourceEvent[]>;
  /** Update only the resolver-owned field participants[].entityId. */
  setParticipantEntities(eventId: string, map: Array<{ index: number; entityId: string }>): Promise<void>;

  // ---- facts (bi-temporal, append-only) -------------------------------------

  /**
   * Record a fact. If `supersedes` is set, the superseded fact's retractedAt is
   * set to the new fact's recordedAt and its knownUntil to the new fact's
   * knownAt (never earlier than its own). `knownAt` defaults to recordedAt and
   * is clamped to it. Applies the reconciliation rule: a model
   * or rule fact may not supersede a human fact on the same subject+predicate.
   */
  recordFact<V>(fact: NewFact<V>): Promise<Fact<V>>;
  /** Close a fact's transaction time without replacing it. */
  retractFact(id: string, by: string): Promise<void>;
  /** Close a fact's valid time: it stopped being true in the world at `validTo`. */
  endFactValidity(id: string, validTo: string, by: string): Promise<void>;
  getFact(id: string): Promise<Fact | null>;
  queryFacts(query: FactQuery): Promise<Fact[]>;

  // ---- entities (projections) -----------------------------------------------

  createEntity(entity: NewEntity): Promise<Entity>;
  getEntity(id: string): Promise<Entity | null>;
  /** Follows merges to the surviving entity. */
  resolveEntity(id: string): Promise<Entity | null>;
  findEntities(query: EntityQuery): Promise<Entity[]>;
  updateEntity(id: string, patch: Partial<Omit<Entity, "id" | "tenantId" | "createdAt">>): Promise<Entity>;
  /** Merge `from` into `into`. Moves identifiers, repoints facts and participants. */
  mergeEntities(from: string, into: string, by: string): Promise<Entity>;

  // ---- views ----------------------------------------------------------------

  defineView(tenantId: string, view: ViewDefinition): Promise<void>;
  listViews(tenantId: string): Promise<ViewDefinition[]>;

  // ---- extension state ------------------------------------------------------

  /** Per-source sync cursor (Gmail historyId, file mtime, etc.). */
  getCursor(tenantId: string, source: string): Promise<string | null>;
  setCursor(tenantId: string, source: string, cursor: string): Promise<void>;
  /** Namespaced key-value for extensions. Never enters model context. */
  kvGet<T = unknown>(namespace: string, key: string): Promise<T | null>;
  kvSet<T = unknown>(namespace: string, key: string, value: T): Promise<void>;
  kvDelete(namespace: string, key: string): Promise<void>;

  // ---- lifecycle ------------------------------------------------------------

  migrate(): Promise<void>;
  close(): Promise<void>;
}
