import {
  estimateTokens,
  parseJsonText,
  type AskValue,
  type CommitmentValue,
  type EntityRef,
  type Extractor,
  type ExtractContext,
  type Fact,
  type Logger,
  type ModelRouter,
  type NewFact,
  type ObjectionValue,
  type Provenance,
  type SourceEvent,
  type Store,
} from "@yrm/core";
import { distinctByEntity, nameOf, refOf, senderOf, threadTag } from "./participants.ts";
import {
  EXTRACT_CACHE_KEY,
  EXTRACT_SCHEMA_V1,
  EXTRACT_SYSTEM_V1,
  TRIAGE_CACHE_KEY,
  TRIAGE_SCHEMA_V1,
  TRIAGE_SYSTEM_V1,
} from "./prompts.ts";
import { hasRuleCandidates } from "./rules.ts";

export const TRIAGE_EXTRACTOR = "model-triage";
export const TRIAGE_VERSION = "1";
export const MODEL_EXTRACTOR = "model-extractor";
export const MODEL_VERSION = "1";

/** kv namespace and key for triage results: `kvGet("extract", "triage:" + eventId)`. */
export const KV_NAMESPACE = "extract";
export const triageKey = (eventId: string): string => `triage:${eventId}`;

/** Thread context sent to the extract tier, in estimated tokens. */
export const EXTRACT_THREAD_TOKENS = 3000;
/** A quote the model could not point at loses this share of its confidence. */
export const UNLOCATED_QUOTE_PENALTY = 0.7;

export interface TriageResult {
  relevant: boolean;
  has: { commitment: boolean; ask: boolean; decision: boolean; objection: boolean; signal: boolean };
  summary: string;
  model?: string;
  version?: string;
}

/** Router failures that mean "no model available right now", not "the request is wrong". */
const UNAVAILABLE = new Set(["NO_ROUTE", "NO_ELIGIBLE_ROUTE", "BUDGET_EXCEEDED"]);
/** Also degrade on these, but loudly: a hook blocked the call or every provider failed. */
const FAILED = new Set(["BLOCKED", "ALL_ROUTES_FAILED"]);

function routerCode(err: unknown): string | undefined {
  if (err instanceof Error && err.name === "RouterError" && "code" in err && typeof err.code === "string") return err.code;
  return undefined;
}

/**
 * Tiers whose failure has been logged in this run. Shared by the extractors of
 * one extension instance and cleared on `host:start`, so an unreachable local
 * model produces one warning per tier instead of one per event.
 */
export type WarnedTiers = Set<string>;

/**
 * Model extractors must never take the pipeline down: with no keys, no budget
 * or a provider outage, the rule extractor's facts still get recorded.
 */
function degrade(err: unknown, tier: string, log: Logger, warned: WarnedTiers): boolean {
  const code = routerCode(err);
  if (code === undefined || (!UNAVAILABLE.has(code) && !FAILED.has(code))) return false;
  if (warned.has(tier)) {
    log.debug(`${tier} call failed (${code})`, { error: (err as Error).message });
    return true;
  }
  warned.add(tier);
  if (UNAVAILABLE.has(code)) {
    log.info(`${tier} tier unavailable (${code}); continuing with rule facts only`);
  } else {
    log.warn(`${tier} call failed (${code}); continuing with rule facts only; further ${tier} failures this run are not logged`, {
      error: (err as Error).message,
    });
  }
  return true;
}

function hasRoute(models: ModelRouter, tier: string): boolean {
  try {
    return models.describe(tier).length > 0;
  } catch {
    return false;
  }
}

function asBool(v: unknown): boolean {
  return v === true;
}

export function parseTriage(raw: unknown): TriageResult | undefined {
  if (typeof raw !== "object" || raw === null) return undefined;
  const r = raw as Record<string, unknown>;
  const has = (typeof r["has"] === "object" && r["has"] !== null ? r["has"] : {}) as Record<string, unknown>;
  if (typeof r["relevant"] !== "boolean") return undefined;
  return {
    relevant: r["relevant"],
    has: {
      commitment: asBool(has["commitment"]),
      ask: asBool(has["ask"]),
      decision: asBool(has["decision"]),
      objection: asBool(has["objection"]),
      signal: asBool(has["signal"]),
    },
    summary: typeof r["summary"] === "string" ? r["summary"].split(/\s+/).slice(0, 20).join(" ") : "",
  };
}

