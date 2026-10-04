/**
 * Facts are what YRM knows, each one pinned to where it came from and when it
 * was true. A fact is a bi-temporal edge:
 *
 *   valid time:       validFrom .. validTo        when it was true in the world
 *   transaction time: recordedAt .. retractedAt   when we believed it
 *
 * Facts are never edited or deleted. To change one, record a new fact that
 * `supersedes` the old one; the host closes the old fact's transaction time.
 * This is what lets an agent ask "what did we know on June 3rd" and get an
 * honest answer.
 *
 * Reconciliation rule: a fact of human origin outranks any model or rule
 * origin on the same subject/predicate, and a human override never flips back
 * because a model re-derived the old value.
 */

export type FactType =
  /** Someone promised to do something. value: CommitmentValue */
  | "commitment"
  /** Someone asked someone for something. value: AskValue */
  | "ask"
  /** A decision was made or communicated. value: DecisionValue */
  | "decision"
  /** Pushback, concern or blocker. value: ObjectionValue */
  | "objection"
  /** Something changed that may matter: job change, silence, sentiment shift. */
  | "signal"
  /** A role someone holds relative to something: decision maker, champion, owner. */
  | "role"
  /** A relationship between two entities: works_at, reports_to, competes_with. */
  | "relationship"
  /** A scalar attribute of an entity: title, timezone, deal stage, amount. */
  | "attribute"
  /** Anything an extension defines. Use a namespaced predicate. */
  | (string & {});

export interface EntityRef {
  entityId: string;
  /** Snapshot of the name at record time, for readability without a join. */
  name?: string;
}

/** Where a fact came from. Every fact has at least one. */
export interface Provenance {
  eventId: string;
  /** Who said it, if a person. */
  speaker?: EntityRef;
  /** Verbatim excerpt that supports the fact. */
  quote?: string;
  /** Character span of `quote` within the event's content.text. */
  span?: { start: number; end: number };
}

export type OriginKind = "human" | "model" | "rule";

export interface FactOrigin {
  kind: OriginKind;
  /** Extension or user that produced the fact, e.g. "extract", "user:jack". */
  by: string;
  /** Model id when kind is "model". */
  model?: string;
  /** Extractor or rule version, so re-extraction is auditable. */
  version?: string;
}

export interface CommitmentValue {
  what: string;
  /** Who owes it. Defaults to the fact subject. */
  owedBy?: EntityRef;
  /** Who it is owed to. Defaults to the fact object. */
  owedTo?: EntityRef;
  dueAt?: string;
  status: "open" | "fulfilled" | "broken" | "cancelled";
  /** Event that fulfilled or cancelled it. */
  resolvedBy?: string;
}

export interface AskValue {
  what: string;
  askedBy?: EntityRef;
  askedOf?: EntityRef;
  /** True once a reply addressing the ask has been seen. */
  answered: boolean;
  answeredBy?: string;
}

export interface DecisionValue {
  what: string;
  decidedBy?: EntityRef;
  rationale?: string;
}

export interface ObjectionValue {
  what: string;
  raisedBy?: EntityRef;
  severity?: "low" | "medium" | "high";
  resolved: boolean;
}

export interface Fact<V = unknown> {
  id: string;
  tenantId: string;
  type: FactType;
  /** What the fact is about. */
  subject: EntityRef;
  /** The other party or target, when there is one. */
  object?: EntityRef;
  /** Verb-ish, snake_case, namespaced for extensions: "committed_to", "works_at", "ext.crm.stage". */
  predicate: string;
  /** Structured payload. Shape depends on `type`. */
  value: V;
  /** One sentence a person can read. */
  statement: string;

  validFrom: string;
  validTo?: string;
  recordedAt: string;
  retractedAt?: string;

  provenance: Provenance[];
  /** 0..1. Human-origin facts are 1. */
  confidence: number;
  origin: FactOrigin;
  /** Fact id this one replaces. */
  supersedes?: string;
  /** Free-form labels extensions can filter on. */
  tags?: string[];
}

/** What an extractor hands to the host. The host assigns id, tenantId, recordedAt. */
export type NewFact<V = unknown> = Omit<Fact<V>, "id" | "tenantId" | "recordedAt" | "retractedAt"> & {
  tenantId?: string;
};

export interface FactQuery {
  tenantId?: string;
  type?: FactType | FactType[];
  predicate?: string;
  subjectId?: string;
  objectId?: string;
  /** Either side. */
  entityId?: string;
  /** Only facts that were true at this world time. Defaults to now. */
  validAt?: string;
  /** Only facts we believed at this transaction time. Defaults to now. */
  asOf?: string;
  /** Include retracted and superseded facts. */
  includeRetracted?: boolean;
  tags?: string[];
  minConfidence?: number;
  limit?: number;
}
