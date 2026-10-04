import { YrmError, type Entity, type Logger, type Store, type ViewDefinition } from "@yrm/core";

/** Extension name: `settings.views`, `origin.by: "views"`, kv namespace. */
export const VIEWS = "views";
/** Bumped when the population prompt or rule logic changes; recorded on every view fact. */
export const VIEWS_VERSION = "1";
/** Every view value is an attribute fact with this predicate prefix. */
export const PREDICATE_PREFIX = "view.";

export const VALUE_TYPES: ReadonlyArray<ViewDefinition["valueType"]> = ["string", "number", "boolean", "date", "enum", "entity", "json"];
/** Kinds `view define --for` accepts. The contract allows any kind; these are the ones that have data today. */
export const VIEW_KINDS = ["person", "organization", "deal"] as const;

const NAME_RE = /^[a-z][a-z0-9_]{0,62}$/;
const DESCRIPTION_MAX = 1000;

export const predicateOf = (name: string): string => `${PREDICATE_PREFIX}${name}`;
export const viewNameOf = (predicate: string): string | undefined =>
  predicate.startsWith(PREDICATE_PREFIX) ? predicate.slice(PREDICATE_PREFIX.length) : undefined;

export class ViewDefinitionError extends YrmError {
  constructor(message: string) {
    super("INVALID_VIEW", message);
    this.name = "ViewDefinitionError";
  }
}

/**
 * `ViewDefinition.appliesTo` is a single `EntityKind` string. A view that
 * applies to several kinds (the built-in `last_contact`) is written as a comma
 * list, "person,organization", which is still a valid kind string; ADR 0010
 * proposes widening the contract to `EntityKind[]` in its own PR.
 */
export function kindsOf(def: Pick<ViewDefinition, "appliesTo">): string[] {
  return def.appliesTo.split(",").map((k) => k.trim()).filter((k) => k.length > 0);
}

export function appliesTo(def: ViewDefinition, entity: Pick<Entity, "kind">): boolean {
  return kindsOf(def).includes(entity.kind);
}

/**
 * Check and normalize a definition. Throws `ViewDefinitionError` with a
 * message a person can act on. `ruleNames` are the rule functions registered
 * right now; a rule view with no function would never get a value.
 */
export function validateDefinition(input: unknown, ruleNames: ReadonlySet<string>): ViewDefinition {
  if (typeof input !== "object" || input === null) throw new ViewDefinitionError("a view definition must be an object");
  const r = input as Record<string, unknown>;
  const name = typeof r["name"] === "string" ? r["name"].trim() : "";
  if (!NAME_RE.test(name)) {
    throw new ViewDefinitionError(`view name "${name}" must be snake_case: a lowercase letter, then letters, digits or _ (max 63)`);
  }
  const rawKinds = typeof r["appliesTo"] === "string" ? r["appliesTo"] : "";
  const kinds = kindsOf({ appliesTo: rawKinds });
  if (kinds.length === 0) throw new ViewDefinitionError(`view "${name}" needs appliesTo (${VIEW_KINDS.join(", ")})`);
  for (const k of kinds) {
    if (!/^[a-z][a-z0-9_-]*$/.test(k)) throw new ViewDefinitionError(`view "${name}": "${k}" is not an entity kind`);
  }
  const valueType = r["valueType"];
  if (typeof valueType !== "string" || !VALUE_TYPES.includes(valueType as ViewDefinition["valueType"])) {
    throw new ViewDefinitionError(`view "${name}": valueType must be one of ${VALUE_TYPES.join(", ")}`);
  }
  const description = typeof r["description"] === "string" ? r["description"].trim().replace(/\s+/g, " ") : "";
  if (description.length < 8) {
    throw new ViewDefinitionError(`view "${name}" needs a description: one or two sentences saying what it is and how to tell`);
  }
  if (description.length > DESCRIPTION_MAX) {
    throw new ViewDefinitionError(`view "${name}": description is ${description.length} characters; keep it under ${DESCRIPTION_MAX}`);
  }
  const populatedBy = r["populatedBy"] ?? "model";
  if (populatedBy !== "rule" && populatedBy !== "model") {
    throw new ViewDefinitionError(`view "${name}": populatedBy must be "rule" or "model"`);
  }
  if (populatedBy === "rule" && !ruleNames.has(name)) {
    const known = [...ruleNames].sort().join(", ") || "(none)";
    throw new ViewDefinitionError(`view "${name}" is populated by rule, but no extension registers a rule with that name; rules: ${known}`);
  }

  const def: ViewDefinition = { name, appliesTo: kinds.join(","), description, valueType: valueType as ViewDefinition["valueType"], populatedBy };
  const rawEnum = r["enumValues"];
  if (valueType === "enum") {
    const values = Array.isArray(rawEnum) ? rawEnum.filter((v): v is string => typeof v === "string").map((v) => v.trim()).filter(Boolean) : [];
    const distinct = [...new Set(values)];
    if (distinct.length < 2) throw new ViewDefinitionError(`view "${name}" is an enum; give at least two values (--enum a,b,c)`);
    def.enumValues = distinct;
  } else if (rawEnum !== undefined && (!Array.isArray(rawEnum) || rawEnum.length > 0)) {
    throw new ViewDefinitionError(`view "${name}": enum values only apply to --type enum`);
  }
  return def;
}