export function triageFlagged(t: TriageResult): boolean {
  return Object.values(t.has).some(Boolean);
}

export interface ModelDeps {
  store: Store;
  models: ModelRouter;
  /** Shared across extractors so each tier warns once per run. Defaults to a private set. */
  warned?: WarnedTiers;
}

export function createTriageExtractor(deps: ModelDeps): Extractor {
  const warned = deps.warned ?? new Set<string>();
  return {
    name: TRIAGE_EXTRACTOR,
    version: TRIAGE_VERSION,
    applies: () => hasRoute(deps.models, "triage"),
    async extract(event, ctx) {
      // Re-runs and re-extraction read the stored answer; a triage is paid for once.
      if (await deps.store.kvGet<TriageResult>(KV_NAMESPACE, triageKey(event.id))) return [];
      let res;
      try {
        res = await ctx.models.complete(
          "triage",
          {
            system: TRIAGE_SYSTEM_V1,
            messages: [{ role: "user", content: triageInput(event) }],
            schema: TRIAGE_SCHEMA_V1,
            maxTokens: 200,
            cacheKey: TRIAGE_CACHE_KEY,
            meta: { extension: "extract", extractor: TRIAGE_EXTRACTOR, eventId: event.id, tenantId: ctx.tenantId },
          },
          ctx.signal,
        );
      } catch (err) {
        if (degrade(err, "triage", ctx.log, warned)) return [];
        throw err;
      }
      const parsed = parseTriage(res.json ?? parseJsonText(res.text));
      if (!parsed) {
        ctx.log.warn("triage reply did not match the schema; event left untriaged", { eventId: event.id });
        return [];
      }
      await deps.store.kvSet<TriageResult>(KV_NAMESPACE, triageKey(event.id), {
        ...parsed,
        model: res.model,
        version: TRIAGE_VERSION,
      });
      return [];
    },
  };
}

function triageInput(event: SourceEvent): string {
  const title = event.content.title ? `Subject: ${event.content.title}\n\n` : "";
  return `${title}${event.content.text}`;
}

// ---- extract prompt -------------------------------------------------------------

function dateOf(iso: string): string {
  return iso.slice(0, 10);
}

function threadContext(thread: SourceEvent[], budget: number): string[] {
  const kept: string[] = [];
  let used = 0;
  for (let i = thread.length - 1; i >= 0; i--) {
    const e = thread[i]!;
    const from = senderOf(e);
    const block = `### ${e.content.title ?? "(no title)"}\nfrom: ${from ? nameOf(from) : "unknown"} | date: ${dateOf(e.occurredAt)}\n${e.content.text.trim()}`;
    const t = estimateTokens(block);
    if (used + t > budget) break;
    used += t;
    kept.push(block);
  }
  return kept.reverse();
}

function knownFactLine(f: Fact): string {
  const v = f.value as Record<string, unknown> | null;
  const state =
    f.type === "commitment" ? ` status=${String(v?.["status"])}${v?.["dueAt"] ? ` due=${String(v["dueAt"])}` : ""}`
    : f.type === "ask" ? ` answered=${String(v?.["answered"])}`
    : f.type === "objection" ? ` resolved=${String(v?.["resolved"])}`
    : "";
  return `- [${f.id}] ${f.type}${state} subject=${f.subject.entityId}: ${f.statement}`;
}

/** The user message for the extract tier. Exported so tests and `yrm doctor` can show it. */
export function buildExtractPrompt(event: SourceEvent, ctx: ExtractContext): string {
  const participants = distinctByEntity(event.participants).map((p) => {
    const flags = [p.role, p.self ? "self" : undefined].filter(Boolean).join(", ");
    return `- ${p.entityId} | ${nameOf(p, ctx.participants)}${p.address ? ` <${p.address}>` : ""} | ${flags}`;
  });
  const thread = threadContext(ctx.thread, EXTRACT_THREAD_TOKENS);
  const known = ctx.knownFacts.map(knownFactLine);
  const sender = senderOf(event);
  return [
    "## Participants (entity id | name | role)",
    participants.join("\n") || "(none resolved)",
    "",
    "## Earlier in this thread (oldest first)",
    thread.join("\n\n") || "(none)",
    "",
    "## Known facts about these participants",
    known.join("\n") || "(none)",
    "",
    "## The message",
    `title: ${event.content.title ?? "(no title)"}`,
    `from: ${sender ? nameOf(sender, ctx.participants) : "unknown"} | date: ${event.occurredAt}`,
    "",
    event.content.text,
  ].join("\n");
}

