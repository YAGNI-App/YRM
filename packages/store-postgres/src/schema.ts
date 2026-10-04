import type { SqlClient } from "./client.ts";

/**
 * Versioned migrations for the Postgres store. Append new entries; never edit
 * one that has shipped. Each runs in its own transaction together with the
 * `schema_version` row that records it.
 *
 * Tables, keys and indexes mirror `packages/core/src/store/schema.ts` (see
 * ADR 0009). Times are ISO 8601 UTC strings normalized by the store, kept as
 * `text COLLATE "C"` so comparison and ordering are byte order, exactly as in
 * SQLite. Ids use the same collation so ULID order is creation order whatever
 * the database's default locale. JSON columns are jsonb.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

/** Text that compares byte-wise: ULIDs, ISO times, names we ORDER BY. */
const K = 'text COLLATE "C"';

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE events (
        id            ${K} PRIMARY KEY,
        tenant_id     ${K} NOT NULL,
        source        text NOT NULL,
        kind          text NOT NULL,
        external_id   text NOT NULL,
        occurred_at   ${K} NOT NULL,
        ingested_at   ${K} NOT NULL,
        thread_key    text,
        in_reply_to   jsonb,
        content       jsonb NOT NULL,
        meta          jsonb NOT NULL,
        raw_ref       text,
        UNIQUE (tenant_id, source, external_id)
      );
      CREATE INDEX events_tenant_occurred ON events (tenant_id, occurred_at);
      CREATE INDEX events_tenant_thread ON events (tenant_id, thread_key);

      CREATE TABLE event_participants (
        event_id   ${K} NOT NULL REFERENCES events (id),
        idx        integer NOT NULL,
        role       text NOT NULL,
        address    text,
        name       text,
        entity_id  ${K},
        self       boolean,
        PRIMARY KEY (event_id, idx)
      );
      CREATE INDEX event_participants_address ON event_participants (address);
      CREATE INDEX event_participants_entity ON event_participants (entity_id);

      CREATE TABLE facts (
        id              ${K} PRIMARY KEY,
        tenant_id       ${K} NOT NULL,
        type            text NOT NULL,
        subject_id      ${K} NOT NULL,
        subject_name    text,
        object_id       ${K},
        object_name     text,
        predicate       text NOT NULL,
        value           jsonb NOT NULL,
        statement       text NOT NULL,
        valid_from      ${K} NOT NULL,
        valid_to        ${K},
        recorded_at     ${K} NOT NULL,
        retracted_at    ${K},
        confidence      double precision NOT NULL CHECK (confidence >= 0 AND confidence <= 1),
        origin_kind     text NOT NULL,
        origin_by       text NOT NULL,
        origin_model    text,
        origin_version  text,
        supersedes      ${K} REFERENCES facts (id),
        tags            jsonb
      );
      CREATE INDEX facts_subject_predicate ON facts (tenant_id, subject_id, predicate);
      CREATE INDEX facts_object ON facts (tenant_id, object_id);
      CREATE INDEX facts_recorded ON facts (tenant_id, recorded_at);
      -- The human-beats-model check looks for a believed human fact on every write.
      CREATE INDEX facts_believed_human ON facts (tenant_id, subject_id, predicate)
        WHERE origin_kind = 'human' AND retracted_at IS NULL;
      CREATE INDEX facts_tags ON facts USING gin (tags);

      CREATE TABLE fact_provenance (
        fact_id       ${K} NOT NULL REFERENCES facts (id),
        idx           integer NOT NULL,
        event_id      ${K} NOT NULL,
        speaker_id    ${K},
        speaker_name  text,
        quote         text,
        span_start    integer,
        span_end      integer,
        PRIMARY KEY (fact_id, idx)
      );
      CREATE INDEX fact_provenance_event ON fact_provenance (event_id);

      CREATE TABLE fact_audit (
        fact_id  ${K} NOT NULL REFERENCES facts (id),
        action   text NOT NULL,
        by       text NOT NULL,
        at       ${K} NOT NULL
      );
      CREATE INDEX fact_audit_fact ON fact_audit (fact_id);

      CREATE TABLE entities (
        id           ${K} PRIMARY KEY,
        tenant_id    ${K} NOT NULL,
        kind         text NOT NULL,
        name         text NOT NULL,
        status       text NOT NULL,
        merged_into  ${K} REFERENCES entities (id),
        identifiers  jsonb NOT NULL,
        summary      jsonb,
        parent_id    ${K},
        created_at   ${K} NOT NULL,
        updated_at   ${K} NOT NULL
      );
      CREATE INDEX entities_tenant_kind ON entities (tenant_id, kind);
      CREATE INDEX entities_parent ON entities (tenant_id, parent_id);

      CREATE TABLE entity_identifiers (
        entity_id  ${K} NOT NULL REFERENCES entities (id),
        tenant_id  ${K} NOT NULL,
        type       text NOT NULL,
        value      text NOT NULL,
        PRIMARY KEY (entity_id, type, value)
      );
      CREATE INDEX entity_identifiers_lookup ON entity_identifiers (tenant_id, value, type);

      CREATE TABLE entity_audit (
        entity_id  ${K} NOT NULL REFERENCES entities (id),
        action     text NOT NULL,
        by         text NOT NULL,
        at         ${K} NOT NULL,
        detail     jsonb
      );
      CREATE INDEX entity_audit_entity ON entity_audit (entity_id);

      CREATE TABLE views (
        tenant_id  ${K} NOT NULL,
        name       ${K} NOT NULL,
        def        jsonb NOT NULL,
        PRIMARY KEY (tenant_id, name)
      );

      CREATE TABLE cursors (
        tenant_id   ${K} NOT NULL,
        source      text NOT NULL,
        cursor      text NOT NULL,
        updated_at  ${K} NOT NULL,
        PRIMARY KEY (tenant_id, source)
      );

      -- kv is namespaced by extension, not by tenant, exactly as in SQLite;
      -- the Store interface has no tenant on kv calls.
      CREATE TABLE kv (
        namespace   text NOT NULL,
        key         text NOT NULL,
        value       jsonb NOT NULL,
        updated_at  ${K} NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE model_calls (
        id                 ${K} PRIMARY KEY,
        tenant_id          ${K} NOT NULL,
        tier               text NOT NULL,
        provider           text NOT NULL,
        model              text NOT NULL,
        input_tokens       integer NOT NULL DEFAULT 0,
        output_tokens      integer NOT NULL DEFAULT 0,
        cache_read_tokens  integer NOT NULL DEFAULT 0,
        cost_usd           double precision NOT NULL DEFAULT 0,
        latency_ms         integer,
        created_at         ${K} NOT NULL,
        meta               jsonb
      );
      CREATE INDEX model_calls_tenant_created ON model_calls (tenant_id, created_at);

      -- Append-only, enforced below the store as well as in it (AGENTS.md rule 3).
      -- Events never change; participants change only entity_id (the resolver
      -- and merge). Facts change only to close retracted_at or valid_to once,
      -- and to repoint subject/object on merge.
      CREATE FUNCTION yrm_reject_change() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        RAISE EXCEPTION 'yrm: % on % is not allowed (append-only)', TG_OP, TG_TABLE_NAME
          USING ERRCODE = 'integrity_constraint_violation';
      END $$;

      CREATE FUNCTION yrm_guard_participant_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.event_id, NEW.idx, NEW.role, NEW.address, NEW.name, NEW.self)
           IS DISTINCT FROM (OLD.event_id, OLD.idx, OLD.role, OLD.address, OLD.name, OLD.self) THEN
          RAISE EXCEPTION 'yrm: only event_participants.entity_id may change'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;

      CREATE FUNCTION yrm_guard_fact_update() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF (NEW.id, NEW.tenant_id, NEW.type, NEW.subject_name, NEW.object_name, NEW.predicate, NEW.value,
            NEW.statement, NEW.valid_from, NEW.recorded_at, NEW.confidence, NEW.origin_kind, NEW.origin_by,
            NEW.origin_model, NEW.origin_version, NEW.supersedes, NEW.tags)
           IS DISTINCT FROM
           (OLD.id, OLD.tenant_id, OLD.type, OLD.subject_name, OLD.object_name, OLD.predicate, OLD.value,
            OLD.statement, OLD.valid_from, OLD.recorded_at, OLD.confidence, OLD.origin_kind, OLD.origin_by,
            OLD.origin_model, OLD.origin_version, OLD.supersedes, OLD.tags) THEN
          RAISE EXCEPTION 'yrm: facts are append-only; record a superseding fact'
            USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.retracted_at IS NOT NULL AND NEW.retracted_at IS DISTINCT FROM OLD.retracted_at THEN
          RAISE EXCEPTION 'yrm: retracted_at is already set' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        IF OLD.valid_to IS NOT NULL AND NEW.valid_to IS DISTINCT FROM OLD.valid_to THEN
          RAISE EXCEPTION 'yrm: valid_to is already set' USING ERRCODE = 'integrity_constraint_violation';
        END IF;
        RETURN NEW;
      END $$;

      CREATE TRIGGER events_append_only BEFORE UPDATE OR DELETE ON events
        FOR EACH ROW EXECUTE FUNCTION yrm_reject_change();
      CREATE TRIGGER event_participants_no_delete BEFORE DELETE ON event_participants
        FOR EACH ROW EXECUTE FUNCTION yrm_reject_change();
      CREATE TRIGGER event_participants_entity_only BEFORE UPDATE ON event_participants
        FOR EACH ROW EXECUTE FUNCTION yrm_guard_participant_update();
      CREATE TRIGGER facts_no_delete BEFORE DELETE ON facts
        FOR EACH ROW EXECUTE FUNCTION yrm_reject_change();
      CREATE TRIGGER facts_append_only BEFORE UPDATE ON facts
        FOR EACH ROW EXECUTE FUNCTION yrm_guard_fact_update();
      CREATE TRIGGER fact_provenance_no_delete BEFORE DELETE ON fact_provenance
        FOR EACH ROW EXECUTE FUNCTION yrm_reject_change();
    `,
  },
];

// Arbitrary constant: every YRM process migrating the same database takes
// this lock, so two hosts starting together do not race on DDL.
const MIGRATION_LOCK = 7_402_119_001;

/** Apply every migration newer than the recorded schema version. */
export async function applyMigrations(client: SqlClient, now: () => string): Promise<number[]> {
  await client.transaction(async (tx) => {
    await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
    await tx.exec(`CREATE TABLE IF NOT EXISTS schema_version (
      version     integer PRIMARY KEY,
      name        text NOT NULL,
      applied_at  text NOT NULL
    )`);
  });
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    const ran = await client.transaction(async (tx) => {
      await tx.query("SELECT pg_advisory_xact_lock($1)", [MIGRATION_LOCK]);
      const rows = await tx.query<{ v: number | null }>("SELECT MAX(version) AS v FROM schema_version");
      if ((rows[0]?.v ?? 0) >= m.version) return false;
      await tx.exec(m.sql);
      await tx.query("INSERT INTO schema_version (version, name, applied_at) VALUES ($1, $2, $3)", [
        m.version,
        m.name,
        now(),
      ]);
      return true;
    });
    if (ran) applied.push(m.version);
  }
  return applied;
}
