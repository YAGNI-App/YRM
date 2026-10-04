import type { AskValue, CommitmentValue, Fact, ObjectionValue, Store } from "@yrm/core";

export type OpenKind = "ask" | "commitment" | "objection";

export interface OpenItem {
  kind: OpenKind;
  /** Only commitments can be overdue. */
  overdue: boolean;
  dueAt: string | null;
  fact: Fact;
}

const OPEN_TYPES: OpenKind[] = ["ask", "commitment", "objection"];
/** Upper bound on facts scanned when no entity is given, so a big tenant cannot stall a call. */
const SCAN_LIMIT = 1000;

function record(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null ? (v as Record<string, unknown>) : {};
}

/** Classify a fact as an open item, or null when it is closed or not an open-able type. */
export function classify(fact: Fact, now: string): OpenItem | null {
  const v = record(fact.value);
  if (fact.type === "commitment") {
    const c = v as Partial<CommitmentValue>;
    if (c.status !== "open") return null;
    const dueAt = typeof c.dueAt === "string" ? c.dueAt : null;
    return { kind: "commitment", overdue: dueAt !== null && dueAt < now, dueAt, fact };
  }
  if (fact.type === "ask") {
    const a = v as Partial<AskValue>;
    if (a.answered !== false) return null;
    return { kind: "ask", overdue: false, dueAt: null, fact };
  }
  if (fact.type === "objection") {
    const o = v as Partial<ObjectionValue>;
    if (o.resolved !== false) return null;
    return { kind: "objection", overdue: false, dueAt: null, fact };
  }
  return null;
}

/**
 * Open asks, commitments and objections touching any of `entityIds` (either
 * side of the fact), or across the tenant when no ids are given. Uses the
 * store's default bi-temporal filter unless `at` is given, in which case both
 * valid time and belief time are pinned there.
 */
export async function openItems(
  store: Store,
  tenantId: string,
  entityIds: string[] | undefined,
  at?: string,
): Promise<OpenItem[]> {
  const now = at ?? new Date().toISOString();
  const facts: Fact[] = [];
  const seen = new Set<string>();
  const push = (fs: Fact[]): void => {
    for (const f of fs) {
      if (seen.has(f.id)) continue;
      seen.add(f.id);
      facts.push(f);
    }
  };
  const base = { tenantId, type: OPEN_TYPES, ...(at !== undefined ? { validAt: at, asOf: at } : {}) };
  if (entityIds === undefined) {
    push(await store.queryFacts({ ...base, limit: SCAN_LIMIT }));
  } else {
    for (const id of entityIds) push(await store.queryFacts({ ...base, entityId: id, limit: SCAN_LIMIT }));
  }
  const items = facts.flatMap((f) => {
    const item = classify(f, now);
    return item ? [item] : [];
  });
  // Overdue first, then by due date, then most recently recorded.
  return items.sort((a, b) => {
    if (a.overdue !== b.overdue) return a.overdue ? -1 : 1;
    if (a.dueAt !== b.dueAt) {
      if (a.dueAt === null) return 1;
      if (b.dueAt === null) return -1;
      return a.dueAt < b.dueAt ? -1 : 1;
    }
    return a.fact.recordedAt < b.fact.recordedAt ? 1 : -1;
  });
}
