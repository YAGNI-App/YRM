import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Entity, EntityRef, Fact, NewSourceEvent, Participant } from "@yrm/core";
import type { Harness } from "./helpers.ts";

/**
 * Seed a store from fixtures/acme/ground-truth.json as if extraction had been
 * perfect: entities from `people`/`organizations`, one event per source file
 * (mail headers, ICS VEVENTs, note frontmatter; bodies are not read), and the
 * `facts` mapped to fact shapes. Resolved asks and commitments are recorded
 * open first and then superseded at the resolving event, the way the
 * extractor will do it, with the store clock moved to match.
 */
export const ACME = join(import.meta.dir, "../../../fixtures/acme");

interface GtFact {
  id: string;
  type: string;
  predicate?: string;
  subject: string;
  object?: string;
  statement: string;
  evidence: string[];
  dueAt?: string;
  status?: string;
  resolvedBy?: string;
  answered?: boolean;
  answeredBy?: string;
  severity?: string;
  resolved?: boolean;
  validFrom?: string;
  validTo?: string;
  knownAt?: string;
}

export const groundTruth = JSON.parse(readFileSync(join(ACME, "ground-truth.json"), "utf8")) as {
  tenant: { selfAddresses: string[]; selfDomains: string[] };
  noise: string[];
  organizations: Array<{ domain: string; name: string }>;
  people: Array<{ key: string; name: string; addresses: string[]; organizations: Array<{ domain: string; validTo?: string }> }>;
  facts: GtFact[];
  expectedQueueOn: Record<string, Array<{ kind: string; fact: string; about: string }>>;
};

