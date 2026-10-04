import {
  estimateTokens,
  lookupPricing,
  parseJsonText,
  type Entity,
  type Fact,
  type JsonSchema,
  type Logger,
  type ModelRouter,
  type NewFact,
  type Provenance,
  type SourceEvent,
  type Store,
  type TenantConfig,
  type ViewDefinition,
} from "@yrm/core";
import { PREDICATE_PREFIX, VIEWS, VIEWS_VERSION, appliesTo, predicateOf, type ViewSettings } from "./definitions.ts";
import { RULE_CONFIDENCE, type ViewRule } from "./rules.ts";
import {
  checkValue,
  currentValue,
  entityLookup,
  eventsAbout,
  isSelf,
  membersOf,
  sameValue,
  setStatus,
  statementFor,
  type ViewStatus,
} from "./values.ts";

/** Model answers above this are clipped: a view inferred from mail is never certain. */
export const MODEL_CONFIDENCE_CAP = 0.9;
/** Output budget for one view answer. */
export const MODEL_MAX_TOKENS = 300;
const EVENT_TEXT_MAX_CHARS = 2400;
const CACHE_KEY = "views:populate:v1";

/** Router failures that mean "no model right now": log once, skip model views, keep rule views. */
const UNAVAILABLE = new Set(["NO_ROUTE", "NO_ELIGIBLE_ROUTE", "BUDGET_EXCEEDED", "BLOCKED", "ALL_ROUTES_FAILED"]);

