/**
 * Entities are projections, not records you fill in.
 *
 * A person is "everyone this set of identifiers has been seen as." A company
 * is "everyone at this domain plus what we know about them." A deal is a
 * cluster of facts the system proposed and someone named. The system proposes
 * entities from events; a human confirms, rejects or merges them. Rejections
 * and merges are themselves recorded so they are never undone by re-ingestion.
 */

export type EntityKind = "person" | "organization" | "deal" | "topic" | (string & {});

export type IdentifierType = "email" | "domain" | "phone" | "url" | "handle" | "name" | (string & {});

export interface Identifier {
  type: IdentifierType;
  /** Normalized: lowercased email, bare domain, E.164 phone. */
  value: string;
  confidence: number;
  /** Who attached it: "resolve", "user:jack", "mail". */
  source: string;
  firstSeen?: string;
  lastSeen?: string;
}

export type EntityStatus = "proposed" | "confirmed" | "rejected" | "merged";

export interface Entity {
  id: string;
  tenantId: string;
  kind: EntityKind;
  /** Best current display name. Derived; may change as evidence arrives. */
  name: string;
  identifiers: Identifier[];
  status: EntityStatus;
  /** When status is "merged", the surviving entity. */
  mergedInto?: string;
  /** Cheap denormalized summary for lists. Rebuilt by projections. */
  summary?: {
    firstSeen?: string;
    lastSeen?: string;
    eventCount?: number;
    openCommitments?: number;
    openAsks?: number;
    /** Organization id for people; owner id for deals. */
    parentId?: string;
  };
  createdAt: string;
  updatedAt: string;
}

export type NewEntity = Omit<Entity, "id" | "tenantId" | "createdAt" | "updatedAt"> & {
  tenantId?: string;
};

export interface EntityQuery {
  tenantId?: string;
  kind?: EntityKind | EntityKind[];
  status?: EntityStatus | EntityStatus[];
  /** Match any identifier value exactly. */
  identifier?: { type?: IdentifierType; value: string };
  /** Case-insensitive substring on name. */
  nameLike?: string;
  parentId?: string;
  limit?: number;
}

/**
 * A view is a user-defined field over an entity kind, described in natural
 * language, the way Lightfield defines attributes. The host backfills it from
 * the facts and events it has. Views are how "derived views" get defined by
 * users without a schema migration.
 */
export interface ViewDefinition {
  /** snake_case, unique per tenant. */
  name: string;
  appliesTo: EntityKind;
  /** What this field represents and how it should be populated. Read by a model. */
  description: string;
  valueType: "string" | "number" | "boolean" | "date" | "enum" | "entity" | "json";
  enumValues?: string[];
  /** "rule" views are computed by an extension; "model" views by the extract tier. */
  populatedBy: "rule" | "model";
}