// ---- validation ---------------------------------------------------------------

/** Collapse whitespace and straighten quotes, keeping a map back to original offsets. */
function normalizeWithMap(s: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let lastSpace = false;
  for (let i = 0; i < s.length; i++) {
    let c = s[i]!;
    if (/\s/.test(c)) {
      if (lastSpace) continue;
      c = " ";
      lastSpace = true;
    } else {
      lastSpace = false;
      if (c === "’" || c === "‘") c = "'";
      else if (c === "“" || c === "”") c = '"';
    }
    norm += c;
    map.push(i);
  }
  return { norm, map };
}

/** Locate `quote` in `text`: exact first, then ignoring whitespace and quote-style differences. */
export function findSpan(text: string, quote: string): { start: number; end: number } | undefined {
  if (quote.length === 0) return undefined;
  const exact = text.indexOf(quote);
  if (exact >= 0) return { start: exact, end: exact + quote.length };
  const t = normalizeWithMap(text);
  const q = normalizeWithMap(quote.trim()).norm;
  if (q.length === 0) return undefined;
  const i = t.norm.indexOf(q);
  if (i < 0) return undefined;
  return { start: t.map[i]!, end: t.map[i + q.length - 1]! + 1 };
}

const FACT_TYPES = new Set(["commitment", "ask", "decision", "objection", "signal", "role", "relationship", "attribute"]);
const STATUSES = new Set(["open", "fulfilled", "broken", "cancelled"]);
const SEVERITIES = new Set(["low", "medium", "high"]);

function str(v: unknown): string | undefined {
  return typeof v === "string" && v.trim().length > 0 ? v.trim() : undefined;
}

function isoOr(v: unknown, fallback: string): string {
  const s = str(v);
  if (s === undefined) return fallback;
  const t = Date.parse(s);
  return Number.isNaN(t) ? fallback : new Date(t).toISOString();
}

function shapeValue(
  type: string,
  raw: Record<string, unknown>,
  statement: string,
  subject: EntityRef,
  object: EntityRef | undefined,
  event: SourceEvent,
  superseding: boolean,
): unknown {
  const what = str(raw["what"]) ?? statement;
  switch (type) {
    case "commitment": {
      const status = STATUSES.has(String(raw["status"])) ? (raw["status"] as CommitmentValue["status"]) : "open";
      const v: CommitmentValue = { what, owedBy: subject, status };
      if (object) v.owedTo = object;
      const due = str(raw["dueAt"]);
      if (due && !Number.isNaN(Date.parse(due))) v.dueAt = due;
      if (status !== "open") v.resolvedBy = event.id;
      return v;
    }
    case "ask": {
      const v: AskValue = { what, askedBy: subject, answered: raw["answered"] === true };
      if (object) v.askedOf = object;
      if (v.answered && superseding) v.answeredBy = event.id;
      return v;
    }
    case "decision": {
      const rationale = str(raw["rationale"]);
      return { what, decidedBy: subject, ...(rationale ? { rationale } : {}) };
    }
    case "objection": {
      const v: ObjectionValue = { what, raisedBy: subject, resolved: raw["resolved"] === true };
      if (SEVERITIES.has(String(raw["severity"]))) v.severity = raw["severity"] as NonNullable<ObjectionValue["severity"]>;
      return v;
    }
    default:
      return { ...raw, what };
  }
}

export interface ValidationStats {
  dropped: { badType: number; badSubject: number; noQuote: number };
  unlocated: number;
}