export function sameDefinition(a: ViewDefinition, b: ViewDefinition): boolean {
  return JSON.stringify(normalizeForCompare(a)) === JSON.stringify(normalizeForCompare(b));
}

function normalizeForCompare(d: ViewDefinition): unknown[] {
  return [d.name, d.appliesTo, d.description, d.valueType, d.populatedBy, d.enumValues ?? []];
}

// ---- dropped views ---------------------------------------------------------------

/**
 * The Store contract has `defineView` and `listViews` but no delete. Until a
 * contract PR adds one, `view drop` records the name here and every reader
 * goes through `activeViews`. The facts stay; only the definition goes.
 */
const DROPPED_KEY = "dropped";

export async function droppedViews(store: Store, tenantId: string): Promise<Set<string>> {
  return new Set((await store.kvGet<string[]>(VIEWS, `${DROPPED_KEY}:${tenantId}`)) ?? []);
}

async function setDropped(store: Store, tenantId: string, names: Set<string>): Promise<void> {
  await store.kvSet<string[]>(VIEWS, `${DROPPED_KEY}:${tenantId}`, [...names].sort());
}

export async function activeViews(store: Store, tenantId: string): Promise<ViewDefinition[]> {
  const dropped = await droppedViews(store, tenantId);
  return (await store.listViews(tenantId)).filter((v) => !dropped.has(v.name));
}

export async function findView(store: Store, tenantId: string, name: string): Promise<ViewDefinition | undefined> {
  return (await activeViews(store, tenantId)).find((v) => v.name === name);
}

/** Define or redefine. Clears a previous drop of the same name. */
export async function saveView(store: Store, tenantId: string, def: ViewDefinition): Promise<void> {
  await store.defineView(tenantId, def);
  const dropped = await droppedViews(store, tenantId);
  if (dropped.delete(def.name)) await setDropped(store, tenantId, dropped);
}

export async function dropView(store: Store, tenantId: string, name: string): Promise<boolean> {
  if (!(await findView(store, tenantId, name))) return false;
  const dropped = await droppedViews(store, tenantId);
  dropped.add(name);
  await setDropped(store, tenantId, dropped);
  return true;
}

// ---- settings --------------------------------------------------------------------

export interface ViewSettings {
  /** Most event text a model view reads per entity, in estimated tokens. */
  maxEventTokens: number;
  /** Most current facts shown to the model per entity. */
  maxFacts: number;
  /** Recompute views for entities touched during a run, at host stop. "rules" skips model views. */
  incremental: "all" | "rules" | "off";
  /** Definitions kept in yrm.config.ts, applied at host start. */
  definitions: unknown[];
}

export const DEFAULT_SETTINGS: ViewSettings = { maxEventTokens: 3000, maxFacts: 40, incremental: "all", definitions: [] };

export function readSettings(raw: Record<string, unknown> | undefined): ViewSettings {
  const s = raw ?? {};
  const num = (v: unknown, d: number): number => (typeof v === "number" && Number.isFinite(v) && v >= 0 ? Math.floor(v) : d);
  const inc = s["incremental"];
  return {
    maxEventTokens: num(s["maxEventTokens"], DEFAULT_SETTINGS.maxEventTokens),
    maxFacts: num(s["maxFacts"], DEFAULT_SETTINGS.maxFacts),
    incremental: inc === "rules" || inc === "off" ? inc : inc === false ? "off" : "all",
    definitions: Array.isArray(s["definitions"]) ? s["definitions"] : [],
  };
}

/**
 * Apply built-in and config definitions. Idempotent: an unchanged definition is
 * not rewritten, and a name the user dropped stays dropped until redefined
 * with `view define --force`.
 */
export async function applyDefinitions(
  store: Store,
  tenantId: string,
  defs: Array<{ def: unknown; from: string }>,
  ruleNames: ReadonlySet<string>,
  log: Logger,
): Promise<string[]> {
  const existing = new Map((await store.listViews(tenantId)).map((v) => [v.name, v]));
  const dropped = await droppedViews(store, tenantId);
  const applied: string[] = [];
  for (const { def: raw, from } of defs) {
    let def: ViewDefinition;
    try {
      def = validateDefinition(raw, ruleNames);
    } catch (err) {
      log.warn(`ignoring view definition from ${from}: ${err instanceof Error ? err.message : String(err)}`);
      continue;
    }
    if (dropped.has(def.name)) continue;
    const prev = existing.get(def.name);
    if (prev && (from === "builtin" || sameDefinition(prev, def))) continue;
    await store.defineView(tenantId, def);
    applied.push(def.name);
  }
  return applied;
}
