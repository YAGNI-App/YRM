import type { AskValue, CommitmentValue, Entity, Fact, Provenance, SourceEvent, Store, ViewDefinition } from "@yrm/core";

export interface RuleInput {
  tenantId: string;
  store: Store;
  entity: Entity;
  /** For an organization, its people. */
  members: Entity[];
  /** Events involving the entity (and members), newest first. */
  events: SourceEvent[];
  /** World time the value should hold at. */
  now: string;
}

export interface RuleResult {
  value: unknown;
  /** At least one event. */
  provenance: Provenance[];
  validFrom: string;
  /** Defaults to RULE_CONFIDENCE. */
  confidence?: number;
}

/** A rule view's function. Return null when there is nothing to say (no events yet). */
export type ViewRule = (input: RuleInput) => Promise<RuleResult | null>;

/** Topic on `yrm.events` for other extensions to add rule views: payload `{ name, rule }`. */
export const RULE_TOPIC = "views:rule";

export const RULE_CONFIDENCE = 0.95;
const OPEN_ITEMS_PROVENANCE = 10;

/** The date of the most recent event involving the entity. */
export const lastContact: ViewRule = async ({ events }) => {
  const latest = events[0];
  if (!latest) return null;
  return { value: latest.occurredAt.slice(0, 10), provenance: [{ eventId: latest.id }], validFrom: latest.occurredAt };
};

function isOpen(f: Fact): boolean {
  if (f.type === "commitment") return (f.value as Partial<CommitmentValue> | null)?.status === "open";
  if (f.type === "ask") return (f.value as Partial<AskValue> | null)?.answered === false;
  return false;
}

/** Open asks and commitments involving the entity (or its people), on either side. */
export const openItems: ViewRule = async ({ tenantId, store, entity, members, events, now }) => {
  const open = new Map<string, Fact>();
  for (const who of [entity, ...members]) {
    for (const f of await store.queryFacts({ tenantId, entityId: who.id, type: ["ask", "commitment"], validAt: now })) {
      if (isOpen(f)) open.set(f.id, f);
    }
  }
  const items = [...open.values()].sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const eventIds = [...new Set(items.flatMap((f) => f.provenance.map((p) => p.eventId)))].slice(0, OPEN_ITEMS_PROVENANCE);
  // Zero is a value too; it rests on the latest event, the last thing that could have opened one.
  const latest = events[0];
  if (eventIds.length === 0 && !latest) return null;
  return {
    value: items.length,
    provenance: (eventIds.length > 0 ? eventIds : [latest!.id]).map((eventId) => ({ eventId })),
    validFrom: items[0]?.validFrom ?? latest!.occurredAt,
  };
};

export const BUILTIN_RULES: ReadonlyArray<{ def: ViewDefinition; rule: ViewRule }> = [
  {
    def: {
      name: "last_contact",
      appliesTo: "person,organization",
      description: "Date of the most recent message, meeting or note involving this person or anyone at this organization.",
      valueType: "date",
      populatedBy: "rule",
    },
    rule: lastContact,
  },
  {
    def: {
      name: "open_items",
      appliesTo: "person,organization",
      description: "How many asks are unanswered and commitments still open involving this person or anyone at this organization, on either side.",
      valueType: "number",
      populatedBy: "rule",
    },
    rule: openItems,
  },
];
