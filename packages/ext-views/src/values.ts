import type { Entity, EntityRef, Fact, SourceEvent, Store, TenantConfig, ViewDefinition } from "@yrm/core";
import { PREDICATE_PREFIX, VIEWS, predicateOf, viewNameOf } from "./definitions.ts";

/**
 * Reading view values back. A view's current value for an entity is the
 * attribute fact `view.<name>` about it that is valid and believed now. Human
 * origin wins; among the rest, the highest confidence, then the latest.
 */
export function pickCurrent(facts: Fact[]): Fact | undefined {
  const rank = (f: Fact): number => (f.origin.kind === "human" ? 2 : 1);
  return [...facts].sort((a, b) => rank(b) - rank(a) || b.confidence - a.confidence || b.recordedAt.localeCompare(a.recordedAt))[0];
}

export async function currentValue(store: Store, tenantId: string, entityId: string, name: string, at?: string): Promise<Fact | undefined> {
  const q = { tenantId, subjectId: entityId, predicate: predicateOf(name), type: "attribute" as const };
  return pickCurrent(await store.queryFacts(at ? { ...q, validAt: at, asOf: at } : q));
}

/** Every current view fact about an entity, keyed by view name, including views no longer defined. */
export async function currentValues(store: Store, tenantId: string, entityId: string, at?: string): Promise<Map<string, Fact>> {
  const q = { tenantId, subjectId: entityId, type: "attribute" as const };
  const facts = (await store.queryFacts(at ? { ...q, validAt: at, asOf: at } : q)).filter((f) => f.predicate.startsWith(PREDICATE_PREFIX));
  const byName = new Map<string, Fact[]>();
  for (const f of facts) {
    const name = viewNameOf(f.predicate)!;
    byName.set(name, [...(byName.get(name) ?? []), f]);
  }
  const out = new Map<string, Fact>();
  for (const [name, list] of byName) {
    const cur = pickCurrent(list);
    if (cur) out.set(name, cur);
  }
  return out;
}

/** How a value reads in a table or a sentence. */
export function displayValue(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (typeof v["name"] === "string") return v["name"];
    if (typeof v["entityId"] === "string") return v["entityId"];
  }
  if (typeof value === "string") return value;
  return JSON.stringify(value);
}

export function sameValue(a: unknown, b: unknown): boolean {
  const key = (v: unknown): string => {
    if (typeof v === "object" && v !== null && typeof (v as { entityId?: unknown }).entityId === "string") return `entity:${(v as { entityId: string }).entityId}`;
    return JSON.stringify(v);
  };
  return key(a) === key(b);
}

export function statementFor(def: Pick<ViewDefinition, "name">, entity: Pick<Entity, "name">, value: unknown): string {
  return `${def.name} for ${entity.name}: ${displayValue(value)}.`;
}

// ---- value validation ---------------------------------------------------------------

export type Checked = { ok: true; value: unknown; object?: EntityRef } | { ok: false; reason: string };

/** Entities a model may name for an `entity` view. */
export type EntityLookup = (raw: string) => Promise<Entity | undefined>;

/**
 * Coerce a raw value to the view's type. Used for model answers and for
 * `view set`; the same rules apply to both so a human can never store what a
 * model could not.
 */
export async function checkValue(def: ViewDefinition, raw: unknown, lookup: EntityLookup): Promise<Checked> {
  if (raw === null || raw === undefined || (typeof raw === "string" && raw.trim() === "")) return { ok: false, reason: "no value" };
  switch (def.valueType) {
    case "string": {
      const s = (typeof raw === "string" ? raw : JSON.stringify(raw)).trim().replace(/\s+/g, " ");
      return { ok: true, value: s.length > 500 ? `${s.slice(0, 499)}…` : s };
    }
    case "number": {
      const n = typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw.trim()) : Number.NaN;
      return Number.isFinite(n) ? { ok: true, value: n } : { ok: false, reason: `"${String(raw)}" is not a number` };
    }
    case "boolean": {
      if (typeof raw === "boolean") return { ok: true, value: raw };
      const s = String(raw).trim().toLowerCase();
      if (["true", "yes", "y", "1"].includes(s)) return { ok: true, value: true };
      if (["false", "no", "n", "0"].includes(s)) return { ok: true, value: false };
      return { ok: false, reason: `"${String(raw)}" is not true or false` };
    }
    case "date": {
      const t = typeof raw === "string" || typeof raw === "number" ? Date.parse(String(raw)) : Number.NaN;
      return Number.isNaN(t) ? { ok: false, reason: `"${String(raw)}" is not a date` } : { ok: true, value: new Date(t).toISOString().slice(0, 10) };
    }
    case "enum": {
      const s = String(raw).trim().toLowerCase();
      const hit = (def.enumValues ?? []).find((v) => v.toLowerCase() === s);
      return hit ? { ok: true, value: hit } : { ok: false, reason: `"${String(raw)}" is not one of ${(def.enumValues ?? []).join(", ")}` };
    }
    case "entity": {
      const s = typeof raw === "object" && raw !== null ? String((raw as Record<string, unknown>)["entityId"] ?? (raw as Record<string, unknown>)["name"] ?? "") : String(raw);
      const e = s.trim() ? await lookup(s.trim()) : undefined;
      if (!e) return { ok: false, reason: `"${s}" does not match a known entity` };
      const ref = { entityId: e.id, name: e.name };
      return { ok: true, value: ref, object: ref };
    }
    case "json":
      return { ok: true, value: raw };
  }
}

