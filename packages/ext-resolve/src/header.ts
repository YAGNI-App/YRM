import type { Entity, FactOrigin, Identifier, Logger, Resolver, SourceEvent, Store } from "@yrm/core";
import { indexName } from "./names.ts";
import {
  baseAddress,
  displayNameFromHeader,
  domainOf,
  isFreemail,
  nameFromLocalPart,
  normalizeAddress,
  orgNameFromDomain,
} from "./normalize.ts";
import type { ResolveSettings } from "./settings.ts";

export const NAMESPACE = "resolve";
export const RULE_VERSION = "1";
export const RULE_ORIGIN: FactOrigin = { kind: "rule", by: "resolve", version: RULE_VERSION };
export const WORKS_AT_CONFIDENCE = 0.8;

export interface Scope {
  store: Store;
  tenantId: string;
  log: Logger;
  settings: ResolveSettings;
}

function earlier(a: string | undefined, b: string): string {
  return a === undefined || b < a ? b : a;
}
function later(a: string | undefined, b: string): string {
  return a === undefined || b > a ? b : a;
}

/** Add or widen the seen-window of an identifier. Returns true when anything changed. */
export function touchIdentifier(ids: Identifier[], type: string, value: string, at: string): boolean {
  const found = ids.find((i) => i.type === type && i.value === value);
  if (!found) {
    ids.push({ type, value, confidence: 1, source: NAMESPACE, firstSeen: at, lastSeen: at });
    return true;
  }
  const firstSeen = earlier(found.firstSeen, at);
  const lastSeen = later(found.lastSeen, at);
  if (firstSeen === found.firstSeen && lastSeen === found.lastSeen) return false;
  found.firstSeen = firstSeen;
  found.lastSeen = lastSeen;
  return true;
}

async function findByIdentifier(s: Scope, kind: string, type: string, value: string): Promise<Entity | undefined> {
  const found = await s.store.findEntities({ tenantId: s.tenantId, kind, identifier: { type, value } });
  return found.find((e) => e.status !== "merged");
}

/** Find the person behind an address, or propose one. Plus-tags match their base mailbox. */
export async function findOrCreatePerson(s: Scope, address: string, headerName: string | undefined, at: string): Promise<Entity> {
  const base = baseAddress(address);
  const values = base === address ? [base] : [base, address];
  let person: Entity | undefined;
  for (const v of values) {
    person = await findByIdentifier(s, "person", "email", v);
    if (person) break;
  }

  if (!person) {
    const identifiers: Identifier[] = [];
    for (const v of values) touchIdentifier(identifiers, "email", v, at);
    const created = await s.store.createEntity({
      tenantId: s.tenantId,
      kind: "person",
      name: displayNameFromHeader(headerName, base),
      identifiers,
      status: "proposed",
    });
    await indexName(s, created);
    return created;
  }

  const identifiers = person.identifiers.map((i) => ({ ...i }));
  let changed = false;
  for (const v of values) changed = touchIdentifier(identifiers, "email", v, at) || changed;
  const patch: Partial<Entity> = {};
  if (changed) patch.identifiers = identifiers;
  // A proposal named after its mailbox gets a real name once a header supplies one.
  if (person.status === "proposed" && headerName && person.name === nameFromLocalPart(base)) {
    const better = displayNameFromHeader(headerName, base);
    if (better !== person.name) patch.name = better;
  }
  if (Object.keys(patch).length === 0) return person;
  const updated = await s.store.updateEntity(person.id, patch);
  if (patch.name !== undefined) await indexName(s, updated);
  return updated;
}

async function findOrCreateOrg(s: Scope, domain: string, at: string, name?: string, status: Entity["status"] = "proposed"): Promise<Entity> {
  const found = await findByIdentifier(s, "organization", "domain", domain);
  if (found) {
    const identifiers = found.identifiers.map((i) => ({ ...i }));
    return touchIdentifier(identifiers, "domain", domain, at) ? s.store.updateEntity(found.id, { identifiers }) : found;
  }
  const identifiers: Identifier[] = [];
  touchIdentifier(identifiers, "domain", domain, at);
  return s.store.createEntity({
    tenantId: s.tenantId,
    kind: "organization",
    name: name ?? orgNameFromDomain(domain),
    identifiers,
    status,
  });
}

const selfOrgKey = (tenantId: string): string => `self-org:${tenantId}`;

