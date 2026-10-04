import { Database } from "bun:sqlite";
import type {
  Entity,
  EntityQuery,
  EventQuery,
  Fact,
  FactQuery,
  Identifier,
  NewEntity,
  NewFact,
  NewSourceEvent,
  Participant,
  Provenance,
  SourceEvent,
  Store,
  ViewDefinition,
} from "../contracts/index.ts";
import { StoreError } from "../errors.ts";
import { newId } from "../ids.ts";
import { applyMigrations } from "./schema.ts";

/** Tenant used when a caller omits one. A solo install has exactly this tenant. */
export const DEFAULT_TENANT = "local";

/**
 * Confidence ceiling for a model or rule fact recorded alongside a believed
 * human fact on the same subject and predicate. Below 0.5 so any "probably
 * true" threshold keeps preferring the human fact; the data is kept for audit.
 */
export const HUMAN_OUTRANKED_CONFIDENCE_CAP = 0.49;

export interface SqliteStoreOptions {
  /** File path, or ":memory:". */
  path: string;
  /** Clock override for tests. Defaults to the system clock. */
  clock?: () => Date;
}

/** One model invocation, as the router records it. */
export interface ModelCallRecord {
  /** Assigned by the store when omitted. */
  id?: string;
  tenantId: string;
  tier: string;
  provider: string;
  model: string;
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  costUsd?: number;
  latencyMs?: number;
  /** Defaults to now. */
  createdAt?: string;
  meta?: Record<string, unknown>;
}

type Param = string | number | null;

interface EventRow {
  id: string;
  tenant_id: string;
  source: string;
  kind: string;
  external_id: string;
  occurred_at: string;
  ingested_at: string;
  thread_key: string | null;
  in_reply_to: string | null;
  content_json: string;
  meta_json: string;
  raw_ref: string | null;
}

interface ParticipantRow {
  event_id: string;
  idx: number;
  role: string;
  address: string | null;
  name: string | null;
  entity_id: string | null;
  self: number | null;
}

interface FactRow {
  id: string;
  tenant_id: string;
  type: string;
  subject_id: string;
  subject_name: string | null;
  object_id: string | null;
  object_name: string | null;
  predicate: string;
  value_json: string;
  statement: string;
  valid_from: string;
  valid_to: string | null;
  recorded_at: string;
  retracted_at: string | null;
  confidence: number;
  origin_kind: string;
  origin_by: string;
  origin_model: string | null;
  origin_version: string | null;
  supersedes: string | null;
  tags_json: string | null;
}

interface ProvenanceRow {
  fact_id: string;
  idx: number;
  event_id: string;
  speaker_id: string | null;
  speaker_name: string | null;
  quote: string | null;
  span_start: number | null;
  span_end: number | null;
}

