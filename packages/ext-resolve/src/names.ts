import type { Command, Entity, Logger, Resolver, SourceEvent, Store } from "@yrm/core";
import { domainOf, isAutomatedAddress, isFreemail, isFullName, normalizeName } from "./normalize.ts";
import type { ResolveSettings } from "./settings.ts";

const NAMESPACE = "resolve";
const SIGNAL_CONFIDENCE = 0.6;
/** Cross-domain namesakes (0.6) are as likely a job change as one person; they always wait for a human. */
const AUTO_MERGE_MIN_SCORE = 0.8;
const ORIGIN = { kind: "rule", by: "resolve", version: "1" } as const;

interface Scope {
  store: Store;
  tenantId: string;
  log: Logger;
  settings: ResolveSettings;
}

/** Stored at `suggest:<idA>:<idB>` (ids sorted) in the `resolve` kv namespace. */
export interface MergeSuggestion {
  /** The newer entity; it disappears into `into` on merge. */
  from: string;
  into: string;
  reason: string;
  /** Events where the evidence was seen. */
  evidence: string[];
  score: number;
}

export function suggestionKey(a: string, b: string): string {
  return `suggest:${[a, b].sort().join(":")}`;
}

// The Store has no kv listing, so names and open suggestions keep their own indexes.
const nameKey = (tenantId: string, normalized: string): string => `name:${tenantId}:${normalized}`;
const suggestionsKey = (tenantId: string): string => `suggestions:${tenantId}`;

/** Remember which people carry a normalized full name, for same-name lookups. */
export async function indexName(s: Pick<Scope, "store" | "tenantId">, entity: Entity): Promise<void> {
  if (entity.kind !== "person") return;
  const norm = normalizeName(entity.name);
  if (!isFullName(norm)) return;
  const key = nameKey(s.tenantId, norm);
  const ids = (await s.store.kvGet<string[]>(NAMESPACE, key)) ?? [];
  if (!ids.includes(entity.id)) await s.store.kvSet(NAMESPACE, key, [...ids, entity.id]);
}

/** Live people (merges followed) whose name normalizes to `norm`. */
async function peopleNamed(s: Pick<Scope, "store" | "tenantId">, norm: string): Promise<Entity[]> {
  const ids = (await s.store.kvGet<string[]>(NAMESPACE, nameKey(s.tenantId, norm))) ?? [];
  const out = new Map<string, Entity>();
  for (const id of ids) {
    const e = await s.store.resolveEntity(id);
    if (!e || e.kind !== "person" || e.status === "rejected" || e.status === "merged") continue;
    if (normalizeName(e.name) === norm) out.set(e.id, e);
  }
  return [...out.values()];
}

const emailsOf = (e: Entity): string[] => e.identifiers.filter((i) => i.type === "email").map((i) => i.value);

function newer(a: Entity, b: Entity): [Entity, Entity] {
  const aNewer = a.createdAt === b.createdAt ? a.id > b.id : a.createdAt > b.createdAt;
  return aNewer ? [a, b] : [b, a];
}

async function sharesThread(s: Scope, event: SourceEvent, other: Entity): Promise<boolean> {
  if (event.participants.some((p) => p.entityId === other.id)) return true;
  if (!event.threadKey) return false;
  const seen = await s.store.listEvents({ tenantId: s.tenantId, threadKey: event.threadKey, entityId: other.id, limit: 1 });
  return seen.length > 0;
}

/** Why two same-named people might be one, strongest evidence first. */
async function assess(s: Scope, event: SourceEvent, a: Entity, b: Entity): Promise<{ reason: string; score: number }> {
  if (await sharesThread(s, event, b)) return { reason: "same name, seen in the same thread", score: 0.9 };
  const freemail = [...emailsOf(a), ...emailsOf(b)].some((addr) => {
    const d = domainOf(addr);
    return d !== undefined && isFreemail(d, s.settings.freemailDomains);
  });
  if (freemail) return { reason: "same name, one address is on a freemail domain", score: 0.8 };
  // Same full name at two company domains: a job change or a namesake. Weakest, never auto-merged.
  return { reason: "same name at different domains", score: 0.6 };
}

