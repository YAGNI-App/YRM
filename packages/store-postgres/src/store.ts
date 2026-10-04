import {
  DEFAULT_TENANT,
  HUMAN_OUTRANKED_CONFIDENCE_CAP,
  newId,
  StoreError,
  type Entity,
  type EntityQuery,
  type EventQuery,
  type Fact,
  type FactQuery,
  type Identifier,
  type ModelCallStore,
  type NewEntity,
  type NewFact,
  type NewSourceEvent,
  type Participant,
  type Provenance,
  type SourceEvent,
  type Store,
  type StoredModelCall,
  type ViewDefinition,
} from "@yrm/core";
import { postgresClient, type PostgresClientOptions, type Queryable, type SqlClient, type SqlParam } from "./client.ts";
import { applyMigrations } from "./schema.ts";

export interface PostgresStoreOptions {
  /** Connection string. Ignored when `client` is given. */
  url?: string;
  /** A ready client (PGlite in tests, or a caller-managed pool). The store closes it on `close()`. */
  client?: SqlClient;
  /** Pool settings for the `url` client. */
  pool?: PostgresClientOptions;
  /** Clock override for tests. Defaults to the system clock. */
  clock?: () => Date;
}

interface EventRow {
  id: string;
  tenant_id: string;
  source: string;
  kind: string;
  external_id: string;
  occurred_at: string;
  ingested_at: string;
  thread_key: string | null;
  in_reply_to: string[] | null;
  content: SourceEvent["content"];
  meta: Record<string, unknown>;
  raw_ref: string | null;
}

interface ParticipantRow {
  event_id: string;
  idx: number;
  role: string;
  address: string | null;
  name: string | null;
  entity_id: string | null;
  self: boolean | null;
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
  value: unknown;
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
  tags: string[] | null;
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
  identifiers: Identifier[];
  summary: NonNullable<Entity["summary"]> | null;
  parent_id: string | null;
  created_at: string;
  updated_at: string;
}

/** Collects `$n` parameters while a query is built. */
class Params {
  readonly values: SqlParam[] = [];
  add(v: SqlParam): string {
    this.values.push(v);
    return `$${this.values.length}`;
  }
  list(vs: SqlParam[]): string {
    return vs.map((v) => this.add(v)).join(", ");
  }
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

/** JSON text for a `$n::text::jsonb` parameter; the cast keeps drivers from re-encoding it. */
function json(v: unknown): string {
  return JSON.stringify(v);
}

const JSONB = "::text::jsonb";

/**
 * Postgres implementation of `Store`. Semantics match `SqliteStore` exactly;
 * the shared conformance suite in `@yrm/core` is the proof.
 *
 * Every multi-statement write runs in one transaction. Rows a write depends on
 * are locked with `FOR UPDATE` so concurrent writers from other hosts
 * serialize on the fact or entity rather than on the whole database.
 */
export class PostgresStore implements Store, ModelCallStore {
  #client: SqlClient | null;
  readonly #clock: () => Date;

  constructor(options: PostgresStoreOptions) {
    if (options.client) this.#client = options.client;
    else if (options.url) this.#client = postgresClient(options.url, options.pool);
    else throw new StoreError("INVALID_INPUT", "PostgresStore needs a url or a client");
    this.#clock = options.clock ?? (() => new Date());
  }