/**
 * The tenant's own organization. Self domains never get an ordinary proposed
 * organization; they all point at this one, confirmed because config says so.
 */
async function selfOrg(s: Scope, domain: string | undefined, at: string): Promise<Entity | null> {
  const usable = domain !== undefined && !isFreemail(domain, s.settings.freemailDomains) ? domain : undefined;
  // Only an explicit selfDomains list is authoritative; without one, any non-freemail self domain counts.
  const ownDomain = usable !== undefined && (s.settings.selfDomains.length === 0 || s.settings.selfDomains.includes(usable));
  const knownId = await s.store.kvGet<string>(NAMESPACE, selfOrgKey(s.tenantId));
  const known = knownId ? await s.store.resolveEntity(knownId) : null;
  if (known) {
    if (!ownDomain || usable === undefined) return known;
    const identifiers = known.identifiers.map((i) => ({ ...i }));
    return touchIdentifier(identifiers, "domain", usable, at) ? s.store.updateEntity(known.id, { identifiers }) : known;
  }
  const primary = s.settings.selfDomains[0] ?? (ownDomain ? usable : undefined);
  if (primary === undefined) return null;
  const org = await findOrCreateOrg(s, primary, at, s.settings.selfOrgName ?? orgNameFromDomain(primary), "confirmed");
  await s.store.kvSet(NAMESPACE, selfOrgKey(s.tenantId), org.id);
  return org;
}

/**
 * One `works_at` per person and organization, starting at the earliest message
 * that shows it. A later-starting rule fact is superseded rather than duplicated,
 * so out-of-order imports still converge on the first message date.
 */
export async function ensureWorksAt(s: Scope, person: Entity, org: Entity, event: SourceEvent): Promise<void> {
  const at = event.occurredAt;
  const pair = { tenantId: s.tenantId, subjectId: person.id, predicate: "works_at", objectId: org.id };
  if ((await s.store.queryFacts({ ...pair, validAt: at })).length > 0) return;
  const current = await s.store.queryFacts(pair);
  const startsLater = current.find((f) => f.validFrom > at);
  if (current.length > 0 && !startsLater) return;
  if (startsLater?.origin.kind === "human") return;
  await s.store.recordFact({
    tenantId: s.tenantId,
    type: "relationship",
    subject: { entityId: person.id, name: person.name },
    object: { entityId: org.id, name: org.name },
    predicate: "works_at",
    value: { domain: org.identifiers.find((i) => i.type === "domain")?.value },
    statement: `${person.name} works at ${org.name}.`,
    validFrom: at,
    provenance: [{ eventId: event.id }, ...(startsLater?.provenance ?? [])],
    confidence: WORKS_AT_CONFIDENCE,
    origin: RULE_ORIGIN,
    ...(startsLater ? { supersedes: startsLater.id } : {}),
  });
}

async function linkOrganization(s: Scope, person: Entity, address: string, self: boolean, event: SourceEvent): Promise<void> {
  const domain = domainOf(address);
  let org: Entity | null = null;
  if (self || (domain !== undefined && s.settings.selfDomains.includes(domain))) {
    org = await selfOrg(s, domain, event.occurredAt);
  } else if (domain !== undefined && !isFreemail(domain, s.settings.freemailDomains)) {
    org = await findOrCreateOrg(s, domain, event.occurredAt);
  }
  if (!org) return;
  if (!person.summary?.parentId) {
    person = await s.store.updateEntity(person.id, { summary: { ...person.summary, parentId: org.id } });
  }
  await ensureWorksAt(s, person, org, event);
}

/**
 * Priority 0: address → person, domain → organization. Deterministic and free.
 * The host only hands us participants nobody has resolved yet.
 */
export function headerResolver(settings: ResolveSettings): Resolver {
  return {
    name: "header-resolver",
    priority: 0,
    async resolve(event, ctx) {
      const s: Scope = { store: ctx.store, tenantId: ctx.tenantId, log: ctx.log, settings };
      const out: Array<{ index: number; entityId: string }> = [];
      for (const [index, p] of event.participants.entries()) {
        if (p.entityId !== undefined || !p.address) continue;
        const address = normalizeAddress(p.address);
        if (!address.includes("@")) continue;
        const person = await findOrCreatePerson(s, address, p.name, event.occurredAt);
        out.push({ index, entityId: person.id });
        await linkOrganization(s, person, address, p.self === true, event);
      }
      return out;
    },
  };
}
