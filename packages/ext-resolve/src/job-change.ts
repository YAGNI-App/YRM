import type { Entity, EntityRef, Extractor, Fact, NewFact, SourceEvent, Store } from "@yrm/core";
import { RULE_ORIGIN, WORKS_AT_CONFIDENCE } from "./header.ts";

/** Cheap gate: phrases people use when they announce a move. */
export const JOB_CHANGE_TRIGGER =
  /\b(my last day|i('|’| a)m leaving|moving on from|joining|starting at|new role at|no longer (at|with))\b/i;

/** Phrases that announce a move on their own. "joining" alone ("joining the call") does not. */
const STRONG = /\b(my last day|i('|’| a)m leaving|moving on from|no longer (at|with))\b/i;
const FIRST_PERSON = /\b(i|i'm|i’m|i've|i’ve|i'll|i’ll|i am|i will)\b/i;

// A run of capitalized words: "Northwind Automation", "Acme", "Smith & Co".
const COMPANY = String.raw`([A-Z][\w&'’-]*(?:\s+(?:&\s+)?[A-Z][\w&'’-]*)*)`;
const LEAVING = new RegExp(String.raw`\b(?:my last day (?:at|with)|leaving|moving on from|no longer (?:at|with))\s+${COMPANY}`);
const JOINING = new RegExp(
  String.raw`\b(?:joining|starting at|start(?:ing)? (?:at|with)|new role (?:at|with)|leaving for|moving to|(?:accepted|taken|took|taking) (?:a|an|the) (?:new )?(?:role|job|position|offer) (?:at|with|from))\s+${COMPANY}`,
);

export interface JobChangeValue {
  leaving?: string;
  joining?: string;
}

interface Sentence {
  text: string;
  start: number;
  end: number;
}

function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = (m.index ?? 0) + lead;
    out.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return out;
}

function company(re: RegExp, s: string): string | undefined {
  const m = re.exec(s);
  // Drop a trailing pronoun-ish capital that starts the next clause ("Acme I") and stray punctuation.
  return m?.[1]?.replace(/[.'’-]+$/, "").replace(/\s+I$/, "").trim() || undefined;
}

/** What the text says about leaving and joining, from the trigger sentence and the two after it. */
export function parseJobChange(text: string): { value: JobChangeValue; quote: Sentence } | null {
  const all = sentences(text);
  const at = all.findIndex((s) => JOB_CHANGE_TRIGGER.test(s.text));
  if (at < 0) return null;
  const trigger = all[at]!;
  const window = all.slice(at, at + 3);
  const value: JobChangeValue = {};
  let last = trigger;
  for (const s of window) {
    const leaving = value.leaving ?? company(LEAVING, s.text);
    const joining = value.joining ?? company(JOINING, s.text);
    if (leaving !== value.leaving || joining !== value.joining) last = s;
    if (leaving) value.leaving = leaving;
    if (joining) value.joining = joining;
  }
  const strong = STRONG.test(trigger.text);
  // Weak phrasing counts only when the writer talks about themselves and names a destination.
  if (!strong && !(value.joining && FIRST_PERSON.test(trigger.text))) return null;
  return {
    value,
    quote: { text: text.slice(trigger.start, last.end), start: trigger.start, end: last.end },
  };
}

function currentEmployer(facts: Fact[], personId: string): string | undefined {
  return facts
    .filter((f) => f.predicate === "works_at" && f.subject.entityId === personId && f.object?.name)
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0]?.object?.name;
}

function words(s: string): string[] {
  return s
    .toLowerCase()
    .replace(/[’']s\b/g, "")
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
}

/** One word list starts the other: "Acme" names "Acme Robotics", "Northwind Automation" names "Northwind". */
function prefixOf(a: string[], b: string[]): boolean {
  const [short, long] = a.length <= b.length ? [a, b] : [b, a];
  return short.length > 0 && short.every((w, i) => long[i] === w);
}

/** Does `said` (as written in a message) name this organization, by name or by its domain's first label? */
export function namesOrganization(said: string, org: Pick<Entity, "name" | "identifiers">): boolean {
  const s = words(said);
  if (prefixOf(s, words(org.name))) return true;
  return org.identifiers.some((i) => i.type === "domain" && prefixOf(s, words(i.value.split(".")[0] ?? "")));
}

async function findOrganization(store: Store, tenantId: string, said: string): Promise<Entity | undefined> {
  const first = words(said)[0];
  if (!first) return undefined;
  const found = await store.findEntities({ tenantId, kind: "organization", nameLike: first });
  return found.find((o) => o.status !== "merged" && o.status !== "rejected" && namesOrganization(said, o));
}

/**
 * Close the old `works_at` and open the new one. Ends only rule- or
 * model-origin edges that are still open at the move, so running twice is a
 * no-op; a human-origin edge is the human's call. Returns the new `works_at`
 * to record (possibly superseding one that starts later, as when the new
 * address shows up weeks after the move), or nothing if one already covers it.
 */
async function moveEmployer(
  store: Store,
  tenantId: string,
  person: EntityRef,
  value: JobChangeValue,
  event: SourceEvent,
  provenance: NewFact["provenance"],
): Promise<{ joining?: Entity; worksAt?: NewFact; ended: NewFact[] }> {
  const at = event.occurredAt;
  const ended: NewFact[] = [];
  const mine = { tenantId, subjectId: person.entityId, predicate: "works_at" };
  if (value.leaving) {
    for (const f of await store.queryFacts({ ...mine, validAt: at })) {
      if (f.origin.kind === "human" || f.validTo !== undefined || !f.object) continue;
      const org = await store.resolveEntity(f.object.entityId);
      if (!org || !namesOrganization(value.leaving, org)) continue;
      // Ending a job is itself knowledge that arrived with this event, so it is
      // returned as a superseding fact for the host to record (with the event's
      // knownAt) rather than edited in place. "What did we know on Aug 20" then
      // keeps the old edge until the farewell mail was actually received.
      const { id, recordedAt, retractedAt, knownAt, knownUntil, ...rest } = f;
      void id; void recordedAt; void retractedAt; void knownAt; void knownUntil;
      ended.push({
        ...rest,
        validTo: at,
        supersedes: f.id,
        provenance: [...f.provenance, ...provenance],
        origin: { ...RULE_ORIGIN },
        confidence: Math.min(f.confidence, 0.8),
      });
    }
  }
  if (!value.joining) return { ended };
  const joining =
    (await findOrganization(store, tenantId, value.joining)) ??
    (await store.createEntity({ tenantId, kind: "organization", name: value.joining, identifiers: [], status: "proposed" }));
  const pair = { ...mine, objectId: joining.id };
  if ((await store.queryFacts({ ...pair, validAt: at })).length > 0) return { joining, ended };
  const later = (await store.queryFacts(pair)).find((f) => f.validFrom > at);
  if (later?.origin.kind === "human") return { joining, ended };
  const worksAt: NewFact = {
    type: "relationship",
    subject: person,
    object: { entityId: joining.id, name: joining.name },
    predicate: "works_at",
    value: { domain: joining.identifiers.find((i) => i.type === "domain")?.value },
    statement: `${person.name ?? "They"} works at ${joining.name}.`,
    validFrom: at,
    provenance: [...provenance, ...(later?.provenance ?? [])],
    confidence: WORKS_AT_CONFIDENCE,
    origin: RULE_ORIGIN,
    ...(later ? { supersedes: later.id } : {}),
  };
  return { joining, worksAt, ended };
}

/**
 * `resolve:job-change`: a rule that records a `job_change` signal for the
 * sender. `validFrom` is the message date, not the import time, so a message
 * delivered late still says when the change happened.
 *
 * With a store it also moves the employment edge (#18): the `works_at` to the
 * organization being left ends at the message date, and a `works_at` to the
 * one being joined starts then. Without one (unit tests) it only records the
 * signal.
 */
export function jobChangeExtractor(store?: Store): Extractor {
  return {
    name: "resolve:job-change",
    version: "1",
    applies: (event: SourceEvent) => JOB_CHANGE_TRIGGER.test(event.content.text),
    async extract(event, ctx): Promise<NewFact[]> {
      const parsed = parseJobChange(event.content.text);
      if (!parsed) return [];
      const fromId = event.participants.find((p) => p.role === "from")?.entityId;
      if (!fromId) return [];
      const sender: Entity | undefined = ctx.participants.find((e) => e.id === fromId);
      if (!sender) return [];
      const value: JobChangeValue = { ...parsed.value };
      if (!value.leaving) {
        const employer = currentEmployer(ctx.knownFacts, sender.id);
        if (employer) value.leaving = employer;
      }
      const subject: EntityRef = { entityId: sender.id, name: sender.name };
      const provenance: NewFact["provenance"] = [
        {
          eventId: event.id,
          speaker: subject,
          quote: parsed.quote.text,
          span: { start: parsed.quote.start, end: parsed.quote.end },
        },
      ];
      const moved = store ? await moveEmployer(store, ctx.tenantId, subject, value, event, provenance) : { ended: [] };
      const parts = [value.leaving && `leaving ${value.leaving}`, value.joining && `joining ${value.joining}`].filter(Boolean);
      const fact: NewFact<JobChangeValue> = {
        type: "signal",
        subject,
        // The organization joined, so attention can tell the new employer from the stale one.
        ...(moved.joining ? { object: { entityId: moved.joining.id, name: moved.joining.name } } : {}),
        predicate: "job_change",
        value,
        statement: `${sender.name} is changing jobs${parts.length ? `: ${parts.join(", ")}` : ""}.`,
        validFrom: event.occurredAt,
        provenance,
        confidence: 0.7,
        origin: RULE_ORIGIN,
      };
      return [fact, ...moved.ended, ...(moved.worksAt ? [moved.worksAt] : [])];
    },
  };
}
