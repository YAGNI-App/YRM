/**
 * Source events are the source of truth in YRM.
 *
 * Everything else (facts, entities, the attention queue) is derived from the
 * append-only log of events. An event is something that happened in the world
 * and reached us through a source: a message, a meeting, a note, a form
 * submission. Events are never mutated. If a source re-delivers the same
 * external id, the ingester must produce the same event (idempotent).
 */

/** How a participant relates to the event. Sources may add their own roles. */
export type ParticipantRole =
  | "from"
  | "to"
  | "cc"
  | "bcc"
  | "organizer"
  | "attendee"
  | "author"
  | "mentioned"
  | (string & {});

export interface Participant {
  role: ParticipantRole;
  /** Email address, phone number, handle. Lowercased by the ingester. */
  address?: string;
  /** Display name exactly as the source presented it. */
  name?: string;
  /** Set by the resolver after ingestion; never by the source. */
  entityId?: string;
  /** True when this participant is the tenant's own user (the "self" side). */
  self?: boolean;
}

export interface EventContent {
  /** The new text in this event, with quoted history and signatures stripped. */
  text: string;
  /** Subject line, meeting title, note heading. */
  title?: string;
  /** Quoted or boilerplate text removed from `text`, kept for provenance spans. */
  stripped?: string;
  mime?: string;
  /** Approximate token count of `text`, filled by the ingester or the host. */
  tokens?: number;
}

export interface SourceEvent {
  /** ULID. Monotonic within a tenant, so the log sorts by id. */
  id: string;
  tenantId: string;
  /** Name of the source extension that produced it, e.g. "mail", "calendar". */
  source: string;
  /** Source-specific kind, e.g. "message", "meeting", "note". */
  kind: string;
  /** Stable id from the source: RFC 5322 Message-ID, iCal UID, file path + hash. */
  externalId: string;
  /** When it happened in the world (ISO 8601). */
  occurredAt: string;
  /** When we recorded it (ISO 8601). */
  ingestedAt: string;
  participants: Participant[];
  content: EventContent;
  /** Groups events into a conversation: thread id, meeting series, notebook. */
  threadKey?: string;
  /** Ids of events this one replies to or follows. */
  inReplyTo?: string[];
  /** Source-specific extras: headers, URLs, labels. Keep it small. */
  meta: Record<string, unknown>;
  /** Optional pointer to the raw payload (path, blob key). Never the payload itself. */
  rawRef?: string;
}

/** What an ingester hands to the host. The host assigns id, tenantId and ingestedAt. */
export type NewSourceEvent = Omit<SourceEvent, "id" | "tenantId" | "ingestedAt"> & {
  tenantId?: string;
};

/** Filters for reading the log. All fields are AND-ed. */
export interface EventQuery {
  tenantId?: string;
  source?: string;
  kind?: string;
  threadKey?: string;
  /** Any participant with this address. */
  address?: string;
  /** Any participant resolved to this entity. */
  entityId?: string;
  occurredAfter?: string;
  occurredBefore?: string;
  /** Resume from this event id (exclusive). */
  afterId?: string;
  limit?: number;
}
