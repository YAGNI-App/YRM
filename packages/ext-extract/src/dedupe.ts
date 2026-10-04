import type { NewFact } from "@yrm/core";

/**
 * Reconcile what the rule and model extractors proposed for one event, in the
 * `extract:after` hook. Only facts this extension produced (`origin.by ===
 * "extract"`) are touched.
 *
 * - A rule fact with the same type and subject as a model fact whose quote
 *   overlaps it is dropped: the model read the same sentence with more context.
 * - Two facts may not supersede the same fact (the store would refuse the
 *   second); human beats model beats rule, then the first one proposed.
 */
export function dedupeFacts(facts: NewFact[], eventId: string): NewFact[] {
  const ours = (f: NewFact) => f.origin.by === "extract";
  const spanOf = (f: NewFact) => f.provenance.find((p) => p.eventId === eventId)?.span;
  const models = facts.filter((f) => ours(f) && f.origin.kind === "model");

  const overlapped = (r: NewFact): boolean => {
    const rs = spanOf(r);
    if (!rs) return false;
    return models.some((m) => {
      const ms = spanOf(m);
      return m.type === r.type && m.subject.entityId === r.subject.entityId && ms !== undefined && ms.start < rs.end && rs.start < ms.end;
    });
  };

  const kept = facts.filter((f) => !(ours(f) && f.origin.kind === "rule" && overlapped(f)));

  const rank = { human: 2, model: 1, rule: 0 } as const;
  const winner = new Map<string, NewFact>();
  for (const f of kept) {
    if (!f.supersedes) continue;
    const current = winner.get(f.supersedes);
    if (!current || rank[f.origin.kind] > rank[current.origin.kind]) winner.set(f.supersedes, f);
  }
  return kept.filter((f) => !f.supersedes || winner.get(f.supersedes) === f);
}