function routerCode(err: unknown): string | undefined {
  if (err instanceof Error && err.name === "RouterError" && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

export interface EngineDeps {
  store: Store;
  models: ModelRouter;
  tenantId: string;
  tenant: Pick<TenantConfig, "selfAddresses" | "selfDomains">;
  settings: ViewSettings;
  rules: ReadonlyMap<string, ViewRule>;
  log: Logger;
}

export interface Outcome {
  view: string;
  entity: { id: string; name: string; kind: string };
  state: ViewStatus["state"] | "would_compute" | "skipped";
  reason: string;
  value?: unknown;
  fact?: Fact;
  /** Estimated prompt tokens for a model view (dry runs and real calls). */
  inputTokens?: number;
}

export interface Prompt {
  system: string;
  user: string;
  schema: JsonSchema;
  /** Ids the model may cite, mapped to the events they rest on. */
  citable: Map<string, string[]>;
  /** Entities the model may name for an entity view. */
  candidates: Entity[];
  /** Events shown, by id, for quote checks. */
  events: Map<string, SourceEvent>;
}

// ---- prompt ------------------------------------------------------------------------

export const SYSTEM_V1 = `You fill in one field of a CRM record using only the evidence given.
Reply with one JSON object and nothing else:
{"value": <answer or null>, "confidence": <0 to 1>, "evidence": ["<id>"], "quote": "<exact words copied from one message>"}
Rules:
- value must match the field type described. Use null when the evidence does not say.
- evidence lists the ids (event ids or fact ids in square brackets) that support the answer. Use only ids shown.
- quote is optional; copy it exactly from a message, or use "".
- Do not guess. A confident wrong answer is worse than null.`;

function typeHint(def: ViewDefinition): string {
  switch (def.valueType) {
    case "string":
      return "a short phrase or sentence";
    case "number":
      return "a number";
    case "boolean":
      return "true or false";
    case "date":
      return "a date as YYYY-MM-DD";
    case "enum":
      return `exactly one of: ${(def.enumValues ?? []).join(", ")}`;
    case "entity":
      return "the id of one person from the People list";
    case "json":
      return "any JSON value";
  }
}

function valueSchema(def: ViewDefinition): JsonSchema {
  switch (def.valueType) {
    case "number":
      return { type: ["number", "null"] };
    case "boolean":
      return { type: ["boolean", "null"] };
    case "enum":
      return { type: ["string", "null"], enum: [...(def.enumValues ?? []), null] };
    case "json":
      return {};
    default:
      return { type: ["string", "null"] };
  }
}

export function schemaFor(def: ViewDefinition): JsonSchema {
  return {
    type: "object",
    additionalProperties: false,
    required: ["value", "confidence", "evidence"],
    properties: {
      value: valueSchema(def),
      confidence: { type: "number" },
      evidence: { type: "array", items: { type: "string" } },
      quote: { type: "string" },
    },
  };
}

function senderName(e: SourceEvent): string {
  const p = e.participants.find((x) => x.role === "from" || x.role === "organizer" || x.role === "author");
  return p?.name ?? p?.address ?? "unknown";
}

/**
 * The user message: the field, the record, the people a value may name, the
 * current facts (with their ids and the events behind them), then as many of
 * the newest events as fit `maxEventTokens`. Facts first: they are already
 * distilled and cheaper than the text they came from.
 */
export async function buildPrompt(deps: EngineDeps, def: ViewDefinition, entity: Entity): Promise<Prompt> {
  const { store, tenantId, settings } = deps;
  const members = await membersOf(store, tenantId, entity);
  const now = new Date().toISOString();
  const citable = new Map<string, string[]>();

  const facts: Fact[] = [];
  const seen = new Set<string>();
  for (const who of [entity, ...members]) {
    for (const f of await store.queryFacts({ tenantId, entityId: who.id, validAt: now })) {
      if (seen.has(f.id) || f.predicate.startsWith(PREDICATE_PREFIX)) continue;
      seen.add(f.id);
      facts.push(f);
    }
  }
  facts.sort((a, b) => b.validFrom.localeCompare(a.validFrom));
  const shownFacts = facts.slice(0, settings.maxFacts);
  const factLines = shownFacts.map((f) => {
    citable.set(f.id, f.provenance.map((p) => p.eventId));
    return `- [${f.id}] ${f.validFrom.slice(0, 10)} ${f.statement}`;
  });

  const events = await eventsAbout(store, tenantId, entity, members);
  const shown = new Map<string, SourceEvent>();
  const eventBlocks: string[] = [];
  let used = 0;
  for (const e of events) {
    const text = e.content.text.trim();
    const body = text.length > EVENT_TEXT_MAX_CHARS ? `${text.slice(0, EVENT_TEXT_MAX_CHARS)}…` : text;
    const block = `### ${e.id} | ${e.occurredAt.slice(0, 10)} | from ${senderName(e)} | ${e.content.title ?? "(no title)"}\n${body}`;
    const t = estimateTokens(block);
    if (used + t > settings.maxEventTokens) break;
    used += t;
    eventBlocks.push(block);
    shown.set(e.id, e);
    citable.set(e.id, [e.id]);
  }

  // People the answer may name: for an org its staff, for anyone the people in the shown events.
  const candidates = new Map<string, Entity>();
  for (const m of members) candidates.set(m.id, m);
  for (const e of shown.values()) {
    for (const p of e.participants) {
      if (!p.entityId || p.self || candidates.has(p.entityId) || p.entityId === entity.id) continue;
      const ent = await store.getEntity(p.entityId);
      if (ent && ent.kind === "person" && ent.status !== "rejected" && ent.status !== "merged") candidates.set(ent.id, ent);
    }
  }
  const people = [...candidates.values()].map((p) => {
    const email = p.identifiers.find((i) => i.type === "email")?.value;
    return `- ${p.id} | ${p.name}${email ? ` | ${email}` : ""}`;
  });

  const idents = entity.identifiers.filter((i) => i.type === "email" || i.type === "domain").map((i) => i.value);
  const user = [
    "## Field",
    `name: ${def.name}`,
    `type: ${typeHint(def)}`,
    `meaning: ${def.description}`,
    "",
    "## Record",
    `${entity.kind}: ${entity.name}${idents.length ? ` (${idents.join(", ")})` : ""}`,
    "",
    "## People (id | name | email)",
    people.join("\n") || "(none)",
    "",
    "## Facts, newest first ([fact id] date statement)",
    factLines.join("\n") || "(none)",
    "",
    "## Messages, newest first (event id | date | sender | title)",
    eventBlocks.join("\n\n") || "(none)",
    "",
    `Answer with the JSON object for "${def.name}".`,
  ].join("\n");

  return { system: SYSTEM_V1, user, schema: schemaFor(def), citable, candidates: [...candidates.values()], events: shown };
}

// ---- model answers -------------------------------------------------------------------

export interface ParsedAnswer {
  value: unknown;
  confidence: number;
  provenance: Provenance[];
  validFrom: string;
  object?: { entityId: string; name?: string };
}

export type AnswerCheck = { ok: true; answer: ParsedAnswer } | { ok: false; state: "no_value" | "rejected"; reason: string };

/** Validate a raw model answer against the definition and the ids it was shown. */
export async function checkAnswer(deps: EngineDeps, def: ViewDefinition, prompt: Prompt, raw: unknown): Promise<AnswerCheck> {
  if (typeof raw !== "object" || raw === null) return { ok: false, state: "rejected", reason: "reply was not a JSON object" };
  const r = raw as Record<string, unknown>;
  if (r["value"] === null || r["value"] === undefined || r["value"] === "") {
    return { ok: false, state: "no_value", reason: "the model found no evidence for a value" };
  }
  const checked = await checkValue(def, r["value"], entityLookup(deps.store, deps.tenantId, prompt.candidates));
  if (!checked.ok) return { ok: false, state: "rejected", reason: `model answer rejected: ${checked.reason}` };

  const cited = Array.isArray(r["evidence"]) ? r["evidence"].filter((x): x is string => typeof x === "string").map((x) => x.replace(/^\[|\]$/g, "").trim()) : [];
  const eventIds = [...new Set(cited.flatMap((id) => prompt.citable.get(id) ?? []))];
  if (eventIds.length === 0) return { ok: false, state: "rejected", reason: "model answer rejected: it cited no evidence shown to it" };

  const quote = typeof r["quote"] === "string" ? r["quote"].trim() : "";
  const provenance: Provenance[] = eventIds.map((eventId) => ({ eventId }));
  if (quote) {
    // Attach the quote to the event it was copied from, and only if it really is there.
    for (const p of provenance) {
      const ev = prompt.events.get(p.eventId) ?? (await deps.store.getEvent(p.eventId));
      const at = ev ? ev.content.text.indexOf(quote) : -1;
      if (ev && at >= 0) {
        p.quote = quote;
        p.span = { start: at, end: at + quote.length };
        break;
      }
    }
  }

  const evidenceTimes: string[] = [];
  for (const id of eventIds) {
    const ev = prompt.events.get(id) ?? (await deps.store.getEvent(id));
    if (ev) evidenceTimes.push(ev.occurredAt);
  }
  const conf = typeof r["confidence"] === "number" && Number.isFinite(r["confidence"]) ? r["confidence"] : 0.6;
  const answer: ParsedAnswer = {
    value: checked.value,
    confidence: Math.min(MODEL_CONFIDENCE_CAP, Math.max(0, conf)),
    provenance,
    validFrom: evidenceTimes.sort().at(-1) ?? new Date().toISOString(),
  };
  if (checked.object) answer.object = checked.object;
  return { ok: true, answer };
}

// ---- the engine ----------------------------------------------------------------------

export interface ComputeOptions {
  dryRun?: boolean;
}

/**
 * Computes views for entities and records them as `view.<name>` attribute
 * facts. One instance per extension; `reset()` at host start clears the
 * "model unavailable" latch so each run logs at most once.
 */
export class ViewEngine {
  /** Set after a router failure; model views are skipped until `reset()`. */
  private unavailable: string | undefined;

  constructor(readonly deps: EngineDeps) {}

  reset(): void {
    this.unavailable = undefined;
  }

  hasModelRoute(): boolean {
    try {
      return this.deps.models.describe("extract").length > 0;
    } catch {
      return false;
    }
  }

  /** Why model views cannot run right now, or undefined when they can. */
  modelBlocker(): string | undefined {
    if (this.unavailable) return this.unavailable;
    if (!this.hasModelRoute()) return "no extract route configured";
    return undefined;
  }

  /** Entities a view applies to: right kind, live, not the tenant's own. */
  async targets(def: ViewDefinition, limit?: number): Promise<Entity[]> {
    const { store, tenantId, tenant } = this.deps;
    const kinds = def.appliesTo.split(",").map((k) => k.trim());
    const all = (await store.findEntities({ tenantId, kind: kinds, status: ["proposed", "confirmed"] }))
      .filter((e) => !isSelf(e, tenant))
      .sort((a, b) => a.name.localeCompare(b.name));
    return limit !== undefined ? all.slice(0, limit) : all;
  }

  async compute(def: ViewDefinition, entity: Entity, opts: ComputeOptions = {}): Promise<Outcome> {
    const base = { view: def.name, entity: { id: entity.id, name: entity.name, kind: entity.kind } };
    if (!appliesTo(def, entity)) return { ...base, state: "skipped", reason: `applies to ${def.appliesTo}, not ${entity.kind}` };
    if (isSelf(entity, this.deps.tenant)) return { ...base, state: "skipped", reason: "the tenant's own entity" };
    return def.populatedBy === "rule" ? this.computeRule(def, entity, opts) : this.computeModel(def, entity, opts);
  }

  private async computeRule(def: ViewDefinition, entity: Entity, opts: ComputeOptions): Promise<Outcome> {
    const { store, tenantId } = this.deps;
    const base = { view: def.name, entity: { id: entity.id, name: entity.name, kind: entity.kind } };
    const rule = this.deps.rules.get(def.name);
    if (!rule) return { ...base, state: "skipped", reason: "no rule registered for this view" };
    const members = await membersOf(store, tenantId, entity);
    const events = await eventsAbout(store, tenantId, entity, members);
    const result = await rule({ tenantId, store, entity, members, events, now: new Date().toISOString() });
    if (!result) return this.finish(base, entity, def, { state: "no_value", reason: "no events involve it yet" });
    if (opts.dryRun) return { ...base, state: "would_compute", reason: "rule, free", value: result.value };
    const checked = await checkValue(def, result.value, entityLookup(store, tenantId));
    if (!checked.ok) return this.finish(base, entity, def, { state: "rejected", reason: `rule returned a bad value: ${checked.reason}` });
    return this.record(def, entity, {
      value: checked.value,
      confidence: result.confidence ?? RULE_CONFIDENCE,
      provenance: result.provenance,
      validFrom: result.validFrom,
      ...(checked.object ? { object: checked.object } : {}),
    }, { kind: "rule" });
  }

  private async computeModel(def: ViewDefinition, entity: Entity, opts: ComputeOptions): Promise<Outcome> {
    const { store, tenantId, models, log } = this.deps;
    const base = { view: def.name, entity: { id: entity.id, name: entity.name, kind: entity.kind } };
    const current = await currentValue(store, tenantId, entity.id, def.name);
    // Human beats model: a value a person set is not recomputed, so it costs nothing and cannot flip.
    if (current?.origin.kind === "human") {
      return this.finish(base, entity, def, { state: "held_by_human", reason: `set by ${current.origin.by}; not recomputed` }, opts.dryRun);
    }
    const prompt = await buildPrompt(this.deps, def, entity);
    const inputTokens = estimateTokens(prompt.system) + estimateTokens(prompt.user);
    if (opts.dryRun) {
      const blocker = this.modelBlocker();
      return { ...base, state: "would_compute", reason: blocker ? `extract tier: ${blocker}` : "extract tier", inputTokens };
    }
    const blocker = this.modelBlocker();
    if (blocker) return { ...(await this.finish(base, entity, def, { state: "unavailable", reason: blocker })), inputTokens };

    let res;
    try {
      res = await models.complete("extract", {
        system: prompt.system,
        messages: [{ role: "user", content: prompt.user }],
        schema: prompt.schema,
        maxTokens: MODEL_MAX_TOKENS,
        temperature: 0,
        cacheKey: CACHE_KEY,
        meta: { extension: VIEWS, view: def.name, entityId: entity.id, tenantId },
      });
    } catch (err) {
      const code = routerCode(err);
      if (code === undefined || !UNAVAILABLE.has(code)) throw err;
      this.unavailable = `extract tier unavailable (${code})`;
      const msg = `model views not computed: ${this.unavailable}; rule views still run`;
      if (code === "NO_ROUTE" || code === "NO_ELIGIBLE_ROUTE") log.info(msg);
      else log.warn(msg, { error: (err as Error).message });
      return { ...(await this.finish(base, entity, def, { state: "unavailable", reason: this.unavailable })), inputTokens };
    }
    const checked = await checkAnswer(this.deps, def, prompt, res.json ?? parseJsonText(res.text));
    if (!checked.ok) {
      log.debug(`view ${def.name} for ${entity.name}: ${checked.reason}`);
      return { ...(await this.finish(base, entity, def, { state: checked.state, reason: checked.reason })), inputTokens };
    }
    return { ...(await this.record(def, entity, checked.answer, { kind: "model", model: res.model })), inputTokens };
  }

  /** Record the value unless it is unchanged; supersede the previous non-human value. */
  private async record(
    def: ViewDefinition,
    entity: Entity,
    answer: ParsedAnswer,
    origin: { kind: "rule" | "model"; model?: string },
  ): Promise<Outcome> {
    const { store, tenantId } = this.deps;
    const base = { view: def.name, entity: { id: entity.id, name: entity.name, kind: entity.kind } };
    const current = await currentValue(store, tenantId, entity.id, def.name);
    if (current && sameValue(current.value, answer.value)) {
      return { ...(await this.finish(base, entity, def, { state: "unchanged", reason: "same as the current value" })), value: current.value, fact: current };
    }
    if (current?.origin.kind === "human") {
      // Rule views are not exempt from human-beats-model; leave the human value standing.
      return { ...(await this.finish(base, entity, def, { state: "held_by_human", reason: `set by ${current.origin.by}; not overridden` })), value: current.value, fact: current };
    }
    const fact: NewFact = {
      tenantId,
      type: "attribute",
      subject: { entityId: entity.id, name: entity.name },
      predicate: predicateOf(def.name),
      value: answer.value,
      statement: statementFor(def, entity, answer.value),
      validFrom: answer.validFrom,
      provenance: answer.provenance,
      confidence: answer.confidence,
      origin: { kind: origin.kind, by: VIEWS, version: VIEWS_VERSION, ...(origin.model ? { model: origin.model } : {}) },
      tags: [`view:${def.name}`],
    };
    if (answer.object) fact.object = answer.object;
    if (current) fact.supersedes = current.id;
    const recorded = await store.recordFact(fact);
    await setStatus(store, entity.id, def.name, { state: "recorded", reason: current ? "replaced the previous value" : "first value" });
    return { ...base, state: "recorded", reason: current ? "replaced the previous value" : "first value", value: recorded.value, fact: recorded };
  }

  private async finish(
    base: Pick<Outcome, "view" | "entity">,
    entity: Entity,
    def: ViewDefinition,
    status: Pick<ViewStatus, "state" | "reason">,
    dryRun = false,
  ): Promise<Outcome> {
    if (!dryRun) await setStatus(this.deps.store, entity.id, def.name, status);
    return { ...base, ...status };
  }

  /** Every applicable entity, or the first `limit`. Model views stop calling once the tier is unavailable. */
  async backfill(def: ViewDefinition, opts: ComputeOptions & { limit?: number } = {}): Promise<Outcome[]> {
    const out: Outcome[] = [];
    for (const e of await this.targets(def, opts.limit)) out.push(await this.compute(def, e, opts));
    return out;
  }

  /** Price of the extract tier's first hop, USD per million tokens, when known. */
  pricing(): { route: string; input: number; output: number } | undefined {
    const hop = (() => {
      try {
        return this.deps.models.describe("extract")[0];
      } catch {
        return undefined;
      }
    })();
    if (!hop) return undefined;
    const p = hop.pricing ?? lookupPricing(hop.model);
    return { route: `${hop.provider}/${hop.model}`, input: p?.input ?? 0, output: p?.output ?? 0 };
  }
}
