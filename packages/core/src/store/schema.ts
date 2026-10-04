import type { Database } from "bun:sqlite";

/**
 * Versioned migrations for the SQLite store. Append new entries; never edit
 * one that has shipped. Each runs in its own transaction together with the
 * `schema_version` row that records it.
 *
 * All times are ISO 8601 UTC strings normalized by the store, so text
 * comparison is chronological comparison.
 */
export interface Migration {
  version: number;
  name: string;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  {
    version: 1,
    name: "initial",
    sql: `
      CREATE TABLE events (
        id            TEXT PRIMARY KEY,
        tenant_id     TEXT NOT NULL,
        source        TEXT NOT NULL,
        kind          TEXT NOT NULL,
        external_id   TEXT NOT NULL,
        occurred_at   TEXT NOT NULL,
        ingested_at   TEXT NOT NULL,
        thread_key    TEXT,
        in_reply_to   TEXT,
        content_json  TEXT NOT NULL,
        meta_json     TEXT NOT NULL,
        raw_ref       TEXT,
        UNIQUE (tenant_id, source, external_id)
      );
      CREATE INDEX events_tenant_occurred ON events (tenant_id, occurred_at);
      CREATE INDEX events_tenant_thread ON events (tenant_id, thread_key);

      CREATE TABLE event_participants (
        event_id   TEXT NOT NULL REFERENCES events (id),
        idx        INTEGER NOT NULL,
        role       TEXT NOT NULL,
        address    TEXT,
        name       TEXT,
        entity_id  TEXT,
        self       INTEGER,
        PRIMARY KEY (event_id, idx)
      );
      CREATE INDEX event_participants_address ON event_participants (address);
      CREATE INDEX event_participants_entity ON event_participants (entity_id);

      CREATE TABLE facts (
        id              TEXT PRIMARY KEY,
        tenant_id       TEXT NOT NULL,
        type            TEXT NOT NULL,
        subject_id      TEXT NOT NULL,
        subject_name    TEXT,
        object_id       TEXT,
        object_name     TEXT,
        predicate       TEXT NOT NULL,
        value_json      TEXT NOT NULL,
        statement       TEXT NOT NULL,
        valid_from      TEXT NOT NULL,
        valid_to        TEXT,
        recorded_at     TEXT NOT NULL,
        retracted_at    TEXT,
        confidence      REAL NOT NULL,
        origin_kind     TEXT NOT NULL,
        origin_by       TEXT NOT NULL,
        origin_model    TEXT,
        origin_version  TEXT,
        supersedes      TEXT REFERENCES facts (id),
        tags_json       TEXT
      );
      CREATE INDEX facts_subject_predicate ON facts (tenant_id, subject_id, predicate);
      CREATE INDEX facts_object ON facts (tenant_id, object_id);
      CREATE INDEX facts_recorded ON facts (tenant_id, recorded_at);

      CREATE TABLE fact_provenance (
        fact_id       TEXT NOT NULL REFERENCES facts (id),
        idx           INTEGER NOT NULL,
        event_id      TEXT NOT NULL,
        speaker_id    TEXT,
        speaker_name  TEXT,
        quote         TEXT,
        span_start    INTEGER,
        span_end      INTEGER,
        PRIMARY KEY (fact_id, idx)
      );
      CREATE INDEX fact_provenance_event ON fact_provenance (event_id);

      CREATE TABLE fact_audit (
        fact_id  TEXT NOT NULL REFERENCES facts (id),
        action   TEXT NOT NULL,
        by       TEXT NOT NULL,
        at       TEXT NOT NULL
      );
      CREATE INDEX fact_audit_fact ON fact_audit (fact_id);

      CREATE TABLE entities (
        id                TEXT PRIMARY KEY,
        tenant_id         TEXT NOT NULL,
        kind              TEXT NOT NULL,
        name              TEXT NOT NULL,
        status            TEXT NOT NULL,
        merged_into       TEXT REFERENCES entities (id),
        identifiers_json  TEXT NOT NULL,
        summary_json      TEXT,
        parent_id         TEXT,
        created_at        TEXT NOT NULL,
        updated_at        TEXT NOT NULL
      );
      CREATE INDEX entities_tenant_kind ON entities (tenant_id, kind);
      CREATE INDEX entities_parent ON entities (tenant_id, parent_id);

      CREATE TABLE entity_identifiers (
        entity_id  TEXT NOT NULL REFERENCES entities (id),
        tenant_id  TEXT NOT NULL,
        type       TEXT NOT NULL,
        value      TEXT NOT NULL,
        PRIMARY KEY (entity_id, type, value)
      );
      CREATE INDEX entity_identifiers_lookup ON entity_identifiers (tenant_id, value, type);

      CREATE TABLE entity_audit (
        entity_id    TEXT NOT NULL REFERENCES entities (id),
        action       TEXT NOT NULL,
        by           TEXT NOT NULL,
        at           TEXT NOT NULL,
        detail_json  TEXT
      );
      CREATE INDEX entity_audit_entity ON entity_audit (entity_id);

      CREATE TABLE views (
        tenant_id  TEXT NOT NULL,
        name       TEXT NOT NULL,
        def_json   TEXT NOT NULL,
        PRIMARY KEY (tenant_id, name)
      );

      CREATE TABLE cursors (
        tenant_id   TEXT NOT NULL,
        source      TEXT NOT NULL,
        cursor      TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (tenant_id, source)
      );

      CREATE TABLE kv (
        namespace   TEXT NOT NULL,
        key         TEXT NOT NULL,
        value_json  TEXT NOT NULL,
        updated_at  TEXT NOT NULL,
        PRIMARY KEY (namespace, key)
      );

      CREATE TABLE model_calls (
        id                 TEXT PRIMARY KEY,
        tenant_id          TEXT NOT NULL,
        tier               TEXT NOT NULL,
        provider           TEXT NOT NULL,
        model              TEXT NOT NULL,
        input_tokens       INTEGER NOT NULL DEFAULT 0,
        output_tokens      INTEGER NOT NULL DEFAULT 0,
        cache_read_tokens  INTEGER NOT NULL DEFAULT 0,
        cost_usd           REAL NOT NULL DEFAULT 0,
        latency_ms         INTEGER,
        created_at         TEXT NOT NULL,
        meta_json          TEXT
      );
      CREATE INDEX model_calls_tenant_created ON model_calls (tenant_id, created_at);
    `,
  },
];

/** Apply every migration newer than the recorded schema version. */
export function applyMigrations(db: Database, now: () => string): number[] {
  db.run(`CREATE TABLE IF NOT EXISTS schema_version (
    version     INTEGER PRIMARY KEY,
    name        TEXT NOT NULL,
    applied_at  TEXT NOT NULL
  )`);
  const row = db.query<{ v: number | null }, []>("SELECT MAX(version) AS v FROM schema_version").get();
  const current = row?.v ?? 0;
  const applied: number[] = [];
  for (const m of MIGRATIONS) {
    if (m.version <= current) continue;
    db.transaction(() => {
      db.exec(m.sql);
      db.run("INSERT INTO schema_version (version, name, applied_at) VALUES (?, ?, ?)", [m.version, m.name, now()]);
    })();
    applied.push(m.version);
  }
  return applied;
}
