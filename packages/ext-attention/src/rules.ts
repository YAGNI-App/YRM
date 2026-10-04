import type { EntityRef, Fact, QueueItem, Ranker } from "@yrm/core";
import type { AttentionSettings } from "./settings.ts";
import {
  asCommitment,
  clamp01,
  clip,
  daysBetween,
  eventIdsOf,
  localDate,
  partiesOf,
  refFrom,
  Snapshot,
  type QueueAbout,
} from "./snapshot.ts";

/**
 * Rule rankers. Each one reads facts as of the end of `today`, appends its own
 * candidates and never touches anyone else's. All of them are free: no model
 * calls, a handful of indexed store queries each.
 */

export type Rule = (snap: Snapshot) => Promise<QueueItem[]>;

const WHAT_MAX = 80;

function plural(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function openPhrase(n: number): string {
  return n === 1 ? "1 ask, commitment or objection" : `${n} asks, commitments or objections`;
}

function item(
  rule: string,
  id: string,
  fields: Omit<QueueItem, "key" | "by" | "about" | "evidence"> & { about: QueueAbout[]; facts: Fact[]; eventIds?: string[] },
): QueueItem {
  const { facts, eventIds, about, dueAt, ...rest } = fields;
  const out: QueueItem = {
    key: `${rule}:${id}`,
    by: `attention/${rule}`,
    ...rest,
    score: clamp01(rest.score),
    about,
    evidence: {
      factIds: [...new Set(facts.map((f) => f.id))],
      eventIds: [...new Set([...eventIdsOf(facts), ...(eventIds ?? [])])],
    },
  };
  if (dueAt !== undefined) out.dueAt = dueAt;
  return out;
}

// 1. Someone asked you something and you have not answered.
export const unansweredAsk: Rule = async (snap) => {
  const self = await snap.selfIds();
  const roleHolders = new Set((await snap.facts("role")).map((f) => f.subject.entityId));
  const out: QueueItem[] = [];
  for (const ask of await snap.openAsks()) {
    if (!ask.askedOf || !self.has(ask.askedOf.entityId)) continue;
    const since = localDate(ask.fact.validFrom, snap.tz);
    const age = daysBetween(since, snap.today);
    if (age < snap.settings.askMinDays) continue;
    const asker = await snap.name(ask.askedBy);
    const title = await snap.titleOf(ask.fact);
    const hasRole = ask.askedBy !== undefined && roleHolders.has(ask.askedBy.entityId);
    out.push(
      item("unanswered-ask", ask.fact.id, {
        action: `Reply to ${asker} about: ${clip(ask.value.what, WHAT_MAX)}`,
        reason: `Asked ${plural(age, "day")} ago${title ? ` in '${title}'` : ""}; no reply from you since.`,
        score: 0.5 + Math.min(age / 14, 0.4) + (hasRole ? 0.1 : 0),
        about: await snap.about(ask.askedBy),
        facts: [ask.fact],
      }),
    );
  }
  return out;
};

// 2. A commitment is past its due date and still open.
export const overdueCommitment: Rule = async (snap) => {
  const self = await snap.selfIds();
  const out: QueueItem[] = [];
  for (const c of await snap.openCommitments()) {
    if (!c.value.dueAt) continue;
    const due = localDate(c.value.dueAt, snap.tz);
    const late = daysBetween(due, snap.today);
    if (late <= 0) continue;
    const mine = c.owedBy !== undefined && self.has(c.owedBy.entityId);
    const what = clip(c.value.what, WHAT_MAX);
    const owedTo = await snap.name(c.owedTo);
    const owedBy = await snap.name(c.owedBy);
    out.push(
      item("overdue-commitment", c.fact.id, {
        action: mine ? `Deliver to ${owedTo}: ${what}` : `Follow up with ${owedBy} on: ${what}`,
        reason: mine
          ? `You promised this to ${owedTo}; it was due ${due} and is ${plural(late, "day")} late with no delivery recorded.`
          : `${owedBy} promised this by ${due}; it is ${plural(late, "day")} late with no delivery recorded.`,
        score: mine ? 0.6 + Math.min(late / 7, 0.35) : 0.4 + Math.min(late / 14, 0.3),
        about: await snap.about(mine ? c.owedTo : c.owedBy, mine ? c.owedBy : c.owedTo),
        facts: [c.fact],
        dueAt: due,
      }),
    );
  }
  return out;
};

// 3. A commitment comes due in the next few days.
export const dueSoon: Rule = async (snap) => {
  const self = await snap.selfIds();
  const out: QueueItem[] = [];
  for (const c of await snap.openCommitments()) {
    if (!c.value.dueAt) continue;
    const due = localDate(c.value.dueAt, snap.tz);
    const until = daysBetween(snap.today, due);
    if (until < 0 || until > snap.settings.dueSoonDays) continue;
    const mine = c.owedBy !== undefined && self.has(c.owedBy.entityId);
    const what = clip(c.value.what, WHAT_MAX);
    const when = until === 0 ? "today" : until === 1 ? "tomorrow" : `in ${until} days`;
    out.push(
      item("due-soon", c.fact.id, {
        action: mine ? `Deliver to ${await snap.name(c.owedTo)} by ${due}: ${what}` : `Check in with ${await snap.name(c.owedBy)} on: ${what}`,
        reason: `${mine ? "Your" : `${await snap.name(c.owedBy)}'s`} commitment is due ${when} (${due}) and is still open.`,
        score: 0.35 + (snap.settings.dueSoonDays - until) / 10,
        about: await snap.about(mine ? c.owedTo : c.owedBy, mine ? c.owedBy : c.owedTo),
        facts: [c.fact],
        dueAt: due,
      }),
    );
  }
  return out;
};

// 4. A commitment was broken recently; expectations need resetting.
export const brokenCommitment: Rule = async (snap) => {
  const self = await snap.selfIds();
  const out: QueueItem[] = [];
  for (const f of await snap.facts("commitment")) {
    const c = asCommitment(f);
    if (!c || c.value.status !== "broken") continue;
    // The broken-status fact's valid time is when it broke. A backfill records
    // everything at once, so transaction time would resurface year-old misses.
    const broke = localDate(f.validFrom, snap.tz);
    const ago = daysBetween(broke, snap.today);
    if (ago < 0 || ago > snap.settings.brokenWithinDays) continue;
    const mine = c.owedBy !== undefined && self.has(c.owedBy.entityId);
    const what = clip(c.value.what, WHAT_MAX);
    const owedBy = await snap.name(c.owedBy);
    const due = c.value.dueAt ? ` due ${localDate(c.value.dueAt, snap.tz)}` : "";
    out.push(
      item("broken-commitment", f.id, {
        action: mine ? `Reset expectations with ${await snap.name(c.owedTo)} on: ${what}` : `Agree a new date with ${owedBy} on: ${what}`,
        reason: `${mine ? "Your" : `${owedBy}'s`} commitment${due} was recorded as broken on ${broke}.`,
        score: 0.5,
        about: await snap.about(c.owedTo, c.owedBy),
        facts: [f],
        ...(c.value.resolvedBy ? { eventIds: [c.value.resolvedBy] } : {}),
      }),
    );
  }
  return out;
};

// 5. An organization with open items has stopped writing.
export const goneQuiet: Rule = async (snap) => {
  const { store, tenantId } = snap.ctx;
  const self = await snap.selfIds();
  const selfDomains = new Set(snap.settings.selfDomains);
  const open = await snap.openItems();
  const worksAt = await snap.facts("relationship", "works_at");
  const out: QueueItem[] = [];

  for (const org of await store.findEntities({ tenantId, kind: "organization", status: ["proposed", "confirmed"] })) {
    if (org.identifiers.some((i) => i.type === "domain" && selfDomains.has(i.value))) continue;
    const people = new Set((await store.findEntities({ tenantId, kind: "person", parentId: org.id })).map((p) => p.id));
    for (const f of worksAt) if (f.object?.entityId === org.id) people.add(f.subject.entityId);
    for (const id of self) people.delete(id);
    if (people.size === 0) continue;

    const items = open.filter((f) => {
      const parties = partiesOf(f);
      return parties.has(org.id) || [...people].some((p) => parties.has(p));
    });
    if (items.length === 0) continue;

    let last: { date: string; eventId?: string; personId: string } | undefined;
    for (const p of people) {
      const heard = await snap.lastHeardFrom(p);
      if (heard && (!last || heard.date > last.date)) last = { ...heard, personId: p };
    }
    if (!last) continue;
    const days = daysBetween(last.date, snap.today);
    if (days < snap.settings.quietDays) continue;

    const who = await snap.name({ entityId: last.personId });
    out.push(
      item("gone-quiet", org.id, {
        action: `Re-engage ${org.name}: quiet for ${days} days with ${plural(items.length, "open item")}`,
        reason: `Nobody at ${org.name} has written or met with you since ${who} on ${last.date}, and ${openPhrase(items.length)} involving them ${items.length === 1 ? "is" : "are"} still open.`,
        score: 0.3 + Math.min((days - snap.settings.quietDays) / 30, 0.4),
        about: await snap.about({ entityId: org.id, name: org.name }, { entityId: last.personId }),
        facts: items,
        ...(last.eventId ? { eventIds: [last.eventId] } : {}),
      }),
    );
  }
  return out;
};

// 6. An objection is still standing.
export const openObjection: Rule = async (snap) => {
  const out: QueueItem[] = [];
  for (const o of await snap.openObjections()) {
    // An objection with no severity is still an objection; treat it as medium.
    const severity = o.value.severity ?? "medium";
    if (severity === "low") continue;
    const raisedBy = await snap.name(o.raisedBy);
    out.push(
      item("open-objection", o.fact.id, {
        action: `Address ${raisedBy}'s concern: ${clip(o.value.what, WHAT_MAX)}`,
        reason: `${raisedBy} raised this ${severity}-severity objection on ${localDate(o.fact.validFrom, snap.tz)} and it is not marked resolved.`,
        score: severity === "high" ? 0.55 : 0.4,
        about: await snap.about(o.raisedBy),
        facts: [o.fact],
      }),
    );
  }
  return out;
};

// 7. A meeting is coming up with people who have open items.
export const meetingPrep: Rule = async (snap) => {
  const { store, tenantId } = snap.ctx;
  const self = await snap.selfIds();
  const open = await snap.openItems();
  const out: QueueItem[] = [];
  for (const e of await store.listEvents({ tenantId, kind: "meeting" })) {
    if (e.meta.cancelled === true) continue;
    const start = typeof e.meta.start === "string" ? e.meta.start : e.occurredAt;
    const day = localDate(start, snap.tz);
    const until = daysBetween(snap.today, day);
    if (until < 0 || until > snap.settings.meetingWithinDays) continue;

    const attendees: EntityRef[] = [];
    for (const p of e.participants) {
      if (!p.entityId || p.self || self.has(p.entityId) || attendees.some((a) => a.entityId === p.entityId)) continue;
      attendees.push(p.name ? { entityId: p.entityId, name: p.name } : { entityId: p.entityId });
    }
    const ids = new Set(attendees.map((a) => a.entityId));
    const items = open.filter((f) => [...partiesOf(f)].some((id) => ids.has(id)));
    if (items.length === 0) continue;

    const about = await snap.about(...attendees.filter((a) => items.some((f) => partiesOf(f).has(a.entityId))));
    const names = about.map((a) => a.name).join(", ");
    const title = e.content.title ?? "meeting";
    const when = until === 0 ? "today" : until === 1 ? "tomorrow" : `on ${day}`;
    out.push(
      item("meeting-prep", e.id, {
        action: `Prepare for '${title}' with ${names}: ${plural(items.length, "open item")}`,
        reason: `'${title}' starts ${when}; ${names} ${about.length === 1 ? "has" : "have"} ${openPhrase(items.length)} open, starting with: ${clip(items[0]!.statement, WHAT_MAX)}`,
        score: Math.min(0.45 + 0.05 * items.length, 0.7),
        about,
        facts: items,
        eventIds: [e.id],
        dueAt: start,
      }),
    );
  }
  return out;
};

// 8. Someone changed jobs and we still have them at the old company.
export const jobChange: Rule = async (snap) => {
  const worksAt = await snap.facts("relationship", "works_at");
  const out: QueueItem[] = [];
  for (const signal of await snap.facts("signal", "job_change")) {
    // Knowledge time on purpose: what matters is when we learned it, which
    // for imported mail is when it arrived, not when YRM indexed it.
    const learned = localDate(signal.knownAt ?? signal.recordedAt, snap.tz);
    const ago = daysBetween(learned, snap.today);
    if (ago < 0 || ago > snap.settings.jobChangeWithinDays) continue;
    const value = typeof signal.value === "object" && signal.value !== null ? (signal.value as Record<string, unknown>) : {};
    const leaving = refFrom(value.leaving);
    const joining = refFrom(value.joining) ?? signal.object;
    const person = signal.subject;
    const stale = worksAt.find(
      (f) =>
        f.subject.entityId === person.entityId &&
        f.object !== undefined &&
        f.object.entityId !== joining?.entityId &&
        (leaving === undefined || f.object.entityId === leaving.entityId),
    );
    if (!stale?.object) continue;
    const name = await snap.name(person);
    const org = await snap.name(stale.object);
    out.push(
      item("job-change", signal.id, {
        action: `Update ${name}'s organization and find a new contact at ${org}`,
        reason: `A job change for ${name} was learned on ${learned}${joining ? ` (now at ${await snap.name(joining)})` : ""}, but ${name} is still recorded as working at ${org}.`,
        score: 0.5,
        about: await snap.about(person, stale.object),
        facts: [signal, stale],
      }),
    );
  }
  return out;
};

export const RULES: ReadonlyArray<readonly [string, Rule]> = [
  ["unanswered-ask", unansweredAsk],
  ["overdue-commitment", overdueCommitment],
  ["due-soon", dueSoon],
  ["broken-commitment", brokenCommitment],
  ["gone-quiet", goneQuiet],
  ["open-objection", openObjection],
  ["meeting-prep", meetingPrep],
  ["job-change", jobChange],
];

export function ruleRanker(name: string, rule: Rule, settings: AttentionSettings): Ranker {
  return {
    name: `attention/${name}`,
    async rank(ctx, candidates) {
      return [...candidates, ...(await rule(new Snapshot(ctx, settings)))];
    },
  };
}

/** Run the enabled rules directly, outside the host's ranker chain (for `attention:explain`). */
export async function runRules(snap: Snapshot): Promise<QueueItem[]> {
  const out: QueueItem[] = [];
  for (const [name, rule] of RULES) if (!snap.settings.disable.includes(name)) out.push(...(await rule(snap)));
  return mergeItems(out);
}

/** Dedupe by key keeping the highest score, union `about` and evidence, sort by score descending. */
export function mergeItems(items: QueueItem[]): QueueItem[] {
  const byKey = new Map<string, QueueItem>();
  for (const it of items) {
    const prev = byKey.get(it.key);
    if (!prev) {
      byKey.set(it.key, { ...it, about: [...it.about], evidence: { factIds: [...it.evidence.factIds], eventIds: [...it.evidence.eventIds] } });
      continue;
    }
    const winner = it.score > prev.score ? { ...it } : prev;
    const about = [...prev.about];
    for (const a of it.about) {
      const existing = about.find((x) => x.entityId === a.entityId);
      if (!existing) about.push(a);
      else if (existing.name === undefined && a.name !== undefined) existing.name = a.name;
    }
    byKey.set(it.key, {
      ...winner,
      about,
      evidence: {
        factIds: [...new Set([...prev.evidence.factIds, ...it.evidence.factIds])],
        eventIds: [...new Set([...prev.evidence.eventIds, ...it.evidence.eventIds])],
      },
    });
  }
  return [...byKey.values()].sort((a, b) => b.score - a.score);
}

export const mergeRanker: Ranker = {
  name: "attention/merge",
  async rank(_ctx, candidates) {
    return mergeItems(candidates);
  },
};