/** Turn the model's raw facts into `NewFact`s, enforcing ids, quotes and supersedes. */
export function validateModelFacts(
  raw: unknown,
  event: SourceEvent,
  ctx: Pick<ExtractContext, "participants" | "knownFacts">,
  model: string,
): { facts: NewFact[]; stats: ValidationStats } {
  const stats: ValidationStats = { dropped: { badType: 0, badSubject: 0, noQuote: 0 }, unlocated: 0 };
  const list =
    typeof raw === "object" && raw !== null && Array.isArray((raw as { facts?: unknown }).facts)
      ? ((raw as { facts: unknown[] }).facts)
      : [];
  const people = new Map<string, EntityRef>();
  for (const p of event.participants) {
    const ref = refOf(p, ctx.participants);
    if (ref && !people.has(ref.entityId)) people.set(ref.entityId, ref);
  }
  for (const e of ctx.participants) if (!people.has(e.id)) people.set(e.id, { entityId: e.id, name: e.name });
  const known = new Map(ctx.knownFacts.map((f) => [f.id, f]));
  const sender = senderOf(event);
  const speaker = sender ? refOf(sender, ctx.participants) : undefined;
  const tag = threadTag(event);
  const text = event.content.text;

  const facts: NewFact[] = [];
  for (const item of list) {
    if (typeof item !== "object" || item === null) continue;
    const r = item as Record<string, unknown>;
    const type = str(r["type"]);
    if (!type || !FACT_TYPES.has(type)) {
      stats.dropped.badType++;
      continue;
    }
    const subject = people.get(String(r["subjectEntityId"]));
    if (!subject) {
      stats.dropped.badSubject++;
      continue;
    }
    const quote = str(r["quote"]);
    if (!quote) {
      stats.dropped.noQuote++;
      continue;
    }
    const objectId = str(r["objectEntityId"]);
    const object = objectId && objectId !== subject.entityId ? people.get(objectId) : undefined;
    const statement = str(r["statement"]) ?? quote;
    const span = findSpan(text, quote);
    let confidence = typeof r["confidence"] === "number" && Number.isFinite(r["confidence"]) ? r["confidence"] : 0.7;
    confidence = Math.min(1, Math.max(0, confidence));
    if (!span) {
      confidence *= UNLOCATED_QUOTE_PENALTY;
      stats.unlocated++;
    }
    // Only supersede what we showed the model, and never a human fact (the store would refuse).
    const target = str(r["supersedes"]);
    const old = target ? known.get(target) : undefined;
    const supersedes = old && old.origin.kind !== "human" ? old.id : undefined;

    const provenance: Provenance = { eventId: event.id, quote: span ? text.slice(span.start, span.end) : quote };
    if (speaker) provenance.speaker = speaker;
    if (span) provenance.span = span;
    const rawValue = typeof r["value"] === "object" && r["value"] !== null ? (r["value"] as Record<string, unknown>) : {};

    const fact: NewFact = {
      type,
      subject,
      predicate: str(r["predicate"]) ?? type,
      value: shapeValue(type, rawValue, statement, subject, object, event, supersedes !== undefined),
      statement,
      validFrom: isoOr(r["validFrom"], event.occurredAt),
      provenance: old && supersedes ? [...old.provenance, provenance] : [provenance],
      confidence,
      origin: { kind: "model", by: "extract", model, version: MODEL_VERSION },
    };
    if (object) fact.object = object;
    if (supersedes) fact.supersedes = supersedes;
    if (tag) fact.tags = [tag];
    facts.push(fact);
  }
  return { facts, stats };
}

export function createModelExtractor(deps: ModelDeps): Extractor {
  const warned = deps.warned ?? new Set<string>();
  return {
    name: MODEL_EXTRACTOR,
    version: MODEL_VERSION,
    applies(event) {
      if (!hasRoute(deps.models, "extract")) return false;
      // With triage, the stored verdict decides in extract(); without it, rules gate for free.
      return hasRoute(deps.models, "triage") || hasRuleCandidates(event);
    },
    async extract(event, ctx) {
      const triage = await deps.store.kvGet<TriageResult>(KV_NAMESPACE, triageKey(event.id));
      if (triage ? !triageFlagged(triage) : !hasRuleCandidates(event)) return [];
      let res;
      try {
        res = await ctx.models.complete(
          "extract",
          {
            system: EXTRACT_SYSTEM_V1,
            messages: [{ role: "user", content: buildExtractPrompt(event, ctx) }],
            schema: EXTRACT_SCHEMA_V1,
            maxTokens: 2000,
            cacheKey: EXTRACT_CACHE_KEY,
            meta: { extension: "extract", extractor: MODEL_EXTRACTOR, eventId: event.id, tenantId: ctx.tenantId },
          },
          ctx.signal,
        );
      } catch (err) {
        if (degrade(err, "extract", ctx.log, warned)) return [];
        throw err;
      }
      const { facts, stats } = validateModelFacts(res.json ?? parseJsonText(res.text), event, ctx, res.model);
      const dropped = stats.dropped.badType + stats.dropped.badSubject + stats.dropped.noQuote;
      if (dropped > 0 || stats.unlocated > 0) ctx.log.debug("model facts adjusted", { eventId: event.id, ...stats });
      return facts;
    },
  };
}