  private get db(): SqlClient {
    if (!this.#client) throw new StoreError("STORE_CLOSED", "store is closed");
    return this.#client;
  }

  private now(): string {
    return this.#clock().toISOString();
  }

  // ---- lifecycle ------------------------------------------------------------

  async migrate(): Promise<void> {
    await applyMigrations(this.db, () => this.now());
  }

  async close(): Promise<void> {
    const client = this.#client;
    this.#client = null;
    await client?.close();
  }

  // ---- events ---------------------------------------------------------------

  async appendEvent(input: NewSourceEvent): Promise<{ event: SourceEvent; created: boolean }> {
    const db = this.db;
    const tenantId = input.tenantId ?? DEFAULT_TENANT;
    requireText(input.source, "source");
    requireText(input.kind, "kind");
    requireText(input.externalId, "externalId");
    const occurredAt = iso(input.occurredAt, "occurredAt");

    return db.transaction(async (tx) => {
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

      // ON CONFLICT rather than check-then-insert: a concurrent writer on
      // another connection blocks here until it commits, then we see its row.
      const inserted = await tx.query<{ id: string }>(
        `INSERT INTO events (id, tenant_id, source, kind, external_id, occurred_at, ingested_at,
           thread_key, in_reply_to, content, meta, raw_ref)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${JSONB}, $10${JSONB}, $11${JSONB}, $12)
         ON CONFLICT (tenant_id, source, external_id) DO NOTHING
         RETURNING id`,
        [
          event.id,
          tenantId,
          event.source,
          event.kind,
          event.externalId,
          event.occurredAt,
          event.ingestedAt,
          event.threadKey ?? null,
          event.inReplyTo ? json(event.inReplyTo) : null,
          json(event.content),
          json(event.meta ?? {}),
          event.rawRef ?? null,
        ],
      );
      if (inserted.length === 0) {
        const existing = await tx.query<{ id: string }>(
          "SELECT id FROM events WHERE tenant_id = $1 AND source = $2 AND external_id = $3",
          [tenantId, input.source, input.externalId],
        );
        const id = existing[0]?.id;
        const found = id === undefined ? null : await this.loadEvent(tx, id);
        if (!found) throw new StoreError("EVENT_NOT_FOUND", `event ${input.externalId} vanished`);
        return { event: found, created: false };
      }

      for (const [idx, p] of event.participants.entries()) {
        await tx.query(
          `INSERT INTO event_participants (event_id, idx, role, address, name, entity_id, self)
           VALUES ($1, $2, $3, $4, $5, $6, $7)`,
          [event.id, idx, p.role, p.address ?? null, p.name ?? null, p.entityId ?? null, p.self ?? null],
        );
      }
      return { event, created: true };
    });
  }

  async getEvent(id: string): Promise<SourceEvent | null> {
    return this.loadEvent(this.db, id);
  }

  async listEvents(query: EventQuery): Promise<SourceEvent[]> {
    const db = this.db;
    const p = new Params();
    const where: string[] = [];
    if (query.tenantId !== undefined) where.push(`e.tenant_id = ${p.add(query.tenantId)}`);
    if (query.source !== undefined) where.push(`e.source = ${p.add(query.source)}`);
    if (query.kind !== undefined) where.push(`e.kind = ${p.add(query.kind)}`);
    if (query.threadKey !== undefined) where.push(`e.thread_key = ${p.add(query.threadKey)}`);
    if (query.address !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.address = ${p.add(query.address)})`,
      );
    }
    if (query.entityId !== undefined) {
      where.push(
        `EXISTS (SELECT 1 FROM event_participants ep WHERE ep.event_id = e.id AND ep.entity_id = ${p.add(query.entityId)})`,
      );
    }
    if (query.occurredAfter !== undefined) where.push(`e.occurred_at > ${p.add(iso(query.occurredAfter, "occurredAfter"))}`);
    if (query.occurredBefore !== undefined) {
      where.push(`e.occurred_at < ${p.add(iso(query.occurredBefore, "occurredBefore"))}`);
    }
    if (query.afterId !== undefined) where.push(`e.id > ${p.add(query.afterId)}`);
    let sql = "SELECT e.* FROM events e";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY e.id ASC";
    if (query.limit !== undefined) sql += ` LIMIT ${p.add(query.limit)}`;
    const rows = await db.query<EventRow>(sql, p.values);
    return this.hydrateEvents(db, rows);
  }

  async setParticipantEntities(eventId: string, map: Array<{ index: number; entityId: string }>): Promise<void> {
    await this.db.transaction(async (tx) => {
      const exists = await tx.query("SELECT id FROM events WHERE id = $1", [eventId]);
      if (exists.length === 0) throw new StoreError("EVENT_NOT_FOUND", `event ${eventId} not found`);
      for (const { index, entityId } of map) {
        const res = await tx.query(
          "UPDATE event_participants SET entity_id = $1 WHERE event_id = $2 AND idx = $3 RETURNING idx",
          [entityId, eventId, index],
        );
        if (res.length === 0) {
          throw new StoreError("PARTICIPANT_NOT_FOUND", `event ${eventId} has no participant at index ${index}`);
        }
      }
    });
  }

  private async loadEvent(q: Queryable, id: string): Promise<SourceEvent | null> {
    const rows = await q.query<EventRow>("SELECT * FROM events WHERE id = $1", [id]);
    return (await this.hydrateEvents(q, rows))[0] ?? null;
  }

  private async hydrateEvents(q: Queryable, rows: EventRow[]): Promise<SourceEvent[]> {
    if (rows.length === 0) return [];
    const byEvent = new Map<string, Participant[]>();
    for (const ids of chunk(
      rows.map((r) => r.id),
      500,
    )) {
      const p = new Params();
      const prows = await q.query<ParticipantRow>(
        `SELECT * FROM event_participants WHERE event_id IN (${p.list(ids)}) ORDER BY event_id, idx`,
        p.values,
      );
      for (const r of prows) {
        const list = byEvent.get(r.event_id) ?? [];
        list.push(participantFromRow(r));
        byEvent.set(r.event_id, list);
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
        content: r.content,
        meta: r.meta,
      };
      if (r.thread_key !== null) event.threadKey = r.thread_key;
      if (r.in_reply_to !== null) event.inReplyTo = r.in_reply_to;
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

    return db.transaction(async (tx) => {
      const recordedAt = this.now();
      let old: FactRow | null = null;
      if (input.supersedes !== undefined) {
        // Locked so two writers superseding the same fact cannot both win.
        old = await this.factRow(tx, input.supersedes, true);
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
        const human = await tx.query(
          `SELECT id FROM facts WHERE tenant_id = $1 AND subject_id = $2 AND predicate = $3
             AND origin_kind = 'human' AND retracted_at IS NULL LIMIT 1`,
          [tenantId, input.subject.entityId, input.predicate],
        );
        if (human.length > 0) confidence = Math.min(confidence, HUMAN_OUTRANKED_CONFIDENCE_CAP);
      }

      if (old) {
        await tx.query("UPDATE facts SET retracted_at = $1 WHERE id = $2", [recordedAt, old.id]);
        await this.audit(tx, old.id, "superseded", input.origin.by, recordedAt);

        // A successor that starts later in world time says the world changed,
        // not that we were wrong about the past. Keep the past believed by
        // recording the old fact again with its valid time closed where the
        // successor begins; otherwise "what was true in May" would go empty.
        if (validFrom > old.valid_from && (old.valid_to === null || old.valid_to > validFrom)) {
          const closure = factFromRow(old, (await this.provenanceFor(tx, [old.id])).get(old.id) ?? []);
          closure.id = newId();
          closure.validTo = validFrom;
          closure.recordedAt = recordedAt;
          delete closure.retractedAt;
          closure.supersedes = old.id;
          await this.insertFact(tx, closure);
          await this.audit(tx, closure.id, "valid_time_closed", input.origin.by, recordedAt);
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
      await this.insertFact(tx, fact);
      return fact;
    });
  }

  async retractFact(id: string, by: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await this.factRow(tx, id, true);
      if (!row) throw new StoreError("FACT_NOT_FOUND", `fact ${id} not found`);
      if (row.retracted_at !== null) {
        throw new StoreError("FACT_ALREADY_RETRACTED", `fact ${id} is already retracted or superseded`);
      }
      const at = this.now();
      await tx.query("UPDATE facts SET retracted_at = $1 WHERE id = $2", [at, id]);
      await this.audit(tx, id, "retract", by, at);
    });
  }

  async endFactValidity(id: string, validTo: string, by: string): Promise<void> {
    const end = iso(validTo, "validTo");
    await this.db.transaction(async (tx) => {
      const row = await this.factRow(tx, id, true);
      if (!row) throw new StoreError("FACT_NOT_FOUND", `fact ${id} not found`);
      if (row.valid_to !== null) {
        throw new StoreError("FACT_VALIDITY_ALREADY_ENDED", `fact ${id} already has validTo ${row.valid_to}`);
      }
      if (end < row.valid_from) throw new StoreError("INVALID_INPUT", "validTo is before validFrom");
      await tx.query("UPDATE facts SET valid_to = $1 WHERE id = $2", [end, id]);
      await this.audit(tx, id, "end_validity", by, this.now());
    });
  }

  async getFact(id: string): Promise<Fact | null> {
    const db = this.db;
    const row = await this.factRow(db, id, false);
    if (!row) return null;
    return factFromRow(row, (await this.provenanceFor(db, [id])).get(id) ?? []);
  }

  async queryFacts(query: FactQuery): Promise<Fact[]> {
    const db = this.db;
    const now = this.now();
    const p = new Params();
    const where: string[] = [];

    const validAt = query.validAt === undefined ? now : iso(query.validAt, "validAt");
    const va = p.add(validAt);
    where.push(`f.valid_from <= ${va} AND (f.valid_to IS NULL OR f.valid_to > ${va})`);

    if (!query.includeRetracted) {
      const asOf = p.add(query.asOf === undefined ? now : iso(query.asOf, "asOf"));
      where.push(`f.recorded_at <= ${asOf} AND (f.retracted_at IS NULL OR f.retracted_at > ${asOf})`);
    }
    if (query.tenantId !== undefined) where.push(`f.tenant_id = ${p.add(query.tenantId)}`);
    if (query.type !== undefined) {
      const types = asArray(query.type);
      if (types.length === 0) return [];
      where.push(`f.type IN (${p.list(types)})`);
    }
    if (query.predicate !== undefined) where.push(`f.predicate = ${p.add(query.predicate)}`);
    if (query.subjectId !== undefined) where.push(`f.subject_id = ${p.add(query.subjectId)}`);
    if (query.objectId !== undefined) where.push(`f.object_id = ${p.add(query.objectId)}`);
    if (query.entityId !== undefined) {
      const e = p.add(query.entityId);
      where.push(`(f.subject_id = ${e} OR f.object_id = ${e})`);
    }
    if (query.tags !== undefined && query.tags.length > 0) {
      const tags = query.tags.map((t) => `${p.add(t)}::text`).join(", ");
      where.push(`f.tags ?| ARRAY[${tags}]`);
    }
    if (query.minConfidence !== undefined) where.push(`f.confidence >= ${p.add(query.minConfidence)}`);

    let sql = `SELECT f.* FROM facts f WHERE ${where.join(" AND ")} ORDER BY f.recorded_at DESC, f.id DESC`;
    if (query.limit !== undefined) sql += ` LIMIT ${p.add(query.limit)}`;
    const rows = await db.query<FactRow>(sql, p.values);
    const prov = await this.provenanceFor(
      db,
      rows.map((r) => r.id),
    );
    return rows.map((r) => factFromRow(r, prov.get(r.id) ?? []));
  }

  private async factRow(q: Queryable, id: string, lock: boolean): Promise<FactRow | null> {
    const rows = await q.query<FactRow>(`SELECT * FROM facts WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    return rows[0] ?? null;
  }

  private async insertFact(q: Queryable, fact: Fact<unknown>): Promise<void> {
    await q.query(
      `INSERT INTO facts (id, tenant_id, type, subject_id, subject_name, object_id, object_name, predicate,
         value, statement, valid_from, valid_to, recorded_at, retracted_at, confidence,
         origin_kind, origin_by, origin_model, origin_version, supersedes, tags)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9${JSONB}, $10, $11, $12, $13, $14, $15, $16, $17, $18, $19, $20,
         $21${JSONB})`,
      [
        fact.id,
        fact.tenantId,
        fact.type,
        fact.subject.entityId,
        fact.subject.name ?? null,
        fact.object?.entityId ?? null,
        fact.object?.name ?? null,
        fact.predicate,
        json(fact.value === undefined ? null : fact.value),
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
        fact.tags ? json(fact.tags) : null,
      ],
    );
    for (const [idx, p] of fact.provenance.entries()) {
      await q.query(
        `INSERT INTO fact_provenance (fact_id, idx, event_id, speaker_id, speaker_name, quote, span_start, span_end)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          fact.id,
          idx,
          p.eventId,
          p.speaker?.entityId ?? null,
          p.speaker?.name ?? null,
          p.quote ?? null,
          p.span?.start ?? null,
          p.span?.end ?? null,
        ],
      );
    }
  }

  private async audit(q: Queryable, factId: string, action: string, by: string, at: string): Promise<void> {
    await q.query("INSERT INTO fact_audit (fact_id, action, by, at) VALUES ($1, $2, $3, $4)", [factId, action, by, at]);
  }

  private async provenanceFor(q: Queryable, factIds: string[]): Promise<Map<string, Provenance[]>> {
    const out = new Map<string, Provenance[]>();
    for (const ids of chunk(factIds, 500)) {
      const p = new Params();
      const rows = await q.query<ProvenanceRow>(
        `SELECT * FROM fact_provenance WHERE fact_id IN (${p.list(ids)}) ORDER BY fact_id, idx`,
        p.values,
      );
      for (const r of rows) {
        const prov: Provenance = { eventId: r.event_id };
        if (r.speaker_id !== null) {
          prov.speaker = { entityId: r.speaker_id };
          if (r.speaker_name !== null) prov.speaker.name = r.speaker_name;
        }
        if (r.quote !== null) prov.quote = r.quote;
        if (r.span_start !== null && r.span_end !== null) prov.span = { start: r.span_start, end: r.span_end };
        const list = out.get(r.fact_id) ?? [];
        list.push(prov);
        out.set(r.fact_id, list);
      }
    }
    return out;
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
    await db.transaction(async (tx) => {
      await tx.query(
        `INSERT INTO entities (id, tenant_id, kind, name, status, merged_into, identifiers, summary,
           parent_id, created_at, updated_at)
         VALUES ($1, $2, $3, $4, $5, $6, $7${JSONB}, $8${JSONB}, $9, $10, $11)`,
        [
          entity.id,
          entity.tenantId,
          entity.kind,
          entity.name,
          entity.status,
          entity.mergedInto ?? null,
          json(entity.identifiers),
          entity.summary ? json(entity.summary) : null,
          entity.summary?.parentId ?? null,
          entity.createdAt,
          entity.updatedAt,
        ],
      );
      await this.writeIdentifierIndex(tx, entity);
    });
    return entity;
  }

  async getEntity(id: string): Promise<Entity | null> {
    return this.loadEntity(this.db, id, false);
  }

  async resolveEntity(id: string): Promise<Entity | null> {
    return this.resolve(this.db, id);
  }

  async findEntities(query: EntityQuery): Promise<Entity[]> {
    const db = this.db;
    const p = new Params();
    const where: string[] = [];
    if (query.tenantId !== undefined) where.push(`e.tenant_id = ${p.add(query.tenantId)}`);
    if (query.kind !== undefined) {
      const kinds = asArray(query.kind);
      if (kinds.length === 0) return [];
      where.push(`e.kind IN (${p.list(kinds)})`);
    }
    if (query.status !== undefined) {
      const statuses = asArray(query.status);
      if (statuses.length === 0) return [];
      where.push(`e.status IN (${p.list(statuses)})`);
    }
    if (query.identifier !== undefined) {
      let sub = `SELECT i.entity_id FROM entity_identifiers i WHERE i.value = ${p.add(query.identifier.value)}`;
      if (query.identifier.type !== undefined) sub += ` AND i.type = ${p.add(query.identifier.type)}`;
      where.push(`e.id IN (${sub})`);
    }
    if (query.nameLike !== undefined) {
      const escaped = query.nameLike.replace(/[\\%_]/g, (c) => `\\${c}`);
      where.push(`LOWER(e.name) LIKE LOWER(${p.add(`%${escaped}%`)}) ESCAPE '\\'`);
    }
    if (query.parentId !== undefined) where.push(`e.parent_id = ${p.add(query.parentId)}`);
    let sql = "SELECT e.* FROM entities e";
    if (where.length) sql += ` WHERE ${where.join(" AND ")}`;
    sql += " ORDER BY e.id ASC";
    if (query.limit !== undefined) sql += ` LIMIT ${p.add(query.limit)}`;
    return (await db.query<EntityRow>(sql, p.values)).map(entityFromRow);
  }

  async updateEntity(id: string, patch: Partial<Omit<Entity, "id" | "tenantId" | "createdAt">>): Promise<Entity> {
    return this.db.transaction(async (tx) => {
      const current = await this.loadEntity(tx, id, true);
      if (!current) throw new StoreError("ENTITY_NOT_FOUND", `entity ${id} not found`);
      const next: Entity = { ...current, ...patch, id: current.id, tenantId: current.tenantId };
      next.createdAt = current.createdAt;
      next.updatedAt = this.now();
      if (patch.identifiers !== undefined) next.identifiers = dedupeIdentifiers(patch.identifiers);
      await this.writeEntity(tx, next);
      if (patch.identifiers !== undefined) {
        await tx.query("DELETE FROM entity_identifiers WHERE entity_id = $1", [id]);
        await this.writeIdentifierIndex(tx, next);
      }
      return next;
    });
  }

  async mergeEntities(fromId: string, intoId: string, by: string): Promise<Entity> {
    return this.db.transaction(async (tx) => {
      const from = await this.loadEntity(tx, fromId, true);
      if (!from) throw new StoreError("ENTITY_NOT_FOUND", `entity ${fromId} not found`);
      const into = await this.resolve(tx, intoId);
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
      await this.writeEntity(tx, survivor);
      await tx.query("DELETE FROM entity_identifiers WHERE entity_id = $1", [from.id]);
      await this.writeIdentifierIndex(tx, { ...survivor, identifiers: moved });

      const merged: Entity = { ...from, identifiers: [], status: "merged", mergedInto: into.id, updatedAt: now };
      await this.writeEntity(tx, merged);

      const t = from.tenantId;
      const subjects = await tx.query(
        "UPDATE facts SET subject_id = $1 WHERE tenant_id = $2 AND subject_id = $3 RETURNING id",
        [into.id, t, from.id],
      );
      const objects = await tx.query(
        "UPDATE facts SET object_id = $1 WHERE tenant_id = $2 AND object_id = $3 RETURNING id",
        [into.id, t, from.id],
      );
      await tx.query(
        `UPDATE fact_provenance SET speaker_id = $1 WHERE speaker_id = $2
           AND fact_id IN (SELECT id FROM facts WHERE tenant_id = $3)`,
        [into.id, from.id, t],
      );
      const participants = await tx.query(
        `UPDATE event_participants SET entity_id = $1 WHERE entity_id = $2
           AND event_id IN (SELECT id FROM events WHERE tenant_id = $3) RETURNING idx`,
        [into.id, from.id, t],
      );
      // Keep earlier merges and children pointing at the survivor directly.
      await tx.query("UPDATE entities SET merged_into = $1 WHERE tenant_id = $2 AND merged_into = $3", [
        into.id,
        t,
        from.id,
      ]);
      await tx.query(
        `UPDATE entities SET parent_id = $1, summary = jsonb_set(COALESCE(summary, '{}'::jsonb), '{parentId}', to_jsonb($1::text))
           WHERE tenant_id = $2 AND parent_id = $3`,
        [into.id, t, from.id],
      );

      const detail = json({
        from: from.id,
        into: into.id,
        movedIdentifiers: moved,
        factsRepointed: subjects.length + objects.length,
        participantsRepointed: participants.length,
      });
      for (const [entityId, action] of [
        [from.id, "merged_into"],
        [into.id, "absorbed"],
      ] as const) {
        await tx.query(
          `INSERT INTO entity_audit (entity_id, action, by, at, detail) VALUES ($1, $2, $3, $4, $5${JSONB})`,
          [entityId, action, by, now, detail],
        );
      }
      return survivor;
    });
  }

  private async loadEntity(q: Queryable, id: string, lock: boolean): Promise<Entity | null> {
    const rows = await q.query<EntityRow>(`SELECT * FROM entities WHERE id = $1${lock ? " FOR UPDATE" : ""}`, [id]);
    const row = rows[0];
    return row ? entityFromRow(row) : null;
  }

  private async resolve(q: Queryable, id: string): Promise<Entity | null> {
    let entity = await this.loadEntity(q, id, false);
    const visited = new Set<string>();
    while (entity && entity.status === "merged" && entity.mergedInto !== undefined) {
      if (visited.has(entity.id)) throw new StoreError("MERGE_CYCLE", `merge chain from ${id} loops`);
      visited.add(entity.id);
      entity = await this.loadEntity(q, entity.mergedInto, false);
    }
    return entity;
  }

  private async writeEntity(q: Queryable, e: Entity): Promise<void> {
    await q.query(
      `UPDATE entities SET kind = $1, name = $2, status = $3, merged_into = $4, identifiers = $5${JSONB},
         summary = $6${JSONB}, parent_id = $7, updated_at = $8 WHERE id = $9`,
      [
        e.kind,
        e.name,
        e.status,
        e.mergedInto ?? null,
        json(e.identifiers),
        e.summary ? json(e.summary) : null,
        e.summary?.parentId ?? null,
        e.updatedAt,
        e.id,
      ],
    );
  }

  private async writeIdentifierIndex(q: Queryable, e: Pick<Entity, "id" | "tenantId" | "identifiers">): Promise<void> {
    for (const i of e.identifiers) {
      await q.query(
        `INSERT INTO entity_identifiers (entity_id, tenant_id, type, value) VALUES ($1, $2, $3, $4)
         ON CONFLICT DO NOTHING`,
        [e.id, e.tenantId, i.type, i.value],
      );
    }
  }

  // ---- views ----------------------------------------------------------------

  async defineView(tenantId: string, view: ViewDefinition): Promise<void> {
    requireText(view.name, "view.name");
    await this.db.query(
      `INSERT INTO views (tenant_id, name, def) VALUES ($1, $2, $3${JSONB})
       ON CONFLICT (tenant_id, name) DO UPDATE SET def = excluded.def`,
      [tenantId, view.name, json(view)],
    );
  }

  async listViews(tenantId: string): Promise<ViewDefinition[]> {
    const rows = await this.db.query<{ def: ViewDefinition }>("SELECT def FROM views WHERE tenant_id = $1 ORDER BY name", [
      tenantId,
    ]);
    return rows.map((r) => r.def);
  }

  // ---- extension state ------------------------------------------------------

  async getCursor(tenantId: string, source: string): Promise<string | null> {
    const rows = await this.db.query<{ cursor: string }>(
      "SELECT cursor FROM cursors WHERE tenant_id = $1 AND source = $2",
      [tenantId, source],
    );
    return rows[0]?.cursor ?? null;
  }

  async setCursor(tenantId: string, source: string, cursor: string): Promise<void> {
    await this.db.query(
      `INSERT INTO cursors (tenant_id, source, cursor, updated_at) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, source) DO UPDATE SET cursor = excluded.cursor, updated_at = excluded.updated_at`,
      [tenantId, source, cursor, this.now()],
    );
  }

  async kvGet<T = unknown>(namespace: string, key: string): Promise<T | null> {
    const rows = await this.db.query<{ value: T }>("SELECT value FROM kv WHERE namespace = $1 AND key = $2", [
      namespace,
      key,
    ]);
    const row = rows[0];
    return row ? row.value : null;
  }

  async kvSet<T = unknown>(namespace: string, key: string, value: T): Promise<void> {
    const text = JSON.stringify(value);
    if (text === undefined) throw new StoreError("INVALID_INPUT", "kv value must be JSON-serializable");
    await this.db.query(
      `INSERT INTO kv (namespace, key, value, updated_at) VALUES ($1, $2, $3${JSONB}, $4)
       ON CONFLICT (namespace, key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at`,
      [namespace, key, text, this.now()],
    );
  }

  async kvDelete(namespace: string, key: string): Promise<void> {
    await this.db.query("DELETE FROM kv WHERE namespace = $1 AND key = $2", [namespace, key]);
  }

  // ---- model usage (for the router) ----------------------------------------

  async recordModelCall(call: StoredModelCall): Promise<string> {
    const id = call.id ?? newId();
    await this.db.query(
      `INSERT INTO model_calls (id, tenant_id, tier, provider, model, input_tokens, output_tokens,
         cache_read_tokens, cost_usd, latency_ms, created_at, meta)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12${JSONB})`,
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
        call.meta ? json(call.meta) : null,
      ],
    );
    return id;
  }

  async sumModelCost(tenantId: string, sinceIso: string): Promise<number> {
    const rows = await this.db.query<{ total: number | null }>(
      "SELECT SUM(cost_usd)::double precision AS total FROM model_calls WHERE tenant_id = $1 AND created_at >= $2",
      [tenantId, iso(sinceIso, "sinceIso")],
    );
    return rows[0]?.total ?? 0;
  }
}

function participantFromRow(r: ParticipantRow): Participant {
  const p: Participant = { role: r.role };
  if (r.address !== null) p.address = r.address;
  if (r.name !== null) p.name = r.name;
  if (r.entity_id !== null) p.entityId = r.entity_id;
  if (r.self !== null) p.self = r.self;
  return p;
}

function factFromRow(r: FactRow, provenance: Provenance[]): Fact {
  const fact: Fact = {
    id: r.id,
    tenantId: r.tenant_id,
    type: r.type,
    subject: { entityId: r.subject_id },
    predicate: r.predicate,
    value: r.value,
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
  if (r.tags !== null) fact.tags = r.tags;
  return fact;
}

function entityFromRow(r: EntityRow): Entity {
  const e: Entity = {
    id: r.id,
    tenantId: r.tenant_id,
    kind: r.kind,
    name: r.name,
    identifiers: r.identifiers,
    status: r.status as Entity["status"],
    createdAt: r.created_at,
    updatedAt: r.updated_at,
  };
  if (r.merged_into !== null) e.mergedInto = r.merged_into;
  if (r.summary !== null) e.summary = r.summary;
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