const unfold = (s: string): string => s.replace(/\r?\n[ \t]/g, "");
const emails = (s = ""): string[] => [...s.matchAll(/[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g)].map((m) => m[0].toLowerCase());
const icsTime = (t: string): string => t.replace(/^(\d{4})(\d\d)(\d\d)T(\d\d)(\d\d)(\d\d)Z$/, "$1-$2-$3T$4:$5:$6Z");

function sourceEvents(): Array<NewSourceEvent & { roles: Array<[string, string]> }> {
  const out: Array<NewSourceEvent & { roles: Array<[string, string]> }> = [];
  const base = { participants: [] as Participant[], meta: {} as Record<string, unknown> };
  for (const file of readdirSync(join(ACME, "mail")).filter((f) => f.endsWith(".eml")).sort()) {
    const head = unfold(readFileSync(join(ACME, "mail", file), "utf8").split(/\r?\n\r?\n/)[0]!);
    const h = Object.fromEntries(head.split(/\r?\n/).map((l) => [l.slice(0, l.indexOf(":")).toLowerCase(), l.slice(l.indexOf(":") + 1).trim()]));
    if (groundTruth.noise.includes(h["message-id"]!)) continue;
    const roles: Array<[string, string]> = [
      ...emails(h.from).map((a): [string, string] => ["from", a]),
      ...emails(h.to).map((a): [string, string] => ["to", a]),
      ...emails(h.cc).map((a): [string, string] => ["cc", a]),
    ];
    out.push({ ...base, source: "mail", kind: "message", externalId: h["message-id"]!, occurredAt: new Date(h.date!).toISOString(), content: { text: "", title: h.subject! }, roles });
  }
  for (const block of unfold(readFileSync(join(ACME, "calendar/acme.ics"), "utf8")).split("BEGIN:VEVENT").slice(1)) {
    const prop = (name: string): string => block.match(new RegExp(`^${name}(?:;[^:\\r\\n]*)?:(.*)$`, "m"))?.[1]?.trim() ?? "";
    const start = icsTime(prop("DTSTART"));
    const roles = [...block.matchAll(/^(ORGANIZER|ATTENDEE).*mailto:(.+)$/gm)].map((m): [string, string] => [m[1] === "ORGANIZER" ? "organizer" : "attendee", m[2]!.trim().toLowerCase()]);
    const meta = { start, end: icsTime(prop("DTEND")), cancelled: prop("STATUS") === "CANCELLED" };
    out.push({ ...base, source: "calendar", kind: "meeting", externalId: prop("UID"), occurredAt: start, content: { text: "", title: prop("SUMMARY") }, meta, roles });
  }
  for (const file of readdirSync(join(ACME, "notes")).sort()) {
    const front = readFileSync(join(ACME, "notes", file), "utf8").split("---")[1]!;
    const title = front.match(/^title: (.*)$/m)![1]!;
    const roles = emails(front.split("event:")[0]).map((a): [string, string] => ["mentioned", a]);
    out.push({ ...base, source: "notes", kind: "note", externalId: `notes/${file}`, occurredAt: `${front.match(/^date: (.*)$/m)![1]}T21:00:00Z`, content: { text: "", title }, roles });
  }
  return out;
}

export async function seedAcme(h: Harness): Promise<{ entities: Map<string, Entity>; facts: Map<string, Fact> }> {
  const entities = new Map<string, Entity>();
  for (const o of groundTruth.organizations) entities.set(o.domain, await h.org(o.name, o.domain));
  const byAddress = new Map<string, Entity>();
  for (const p of groundTruth.people) {
    const current = p.organizations.find((o) => !o.validTo) ?? p.organizations.at(-1)!;
    const e = await h.store.createEntity({
      tenantId: "local",
      kind: "person",
      name: p.name,
      status: "confirmed",
      identifiers: p.addresses.map((value) => ({ type: "email", value, confidence: 1, source: "fixture" })),
      summary: { parentId: entities.get(current.domain)!.id },
    });
    entities.set(p.key, e);
    for (const a of p.addresses) byAddress.set(a, e);
  }

  const events = new Map<string, { id: string; at: string }>();
  for (const { roles, ...ev } of sourceEvents()) {
    const participants = roles.map(([role, address]): Participant => {
      const e = byAddress.get(address);
      return { role, address, ...(e ? { entityId: e.id, name: e.name } : {}), ...(groundTruth.tenant.selfAddresses.includes(address) ? { self: true } : {}) };
    });
    h.setClock(ev.occurredAt);
    const { event } = await h.store.appendEvent({ ...ev, tenantId: "local", participants });
    events.set(ev.externalId, { id: event.id, at: event.occurredAt });
  }

  const r = (key: string): EntityRef => ({ entityId: entities.get(key)!.id, name: entities.get(key)!.name });
  const facts = new Map<string, Fact>();
  for (const g of groundTruth.facts) {
    const evidence = g.evidence.map((x) => events.get(x)!).sort((a, b) => a.at.localeCompare(b.at));
    const subject = r(g.subject);
    const object = g.object ? r(g.object) : undefined;
    const what = g.statement;
    let value: Record<string, unknown> = {};
    if (g.type === "commitment") value = { what, owedBy: subject, owedTo: object, dueAt: g.dueAt, status: "open" };
    if (g.type === "ask") value = { what, askedBy: subject, askedOf: object, answered: false };
    if (g.type === "objection") value = { what, raisedBy: subject, severity: g.severity, resolved: g.resolved ?? false };
    if (g.type === "decision") value = { what, decidedBy: subject };
    if (g.type === "role") value = { role: g.predicate };
    if (g.predicate === "job_change") value = { leaving: r("acme-robotics.example"), joining: object };
    const predicate = g.predicate ?? { commitment: "committed_to", ask: "asked", objection: "objected", decision: "decided" }[g.type] ?? g.type;
    const validFrom = g.validFrom ?? evidence[0]!.at;
    h.setClock(g.knownAt ?? evidence[0]!.at);
    let fact: Fact = await h.store.recordFact({
      tenantId: "local",
      type: g.type,
      subject,
      ...(object ? { object } : {}),
      predicate,
      value,
      statement: g.statement,
      validFrom,
      ...(g.validTo ? { validTo: g.validTo } : {}),
      provenance: evidence.map((e) => ({ eventId: e.id })),
      confidence: 0.9,
      origin: { kind: "rule", by: "ground-truth", version: "1" },
    });
    const closedBy = g.resolvedBy ?? g.answeredBy;
    if (closedBy) {
      const closing = events.get(closedBy)!;
      const closed = g.type === "ask" ? { ...value, answered: true, answeredBy: closing.id } : { ...value, status: g.status, resolvedBy: closing.id };
      h.setClock(closing.at);
      fact = await h.store.recordFact({ ...fact, value: closed, validFrom: closing.at, supersedes: fact.id, provenance: [...fact.provenance, { eventId: closing.id }] });
    }
    facts.set(g.id, fact);
  }
  return { entities, facts };
}