interface EntityRow {
  id: string;
  tenant_id: string;
  kind: string;
  name: string;
  status: string;
  merged_into: string | null;
  identifiers_json: string;
  summary_json: string | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Normalize any parseable time to ISO 8601 UTC so text order is time order. */
function iso(value: string, field: string): string {
  const t = Date.parse(value);
  if (Number.isNaN(t)) {
    throw new StoreError("INVALID_TIME", `${field} is not a valid ISO 8601 time: ${JSON.stringify(value)}`);
  }
  return new Date(t).toISOString();
}

function requireText(value: string, field: string): void {
  if (typeof value !== "string" || value.length === 0) {
    throw new StoreError("INVALID_INPUT", `${field} must be a non-empty string`);
  }
}

function placeholders(n: number): string {
  return Array.from({ length: n }, () => "?").join(", ");
}

function asArray<T>(v: T | T[]): T[] {
  return Array.isArray(v) ? v : [v];
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function identifierKey(i: Pick<Identifier, "type" | "value">): string {
  return `${i.type}\u0000${i.value}`;
}

/**
 * SQLite implementation of `Store` on bun:sqlite.
 *
 * Events and facts have no UPDATE path except the columns the contract hands
 * to the store: participant entity ids, fact retractedAt/validTo, and the
 * entity repointing a merge requires.
 */
export class SqliteStore implements Store {
  #db: Database | null;
  readonly #clock: () => Date;

  constructor(options: SqliteStoreOptions) {
    this.#db = new Database(options.path, { create: true, strict: true });
    this.#clock = options.clock ?? (() => new Date());
    this.#db.run("PRAGMA journal_mode = WAL");
    this.#db.run("PRAGMA foreign_keys = ON");
    this.#db.run("PRAGMA busy_timeout = 5000");
  }

  private get db(): Database {
    if (!this.#db) throw new StoreError("STORE_CLOSED", "store is closed");
    return this.#db;
  }

  private now(): string {
    return this.#clock().toISOString();
  }

  // ---- lifecycle ------------------------------------------------------------

  async migrate(): Promise<void> {
    applyMigrations(this.db, () => this.now());
  }

  async close(): Promise<void> {
    const db = this.#db;
    this.#db = null;
    db?.close();
  }

  // ---- events ---------------------------------------------------------------

  async appendEvent(input: NewSourceEvent): Promise<{ event: SourceEvent; created: boolean }> {
    const db = this.db;
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    requireText(input.source, "source");
    requireText(input.kind, "kind");
    requireText(input.externalId, "externalId");
    const occurredAt = iso(input.occurredAt, "occurredAt");

    return db.transaction(() => {
      const existing = db
        .query<{ id: string }, [string, string, string]>(
          "SELECT id FROM events WHERE tenant_id = ? AND source = ? AND external_id = ?",
        )
        .get(tenantId, input.source, input.externalId);
      if (existing) {
        const event = this.loadEvent(existing.id);
        if (!event) throw new StoreError("EVENT_NOT_FOUND", `event ${existing.id} vanished`);
        return { event, created: false };
      }

      const event: SourceEvent = {
        id: newId(),
        tenantId,
        source: input.source,
        kind: input.kind,
        externalId: input.externalId,
        occurredAt,
        ingestedAt: this.now(),
        participants: input.participants.map((p) => ({ ...p })),
        content: { ...input.content },
        meta: input.meta,
      };
      if (input.threadKey !== undefined) event.threadKey = input.threadKey;
      if (input.inReplyTo !== undefined) event.inReplyTo = [...input.inReplyTo];
      if (input.rawRef !== undefined) event.rawRef = input.rawRef;

      db.run(
        `INSERT INTO events (id, tenant_id, source, kind, external_id, occurred_at, ingested_at,
           thread_key, in_reply_to, content_json, meta_json, raw_ref)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          event.id,
          tenantId,
          event.source,
          event.kind,
          event.externalId,
          event.occurredAt,
          event.ingestedAt,
          event.threadKey ?? null,
          event.inReplyTo ? JSON.stringify(event.inReplyTo) : null,
          JSON.stringify(event.content),
          JSON.stringify(event.meta ?? {}),
          event.rawRef ?? null,
        ],
      );
      const insertParticipant = db.prepare<never, Param[]>(
        `INSERT INTO event_participants (event_id, idx, role, address, name, entity_id, self)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
      );
      event.participants.forEach((p, idx) => {
        insertParticipant.run(
          event.id,
          idx,
          p.role,
          p.address ?? null,
          p.name ?? null,
          p.entityId ?? null,
          p.self === undefined ? null : p.self ? 1 : 0,
        );
      });
      return { event, created: true };
    })();
  }

  async getEvent(id: string): Promise<SourceEvent | null> {
    return this.loadEvent(id);
  }

  async listEvents(query: EventQuery): Promise<SourceEvent[]> {
    const where: string[] = [];
    const params: Param[] = [];
    if (query.tenantId !== undefined) {
      where.push("e.tenant_id = ?");
      params.push(query.tenantId);
    }
    if (query.source !== undefined) {
      where.push("e.source = ?");
      params.push(query.source);
    }
    if (query.kind !== undefined) {
      where.push("e.kind = ?");
      params.push(query.kind);
    }
    if (query.threadKey !== undefined) {
      where.push("e.thread_key = ?");
      params.push(query.threadKey);
    }
    if (query.address !== undefined) {
      where.push("EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.address = ?)");
      params.push(query.address);
    }
    if (query.entityId !== undefined) {
      where.push("EXISTS (SELECT 1 FROM event_participants p WHERE p.event_id = e.id AND p.entity_id = ?)");
      params.push(query.entityId);
    }
    if (query.occurredAfter !== undefined) {
      where.push("e.occurred_at > ?");
      params.push(iso(query.occurredAfter, "occurredAfter"));
    }
    if (query.occurredBefore !== undefined) {
      where.push("e.occurred_at < ?");
      params.push(iso(query.occurredBefore, "occurredBefore"));
    }
    if (query.afterId !== undefined) {
      where.push("e.id > ?");
      params.push(query.afterId);
    }
    let sql = "SELECT e.* FROM events e";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY e.id ASC";
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    const rows = this.db.query<EventRow, Param[]>(sql).all(...params);
    return this.hydrateEvents(rows);
  }

  async setParticipantEntities(eventId: string, map: Array<{ index: number; entityId: string }>): Promise<void> {
    const db = this.db;
    db.transaction(() => {
      const exists = db.query<{ id: string }, [string]>("SELECT id FROM events WHERE id = ?").get(eventId);
      if (!exists) throw new StoreError("EVENT_NOT_FOUND", `event ${eventId} not found`);
      const update = db.prepare<never, [string, string, number]>(
        "UPDATE event_participants SET entity_id = ? WHERE event_id = ? AND idx = ?",
      );
      for (const { index, entityId } of map) {
        const res = update.run(entityId, eventId, index);
        if (res.changes === 0) {
          throw new StoreError("PARTICIPANT_NOT_FOUND", `event ${eventId} has no participant at index ${index}`);
        }
      }
    })();
  }

  private loadEvent(id: string): SourceEvent | null {
    const row = this.db.query<EventRow, [string]>("SELECT * FROM events WHERE id = ?").get(id);
    if (!row) return null;
    return this.hydrateEvents([row])[0] ?? null;
  }

  private hydrateEvents(rows: EventRow[]): SourceEvent[] {
    if (rows.length === 0) return [];
    const byEvent = new Map<string, Participant[]>();
    for (const ids of chunk(
      rows.map((r) => r.id),
      500,
    )) {
      const prows = this.db
        .query<ParticipantRow, string[]>(
          `SELECT * FROM event_participants WHERE event_id IN (${placeholders(ids.length)}) ORDER BY event_id, idx`,
        )
        .all(...ids);
      for (const p of prows) {
        const list = byEvent.get(p.event_id) ?? [];
        list.push(participantFromRow(p));
        byEvent.set(p.event_id, list);
      }
    }
    return rows.map((r) => {
      const event: SourceEvent = {
        id: r.id,
        tenantId: r.tenant_id,
        source: r.source,
        kind: r.kind,
        externalId: r.external_id,
        occurredAt: r.occurred_at,
        ingestedAt: r.ingested_at,
        participants: byEvent.get(r.id) ?? [],
        content: JSON.parse(r.content_json) as SourceEvent["content"],
        meta: JSON.parse(r.meta_json) as Record<string, unknown>,
      };
      if (r.thread_key !== null) event.threadKey = r.thread_key;
      if (r.in_reply_to !== null) event.inReplyTo = JSON.parse(r.in_reply_to) as string[];
      if (r.raw_ref !== null) event.rawRef = r.raw_ref;
      return event;
    });
  }

  // ---- facts ----------------------------------------------------------------

  async recordFact<V>(input: NewFact<V>): Promise<Fact<V>> {
    const db = this.db;
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    requireText(input.predicate, "predicate");
    requireText(input.subject?.entityId, "subject.entityId");
    requireText(input.origin?.by, "origin.by");
    if (!(input.confidence >= 0 && input.confidence <= 1)) {
      throw new StoreError("INVALID_INPUT", `confidence must be within 0..1, got ${input.confidence}`);
    }
    const validFrom = iso(input.validFrom, "validFrom");
    const validTo = input.validTo === undefined ? undefined : iso(input.validTo, "validTo");
    if (validTo !== undefined && validTo < validFrom) {
      throw new StoreError("INVALID_INPUT", "validTo is before validFrom");
    }

    return db.transaction(() => {
      const recordedAt = this.now();
      let old: FactRow | null = null;
      if (input.supersedes !== undefined) {
        old = this.factRow(input.supersedes);
        if (!old) throw new StoreError("FACT_NOT_FOUND", `superseded fact ${input.supersedes} not found`);
        if (old.tenant_id !== tenantId) {
          throw new StoreError("TENANT_MISMATCH", `fact ${old.id} belongs to another tenant`);
        }
        if (old.retracted_at !== null) {
          throw new StoreError("FACT_ALREADY_RETRACTED", `fact ${old.id} is already retracted or superseded`);
        }
        if (old.origin_kind === "human" && input.origin.kind !== "human") {
          throw new StoreError(
            "HUMAN_OVERRIDE_PROTECTED",
            `a ${input.origin.kind} fact may not supersede human fact ${old.id}`,
          );
        }
      }

      // Human beats model: keep the competing fact for audit, but below any
      // "probably true" threshold so readers keep preferring the human one.
      let confidence = input.confidence;
      if (input.origin.kind !== "human") {
        const human = db
          .query<{ id: string }, [string, string, string]>(
            `SELECT id FROM facts WHERE tenant_id = ? AND subject_id = ? AND predicate = ?
               AND origin_kind = 'human' AND retracted_at IS NULL LIMIT 1`,
          )
          .get(tenantId, input.subject.entityId, input.predicate);
        if (human) confidence = Math.min(confidence, HUMAN_OUTRANKED_CONFIDENCE_CAP);
      }

      if (old) {
        db.run("UPDATE facts SET retracted_at = ? WHERE id = ?", [recordedAt, old.id]);
        this.audit(old.id, "superseded", input.origin.by, recordedAt);

        // A successor that starts later in world time says the world changed,
        // not that we were wrong about the past. Keep the past believed by
        // recording the old fact again with its valid time closed where the
        // successor begins; otherwise "what was true in May" would go empty.
        if (validFrom > old.valid_from && (old.valid_to === null || old.valid_to > validFrom)) {
          const closure = this.factFromRow(old, this.provenanceFor([old.id]).get(old.id) ?? []);
          closure.id = newId();
          closure.validTo = validFrom;
          closure.recordedAt = recordedAt;
          delete closure.retractedAt;
          closure.supersedes = old.id;
          this.insertFact(closure);
          this.audit(closure.id, "valid_time_closed", input.origin.by, recordedAt);
        }
      }

      const fact: Fact<V> = {
        id: newId(),
        tenantId,
        type: input.type,
        subject: { ...input.subject },
        predicate: input.predicate,
        value: input.value,
        statement: input.statement,
        validFrom,
        recordedAt,
        provenance: input.provenance.map((p) => ({ ...p })),
        confidence,
        origin: { ...input.origin },
      };
      if (input.object !== undefined) fact.object = { ...input.object };
      if (validTo !== undefined) fact.validTo = validTo;
      if (input.supersedes !== undefined) fact.supersedes = input.supersedes;
      if (input.tags !== undefined) fact.tags = [...input.tags];
      this.insertFact(fact);
      return fact;
    })();
  }

  async retractFact(id: string, by: string): Promise<void> {
    const db = this.db;
    db.transaction(() => {
      const row = this.factRow(id);
      if (!row) throw new StoreError("FACT_NOT_FOUND", `fact ${id} not found`);
      if (row.retracted_at !== null) {
        throw new StoreError("FACT_ALREADY_RETRACTED", `fact ${id} is already retracted or superseded`);
      }
      const at = this.now();
      db.run("UPDATE facts SET retracted_at = ? WHERE id = ?", [at, id]);
      this.audit(id, "retract", by, at);
    })();
  }

  async endFactValidity(id: string, validTo: string, by: string): Promise<void> {
    const db = this.db;
    const end = iso(validTo, "validTo");
    db.transaction(() => {
      const row = this.factRow(id);
      if (!row) throw new StoreError("FACT_NOT_FOUND", `fact ${id} not found`);
      if (row.valid_to !== null) {
        throw new StoreError("FACT_VALIDITY_ALREADY_ENDED", `fact ${id} already has validTo ${row.valid_to}`);
      }
      if (end < row.valid_from) throw new StoreError("INVALID_INPUT", "validTo is before validFrom");
      db.run("UPDATE facts SET valid_to = ? WHERE id = ?", [end, id]);
      this.audit(id, "end_validity", by, this.now());
    })();
  }

  async getFact(id: string): Promise<Fact | null> {
    const row = this.factRow(id);
    if (!row) return null;
    return this.factFromRow(row, this.provenanceFor([id]).get(id) ?? []);
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const now = this.now();
    const where: string[] = [];
    const params: Param[] = [];

    const validAt = query.validAt === undefined ? now : iso(query.validAt, "validAt");
    where.push("f.valid_from <= ? AND (f.valid_to IS NULL OR f.valid_to > ?)");
    params.push(validAt, validAt);

    if (!query.includeRetracted) {
      const asOf = query.asOf === undefined ? now : iso(query.asOf, "asOf");
      where.push("f.recorded_at <= ? AND (f.retracted_at IS NULL OR f.retracted_at > ?)");
      params.push(asOf, asOf);
    }
    if (query.tenantId !== undefined) {
      where.push("f.tenant_id = ?");
      params.push(query.tenantId);
    }
    if (query.type !== undefined) {
      const types = asArray(query.type);
      if (types.length === 0) return [];
      where.push(`f.type IN (${placeholders(types.length)})`);
      params.push(...types);
    }
    if (query.predicate !== undefined) {
      where.push("f.predicate = ?");
      params.push(query.predicate);
    }
    if (query.subjectId !== undefined) {
      where.push("f.subject_id = ?");
      params.push(query.subjectId);
    }
    if (query.objectId !== undefined) {
      where.push("f.object_id = ?");
      params.push(query.objectId);
    }
    if (query.entityId !== undefined) {
      where.push("(f.subject_id = ? OR f.object_id = ?)");
      params.push(query.entityId, query.entityId);
    }
    if (query.tags !== undefined && query.tags.length > 0) {
      where.push(
        `EXISTS (SELECT 1 FROM json_each(f.tags_json) t WHERE t.value IN (${placeholders(query.tags.length)}))`,
      );
      params.push(...query.tags);
    }
    if (query.minConfidence !== undefined) {
      where.push("f.confidence >= ?");
      params.push(query.minConfidence);
    }

    let sql = `SELECT f.* FROM facts f WHERE ${where.join(" AND ")} ORDER BY f.recorded_at DESC, f.id DESC`;
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    const rows = this.db.query<FactRow, Param[]>(sql).all(...params);
    const prov = this.provenanceFor(rows.map((r) => r.id));
    return rows.map((r) => this.factFromRow(r, prov.get(r.id) ?? []));
  }

  private factRow(id: string): FactRow | null {
    return this.db.query<FactRow, [string]>("SELECT * FROM facts WHERE id = ?").get(id);
  }

  private insertFact(fact: Fact<unknown>): void {
    const db = this.db;
    db.run(
      `INSERT INTO facts (id, tenant_id, type, subject_id, subject_name, object_id, object_name, predicate,
         value_json, statement, valid_from, valid_to, recorded_at, retracted_at, confidence,
         origin_kind, origin_by, origin_model, origin_version, supersedes, tags_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        fact.id,
        fact.tenantId,
        fact.type,
        fact.subject.entityId,
        fact.subject.name ?? null,
        fact.object?.entityId ?? null,
        fact.object?.name ?? null,
        fact.predicate,
        JSON.stringify(fact.value === undefined ? null : fact.value),
        fact.statement,
        fact.validFrom,
        fact.validTo ?? null,
        fact.recordedAt,
        fact.retractedAt ?? null,
        fact.confidence,
        fact.origin.kind,
        fact.origin.by,
        fact.origin.model ?? null,
        fact.origin.version ?? null,
        fact.supersedes ?? null,
        fact.tags ? JSON.stringify(fact.tags) : null,
      ],
    );
    const insert = db.prepare<never, Param[]>(
      `INSERT INTO fact_provenance (fact_id, idx, event_id, speaker_id, speaker_name, quote, span_start, span_end)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    fact.provenance.forEach((p, idx) => {
      insert.run(
        fact.id,
        idx,
        p.eventId,
        p.speaker?.entityId ?? null,
        p.speaker?.name ?? null,
        p.quote ?? null,
        p.span?.start ?? null,
        p.span?.end ?? null,
      );
    });
  }

  private audit(factId: string, action: string, by: string, at: string): void {
    this.db.run("INSERT INTO fact_audit (fact_id, action, by, at) VALUES (?, ?, ?, ?)", [factId, action, by, at]);
  }

  private provenanceFor(factIds: string[]): Map<string, Provenance[]> {
    const out = new Map<string, Provenance[]>();
    for (const ids of chunk(factIds, 500)) {
      const rows = this.db
        .query<ProvenanceRow, string[]>(
          `SELECT * FROM fact_provenance WHERE fact_id IN (${placeholders(ids.length)}) ORDER BY fact_id, idx`,
        )
        .all(...ids);
      for (const r of rows) {
        const p: Provenance = { eventId: r.event_id };
        if (r.speaker_id !== null) {
          p.speaker = { entityId: r.speaker_id };
          if (r.speaker_name !== null) p.speaker.name = r.speaker_name;
        }
        if (r.quote !== null) p.quote = r.quote;
        if (r.span_start !== null && r.span_end !== null) p.span = { start: r.span_start, end: r.span_end };
        const list = out.get(r.fact_id) ?? [];
        list.push(p);
        out.set(r.fact_id, list);
      }
    }
    return out;
  }

  private factFromRow(r: FactRow, provenance: Provenance[]): Fact {
    const fact: Fact = {
      id: r.id,
      tenantId: r.tenant_id,
      type: r.type,
      subject: { entityId: r.subject_id },
      predicate: r.predicate,
      value: JSON.parse(r.value_json) as unknown,
      statement: r.statement,
      validFrom: r.valid_from,
      recordedAt: r.recorded_at,
      provenance,
      confidence: r.confidence,
      origin: { kind: r.origin_kind as Fact["origin"]["kind"], by: r.origin_by },
    };
    if (r.subject_name !== null) fact.subject.name = r.subject_name;
    if (r.object_id !== null) {
      fact.object = { entityId: r.object_id };
      if (r.object_name !== null) fact.object.name = r.object_name;
    }
    if (r.valid_to !== null) fact.validTo = r.valid_to;
    if (r.retracted_at !== null) fact.retractedAt = r.retracted_at;
    if (r.origin_model !== null) fact.origin.model = r.origin_model;
    if (r.origin_version !== null) fact.origin.version = r.origin_version;
    if (r.supersedes !== null) fact.supersedes = r.supersedes;
    if (r.tags_json !== null) fact.tags = JSON.parse(r.tags_json) as string[];
    return fact;
  }

  // ---- entities -------------------------------------------------------------

  async createEntity(input: NewEntity): Promise<Entity> {
    const db = this.db;
    requireText(input.kind, "kind");
    const now = this.now();
    const entity: Entity = {
      id: newId(),
      tenantId: input.tenantId ?? DEFAULT_TENANT,
      kind: input.kind,
      name: input.name,
      identifiers: dedupeIdentifiers(input.identifiers),
      status: input.status,
      createdAt: now,
      updatedAt: now,
    };
    if (input.mergedInto !== undefined) entity.mergedInto = input.mergedInto;
    if (input.summary !== undefined) entity.summary = { ...input.summary };
    db.transaction(() => {
      db.run(
        `INSERT INTO entities (id, tenant_id, kind, name, status, merged_into, identifiers_json, summary_json,
           parent_id, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          entity.id,
          entity.tenantId,
          entity.kind,
          entity.name,
          entity.status,
          entity.mergedInto ?? null,
          JSON.stringify(entity.identifiers),
          entity.summary ? JSON.stringify(entity.summary) : null,
          entity.summary?.parentId ?? null,
          entity.createdAt,
          entity.updatedAt,
        ],
      );
      this.writeIdentifierIndex(entity);
    })();
    return entity;
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.loadEntity(id);
  }

  async resolveEntity(id: string): Promise<Entity | null> {
    return this.resolveEntitySync(id);
  }

  async findEntities(query: EntityQuery): Promise<Entity[]> {
    const where: string[] = [];
    const params: Param[] = [];
    if (query.tenantId !== undefined) {
      where.push("e.tenant_id = ?");
      params.push(query.tenantId);
    }
    if (query.kind !== undefined) {
      const kinds = asArray(query.kind);
      if (kinds.length === 0) return [];
      where.push(`e.kind IN (${placeholders(kinds.length)})`);
      params.push(...kinds);
    }
    if (query.status !== undefined) {
      const statuses = asArray(query.status);
      if (statuses.length === 0) return [];
      where.push(`e.status IN (${placeholders(statuses.length)})`);
      params.push(...statuses);
    }
    if (query.identifier !== undefined) {
      let sub = "SELECT i.entity_id FROM entity_identifiers i WHERE i.value = ?";
      params.push(query.identifier.value);
      if (query.identifier.type !== undefined) {
        sub += " AND i.type = ?";
        params.push(query.identifier.type);
      }
      where.push(`e.id IN (${sub})`);
    }
    if (query.nameLike !== undefined) {
      const escaped = query.nameLike.replace(/[\\%_]/g, (c) => `\\${c}`);
      where.push("LOWER(e.name) LIKE LOWER(?) ESCAPE '\\'");
      params.push(`%${escaped}%`);
    }
    if (query.parentId !== undefined) {
      where.push("e.parent_id = ?");
      params.push(query.parentId);
    }
    let sql = "SELECT e.* FROM entities e";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY e.id ASC";
    if (query.limit !== undefined) {
      sql += " LIMIT ?";
      params.push(query.limit);
    }
    return this.db
      .query<EntityRow, Param[]>(sql)
      .all(...params)
      .map(entityFromRow);
  }

  async updateEntity(id: string, patch: Partial<Omit<Entity, "id" | "tenantId" | "createdAt">>): Promise<Entity> {
    const db = this.db;
    return db.transaction(() => {
      const current = this.loadEntity(id);
      if (!current) throw new StoreError("ENTITY_NOT_FOUND", `entity ${id} not found`);
      const next: Entity = { ...current, ...patch, id: current.id, tenantId: current.tenantId };
      next.createdAt = current.createdAt;
      next.updatedAt = this.now();
      if (patch.identifiers !== undefined) next.identifiers = dedupeIdentifiers(patch.identifiers);
      this.writeEntity(next);
      if (patch.identifiers !== undefined) {
        db.run("DELETE FROM entity_identifiers WHERE entity_id = ?", [id]);
        this.writeIdentifierIndex(next);
      }
      return next;
    })();
  }

  async mergeEntities(fromId: string, intoId: string, by: string): Promise<Entity> {
    const db = this.db;
    return db.transaction(() => {
      const from = this.loadEntity(fromId);
      if (!from) throw new StoreError("ENTITY_NOT_FOUND", `entity ${fromId} not found`);
      const into = this.resolveEntitySync(intoId);
      if (!into) throw new StoreError("ENTITY_NOT_FOUND", `entity ${intoId} not found`);
      if (from.id === into.id) throw new StoreError("INVALID_MERGE", "cannot merge an entity into itself");
      if (from.tenantId !== into.tenantId) {
        throw new StoreError("TENANT_MISMATCH", "cannot merge entities across tenants");
      }
      if (from.status === "merged") {
        throw new StoreError("ENTITY_ALREADY_MERGED", `entity ${from.id} is already merged into ${from.mergedInto}`);
      }
      const now = this.now();

      const seen = new Set(into.identifiers.map(identifierKey));
      const moved = from.identifiers.filter((i) => !seen.has(identifierKey(i)));
      const survivor: Entity = { ...into, identifiers: [...into.identifiers, ...moved], updatedAt: now };
      this.writeEntity(survivor);
      db.run("DELETE FROM entity_identifiers WHERE entity_id = ?", [from.id]);
      this.writeIdentifierIndex({ ...survivor, identifiers: moved });

      const merged: Entity = { ...from, identifiers: [], status: "merged", mergedInto: into.id, updatedAt: now };
      this.writeEntity(merged);

      const t = from.tenantId;
      const subjects = db.run("UPDATE facts SET subject_id = ? WHERE tenant_id = ? AND subject_id = ?", [
        into.id,
        t,
        from.id,
      ]).changes;
      const objects = db.run("UPDATE facts SET object_id = ? WHERE tenant_id = ? AND object_id = ?", [
        into.id,
        t,
        from.id,
      ]).changes;
      db.run(
        `UPDATE fact_provenance SET speaker_id = ? WHERE speaker_id = ?
           AND fact_id IN (SELECT id FROM facts WHERE tenant_id = ?)`,
        [into.id, from.id, t],
      );
      const participants = db.run(
        `UPDATE event_participants SET entity_id = ? WHERE entity_id = ?
           AND event_id IN (SELECT id FROM events WHERE tenant_id = ?)`,
        [into.id, from.id, t],
      ).changes;
      // Keep earlier merges and children pointing at the survivor directly.
      db.run("UPDATE entities SET merged_into = ? WHERE tenant_id = ? AND merged_into = ?", [into.id, t, from.id]);
      db.run(
        `UPDATE entities SET parent_id = ?, summary_json = json_set(COALESCE(summary_json, '{}'), '$.parentId', ?)
           WHERE tenant_id = ? AND parent_id = ?`,
        [into.id, into.id, t, from.id],
      );

      const detail = JSON.stringify({
        from: from.id,
        into: into.id,
        movedIdentifiers: moved,
        factsRepointed: subjects + objects,
        participantsRepointed: participants,
      });
      const audit = db.prepare<never, Param[]>(
        "INSERT INTO entity_audit (entity_id, action, by, at, detail_json) VALUES (?, ?, ?, ?, ?)",
      );
      audit.run(from.id, "merged_into", by, now, detail);
      audit.run(into.id, "absorbed", by, now, detail);
      return survivor;
    })();
  }

  private loadEntity(id: string): Entity | null {
    const row = this.db.query<EntityRow, [string]>("SELECT * FROM entities WHERE id = ?").get(id);
    return row ? entityFromRow(row) : null;
  }

  private resolveEntitySync(id: string): Entity | null {
    let entity = this.loadEntity(id);
    const visited = new Set<string>();
    while (entity && entity.status === "merged" && entity.mergedInto !== undefined) {
      if (visited.has(entity.id)) throw new StoreError("MERGE_CYCLE", `merge chain from ${id} loops`);
      visited.add(entity.id);
      entity = this.loadEntity(entity.mergedInto);
    }
    return entity;
  }

  private writeEntity(e: Entity): void {
    this.db.run(
      `UPDATE entities SET kind = ?, name = ?, status = ?, merged_into = ?, identifiers_json = ?,
         summary_json = ?, parent_id = ?, updated_at = ? WHERE id = ?`,
      [
        e.kind,
        e.name,
        e.status,
        e.mergedInto ?? null,
        JSON.stringify(e.identifiers),
        e.summary ? JSON.stringify(e.summary) : null,
        e.summary?.parentId ?? null,
        e.updatedAt,
        e.id,
      ],
    );
  }

  private writeIdentifierIndex(e: Pick<Entity, "id" | "tenantId" | "identifiers">): void {
    const insert = this.db.prepare<never, [string, string, string, string]>(
      "INSERT OR IGNORE INTO entity_identifiers (entity_id, tenant_id, type, value) VALUES (?, ?, ?, ?)",
    );
    for (const i of e.identifiers) insert.run(e.id, e.tenantId, i.type, i.value);
  }

  // ---- views ----------------------------------------------------------------

  async defineView(tenantId: string, view: ViewDefinition): Promise<void> {
    requireText(view.name, "view.name");
    this.db.run(
      `INSERT INTO views (tenant_id, name, def_json) VALUES (?, ?, ?)
       ON CONFLICT (tenant_id, name) DO UPDATE SET def_json = excluded.def_json`,
      [tenantId, view.name, JSON.stringify(view)],
    );
  }

  async listViews(tenantId: string): Promise<ViewDefinition[]> {
    return this.db
      .query<{ def_json: string }, [string]>("SELECT def_json FROM views WHERE tenant_id = ? ORDER BY name")
      .all(tenantId)
      .map((r) => JSON.parse(r.def_json) as ViewDefinition);
  }

  // ---- extension state ------------------------------------------------------

  async getCursor(tenantId: string, source: string): Promise<string | null> {
    const row = this.db
      .query<{ cursor: string }, [string, string]>("SELECT cursor FROM cursors WHERE tenant_id = ? AND source = ?")
      .get(tenantId, source);
    return row?.cursor ?? null;
  }

  async setCursor(tenantId: string, source: string, cursor: string): Promise<void> {
    this.db.run(
      `INSERT INTO cursors (tenant_id, source, cursor, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (tenant_id, source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      [tenantId, source, cursor, this.now()],
    );
  }

  async kvGet<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const row = this.db
      .query<{ value_json: string }, [string, string]>("SELECT value_json FROM kv WHERE namespace = ? AND key = ?")
      .get(namespace, key);
    return row ? (JSON.parse(row.value_json) as T) : null;
  }

  async kvSet<T = unknown>(namespace: string, key: string, value: T): Promise<void> {
    const json = JSON.stringify(value);
    if (json === undefined) throw new StoreError("INVALID_INPUT", "kv value must be JSON-serializable");
    this.db.run(
      `INSERT INTO kv (namespace, key, value_json, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT (namespace, key) DO UPDATE SET value_json = excluded.value_json, updated_at = excluded.updated_at`,
      [namespace, key, json, this.now()],
    );
  }

  async kvDelete(namespace: string, key: string): Promise<void> {
    this.db.run("DELETE FROM kv WHERE namespace = ? AND key = ?", [namespace, key]);
  }

  // ---- model usage (SQLite-specific; for the router) ------------------------

  /** Record one model call. Returns its id. */
  async recordModelCall(call: ModelCallRecord): Promise<string> {
    const id = call.id ?? newId();
    this.db.run(
      `INSERT INTO model_calls (id, tenant_id, tier, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cost_usd, latency_ms, created_at, meta_json)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        id,
        call.tenantId,
        call.tier,
        call.provider,
        call.model,
        call.inputTokens ?? 0,
        call.outputTokens ?? 0,
        call.cacheReadTokens ?? 0,
        call.costUsd ?? 0,
        call.latencyMs ?? null,
        call.createdAt === undefined ? this.now() : iso(call.createdAt, "createdAt"),
        call.meta ? JSON.stringify(call.meta) : null,
      ],
    );
    return id;
  }

  /** Total USD spent by a tenant on calls at or after `sinceIso`. */
  async sumModelCost(tenantId: string, sinceIso: string): Promise<number> {
    const row = this.db
      .query<{ total: number | null }, [string, string]>(
        "SELECT SUM(cost_usd) AS total FROM model_calls WHERE tenant_id = ? AND created_at >= ?",
      )
      .get(tenantId, iso(sinceIso, "sinceIso"));
    return row?.total ?? 0;
  }
}

function participantFromRow(r: ParticipantRow): Participant {
  const p: Participant = { role: r.role };
  if (r.address !== null) p.address = r.address;
  if (r.name !== null) p.name = r.name;
  if (r.entity_id !== null) p.entityId = r.entity_id;
  if (r.self !== null) p.self = r.self === 1;
  return p;
}

function entityFromRow(r: EntityRow): Entity {
  const e: Entity = {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    name: r.name,
    identifiers: JSON.parse(r.identifiers_json) as Identifier[],
    status: r.status as Entity["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.merged_into !== null) e.mergedInto = r.merged_into;
  if (r.summary_json !== null) e.summary = JSON.parse(r.summary_json) as NonNullable<Entity["summary"]>;
  return e;
}

function dedupeIdentifiers(list: Identifier[]): Identifier[] {
  const seen = new Set<string>();
  const out: Identifier[] = [];
  for (const i of list) {
    const k = identifierKey(i);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push({ ...i });
  }
  return out;
}