async function addSuggestion(s: Scope, suggestion: MergeSuggestion): Promise<void> {
  const key = suggestionKey(suggestion.from, suggestion.into);
  const prev = await s.store.kvGet<MergeSuggestion>(NAMESPACE, key);
  const merged: MergeSuggestion = prev
    ? {
        ...(suggestion.score > prev.score ? suggestion : prev),
        evidence: [...new Set([...prev.evidence, ...suggestion.evidence])],
        score: Math.max(prev.score, suggestion.score),
      }
    : suggestion;
  await s.store.kvSet(NAMESPACE, key, merged);
  const index = (await s.store.kvGet<string[]>(NAMESPACE, suggestionsKey(s.tenantId))) ?? [];
  if (!index.includes(key)) await s.store.kvSet(NAMESPACE, suggestionsKey(s.tenantId), [...index, key]);
}

async function dropSuggestion(store: Store, tenantId: string, key: string): Promise<void> {
  await store.kvDelete(NAMESPACE, key);
  const index = (await store.kvGet<string[]>(NAMESPACE, suggestionsKey(tenantId))) ?? [];
  if (index.includes(key)) await store.kvSet(NAMESPACE, suggestionsKey(tenantId), index.filter((k) => k !== key));
}

export async function listSuggestions(store: Store, tenantId: string): Promise<MergeSuggestion[]> {
  const out: MergeSuggestion[] = [];
  for (const key of (await store.kvGet<string[]>(NAMESPACE, suggestionsKey(tenantId))) ?? []) {
    const s = await store.kvGet<MergeSuggestion>(NAMESPACE, key);
    if (s) out.push(s);
  }
  return out;
}

async function recordSignal(s: Scope, event: SourceEvent, from: Entity, into: Entity, reason: string, score: number): Promise<void> {
  const existing = await s.store.queryFacts({ tenantId: s.tenantId, predicate: "possibly_same_person", entityId: from.id });
  const pair = new Set([from.id, into.id]);
  if (existing.some((f) => pair.has(f.subject.entityId) && f.object !== undefined && pair.has(f.object.entityId))) return;
  const fromAddr = emailsOf(from).join(", ");
  const intoAddr = emailsOf(into).join(", ");
  await s.store.recordFact({
    tenantId: s.tenantId,
    type: "signal",
    subject: { entityId: from.id, name: from.name },
    object: { entityId: into.id, name: into.name },
    predicate: "possibly_same_person",
    value: { reason, score, addresses: { from: emailsOf(from), into: emailsOf(into) } },
    statement: `${from.name} (${fromAddr}) may be the same person as ${into.name} (${intoAddr}).`,
    validFrom: event.occurredAt,
    provenance: [{ eventId: event.id }],
    confidence: SIGNAL_CONFIDENCE,
    origin: { ...ORIGIN },
  });
}

/**
 * After header resolution: people on this event who share a full normalized
 * name with someone already known become a merge suggestion and a
 * `possibly_same_person` signal. Merging is left to a human unless
 * `autoMergeSameName` is set and the evidence is stronger than a shared name.
 *
 * This runs from the `resolve:after` hook rather than inside a resolver: the
 * host stops calling resolvers once every participant has an entity, which
 * after the header resolver is almost always the case.
 */