/**
 * Find an entity by id, identifier or name among `candidates` first (the
 * people the model was shown), then the whole tenant. Ambiguous names fail.
 */
export function entityLookup(store: Store, tenantId: string, candidates: Entity[] = []): EntityLookup {
  return async (raw) => {
    const q = raw.trim();
    const lower = q.toLowerCase();
    const live = (e: Entity): boolean => e.status !== "rejected" && e.status !== "merged";
    const inList = (list: Entity[]): Entity | undefined => {
      const byId = list.find((e) => e.id === q);
      if (byId) return byId;
      const byIdent = list.filter((e) => e.identifiers.some((i) => i.value === lower));
      if (byIdent.length === 1) return byIdent[0];
      const exact = list.filter((e) => e.name.toLowerCase() === lower);
      if (exact.length === 1) return exact[0];
      const partial = list.filter((e) => e.name.toLowerCase().includes(lower) || lower.includes(e.name.toLowerCase()));
      return partial.length === 1 ? partial[0] : undefined;
    };
    const fromCandidates = inList(candidates.filter(live));
    if (fromCandidates) return fromCandidates;
    const byId = await store.resolveEntity(q);
    if (byId && byId.tenantId === tenantId && live(byId)) return byId;
    const found = new Map<string, Entity>();
    for (const e of await store.findEntities({ tenantId, identifier: { value: lower } })) found.set(e.id, e);
    for (const e of await store.findEntities({ tenantId, nameLike: q, limit: 20 })) found.set(e.id, e);
    return inList([...found.values()].filter(live));
  };
}

// ---- entity scope -------------------------------------------------------------------

/** People whose organization is this entity, for org-level views. */
export async function membersOf(store: Store, tenantId: string, entity: Entity): Promise<Entity[]> {
  if (entity.kind !== "organization") return [];
  return (await store.findEntities({ tenantId, parentId: entity.id })).filter((p) => p.status !== "merged" && p.status !== "rejected");
}

/** Events involving the entity, and for an organization its people, newest first. */
export async function eventsAbout(store: Store, tenantId: string, entity: Entity, members: Entity[]): Promise<SourceEvent[]> {
  const byId = new Map<string, SourceEvent>();
  for (const who of [entity, ...members]) {
    for (const e of await store.listEvents({ tenantId, entityId: who.id })) byId.set(e.id, e);
  }
  return [...byId.values()].sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id));
}

/** The tenant's own people and organization: views describe counterparties, not us. */
export function isSelf(entity: Entity, tenant: Pick<TenantConfig, "selfAddresses" | "selfDomains">): boolean {
  const addresses = new Set(tenant.selfAddresses.map((a) => a.toLowerCase()));
  const domains = new Set((tenant.selfDomains ?? []).map((d) => d.toLowerCase()));
  return entity.identifiers.some((i) => {
    const v = i.value.toLowerCase();
    if (i.type === "email") return addresses.has(v) || domains.has(v.slice(v.lastIndexOf("@") + 1));
    if (i.type === "domain") return domains.has(v);
    return false;
  });
}

// ---- per-entity status --------------------------------------------------------------

/** Why a view has no value (or the last outcome), so `view show` can say. Kept in kv, never in model context. */
export interface ViewStatus {
  state: "recorded" | "unchanged" | "no_value" | "rejected" | "unavailable" | "held_by_human";
  reason: string;
  at: string;
}

const statusKey = (entityId: string, name: string): string => `status:${entityId}:${name}`;

export async function setStatus(store: Store, entityId: string, name: string, status: Omit<ViewStatus, "at">): Promise<void> {
  await store.kvSet<ViewStatus>(VIEWS, statusKey(entityId, name), { ...status, at: new Date().toISOString() });
}

export async function getStatus(store: Store, entityId: string, name: string): Promise<ViewStatus | null> {
  return store.kvGet<ViewStatus>(VIEWS, statusKey(entityId, name));
}