export async function suggestSameName(s: Scope, event: SourceEvent, entities: Entity[]): Promise<number> {
  let made = 0;
  const done = new Set<string>();
  for (const listed of entities) {
    // Re-read: an auto-merge earlier in this loop may have folded this entity away.
    const person = await s.store.resolveEntity(listed.id);
    if (!person || done.has(person.id)) continue;
    done.add(person.id);
    if (person.kind !== "person" || person.status === "merged" || person.status === "rejected") continue;
    const emails = emailsOf(person);
    if (emails.length === 0 || emails.every(isAutomatedAddress)) continue;
    const norm = normalizeName(person.name);
    if (!isFullName(norm)) continue;
    for (const other of await peopleNamed(s, norm)) {
      if (other.id === person.id) continue;
      const otherEmails = emailsOf(other);
      if (otherEmails.length === 0 || otherEmails.every(isAutomatedAddress)) continue;
      const { reason, score } = await assess(s, event, person, other);
      const [from, into] = newer(person, other);
      await addSuggestion(s, { from: from.id, into: into.id, reason, evidence: [event.id], score });
      await recordSignal(s, event, from, into, reason, score);
      made++;
      if (s.settings.autoMergeSameName && score >= AUTO_MERGE_MIN_SCORE) {
        await s.store.mergeEntities(from.id, into.id, "resolve");
        await dropSuggestion(s.store, s.tenantId, suggestionKey(from.id, into.id));
        s.log.info("auto-merged same-name people", { from: from.id, into: into.id, reason, confidence: score });
        if (from.id === person.id) break;
      }
    }
  }
  return made;
}

/**
 * Priority 50: participants with a name but no address (calendar attendees,
 * people mentioned in notes) link to the one known person with that full name.
 * Ambiguous names stay unresolved for later resolvers.
 */
export function nameLinkResolver(): Resolver {
  return {
    name: "name-link-resolver",
    priority: 50,
    async resolve(event, ctx) {
      const out: Array<{ index: number; entityId: string }> = [];
      for (const [index, p] of event.participants.entries()) {
        if (p.entityId !== undefined || p.address || !p.name) continue;
        const norm = normalizeName(p.name);
        if (!isFullName(norm)) continue;
        const matches = await peopleNamed({ store: ctx.store, tenantId: ctx.tenantId }, norm);
        if (matches.length === 1) out.push({ index, entityId: matches[0]!.id });
      }
      return out;
    },
  };
}

function principal(flags: Record<string, string | boolean>): string {
  const flag = flags["user"] ?? flags["by"];
  if (typeof flag === "string" && flag) return flag;
  return process.env["USER"] ?? "unknown";
}

export function suggestionsCommand(): Command {
  return {
    name: "resolve:suggestions",
    description: "List people the resolver thinks may be the same person.",
    usage: "resolve:suggestions",
    async run(ctx) {
      const list = await listSuggestions(ctx.store, ctx.tenantId);
      if (list.length === 0) {
        ctx.stdout("No merge suggestions.");
        return 0;
      }
      for (const sug of list.sort((a, b) => b.score - a.score)) {
        const from = await ctx.store.getEntity(sug.from);
        const into = await ctx.store.getEntity(sug.into);
        ctx.stdout(
          `${sug.from} -> ${sug.into}  ${sug.score.toFixed(2)}  ${from?.name ?? "?"} / ${into?.name ?? "?"}: ${sug.reason} (${sug.evidence.length} event${sug.evidence.length === 1 ? "" : "s"})`,
        );
      }
      return 0;
    },
  };
}

export function mergeCommand(): Command {
  return {
    name: "resolve:merge",
    description: "Merge one person into another and clear the suggestion.",
    usage: "resolve:merge <from> <into> [--user name]",
    async run(ctx) {
      const [from, into] = ctx.args;
      if (!from || !into) {
        ctx.stderr("usage: resolve:merge <from> <into> [--user name]");
        return 1;
      }
      const survivor = await ctx.store.mergeEntities(from, into, `user:${principal(ctx.flags)}`);
      await dropSuggestion(ctx.store, ctx.tenantId, suggestionKey(from, into));
      ctx.stdout(`Merged ${from} into ${survivor.id} (${survivor.name}).`);
      return 0;
    },
  };
}
