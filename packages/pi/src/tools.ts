// Bun only. pi tools that front YRM's own agent tools (registered by
// @yrm/ext-mcp), so pi gets the same semantics as MCP clients: one place
// owns the bi-temporal query, the context bundle and the write rules.
import { YrmError, type Entity, type Host } from "@yrm/core";
import { Type, type Static } from "typebox";
import { lookup, lookupOne, runYrmTool, type LazyHost } from "./host.ts";
import type { PiContext, PiToolDefinition, PiToolResult } from "./pi-types.ts";

/** Longest JSON a tool hands the model; longer results are cut with a pointer to narrower queries. */
export const MAX_RESULT_CHARS = 40_000;
/** Names in one `yrm_context` call can each match several entities; stop here. */
const MAX_CONTEXT_ENTITIES = 10;
/** Page size when scanning the log for a thread subject. */
const THREAD_PAGE = 500;

export function jsonResult(value: unknown, hint = "narrow the query or lower `limit`"): PiToolResult {
  let text = JSON.stringify(value, null, 2);
  if (text.length > MAX_RESULT_CHARS) text = `${text.slice(0, MAX_RESULT_CHARS)}\n... truncated; ${hint}`;
  return { content: [{ type: "text", text }], details: value };
}

/** pi validates params against the TypeBox schema before `execute`; this only narrows the type. */
function paramsOf<T>(params: unknown): T {
  return params as T;
}

/** Strip reply and forward prefixes so "Re: Pricing" finds the "Pricing" thread. */
export function normalizeSubject(s: string): string {
  let out = s.trim().toLowerCase();
  for (;;) {
    const next = out.replace(/^(re|fwd?|fw|aw|sv)\s*:\s*/i, "");
    if (next === out) return out;
    out = next;
  }
}

/** A thread key as given, or the most recent thread whose subject matches. */
export async function resolveThread(host: Host, thread: string): Promise<string> {
  const tenantId = host.config.tenant.id;
  if ((await host.store.listEvents({ tenantId, threadKey: thread, limit: 1 })).length > 0) return thread;
  const want = normalizeSubject(thread);
  let best: { key: string; at: string } | null = null;
  // The store has no subject index, so page through the log (ordered by id).
  let afterId: string | undefined;
  for (;;) {
    const page = await host.store.listEvents({ tenantId, limit: THREAD_PAGE, ...(afterId !== undefined ? { afterId } : {}) });
    for (const e of page) {
      const title = e.content.title;
      if (!e.threadKey || !title) continue;
      const have = normalizeSubject(title);
      if (have !== want && !have.includes(want)) continue;
      if (!best || e.occurredAt > best.at) best = { key: e.threadKey, at: e.occurredAt };
    }
    if (page.length < THREAD_PAGE) break;
    afterId = page[page.length - 1]!.id;
  }
  if (!best) throw new YrmError("YRM_NO_THREAD", `"thread": no thread key or subject matches "${thread}"`);
  return best.key;
}

// ---- yrm_context ------------------------------------------------------------------

const ContextParams = Type.Object({
  entities: Type.Optional(
    Type.Array(Type.String(), {
      description: "Who it is about: names, email addresses, domains or entity ids. Each may match more than one entity.",
    }),
  ),
  thread: Type.Optional(Type.String({ description: "A thread key, or a mail subject such as 'Re: Pricing for Q4'." })),
  query: Type.Optional(Type.String({ description: "What you are working on, for relevance." })),
  budget: Type.Optional(Type.Integer({ description: "Token budget for the bundle (default 2000).", minimum: 100 })),
  asOf: Type.Optional(Type.String({ description: "Build the bundle as YRM knew things at this time (ISO 8601). Default now." })),
});

function contextTool(lazy: LazyHost): PiToolDefinition {
  return {
    name: "yrm_context",
    label: "YRM context",
    description:
      "A token-budgeted brief on people, companies or a mail thread from YRM: who they are, the facts that matter (each citing " +
      "the event it came from) and open asks and commitments. Give names, email addresses or a thread subject; no ids needed. " +
      "Use it before drafting a reply, preparing a meeting, or answering 'what's going on with X'.",
    promptSnippet: "yrm_context: brief on a person, company or mail thread from the user's relationship record",
    parameters: ContextParams,
    exposure: "direct",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, raw) {
      const p = paramsOf<Static<typeof ContextParams>>(raw);
      const host = await lazy.get();
      const resolved: Array<{ query: string; entities: Array<{ id: string; name: string; kind: string }> }> = [];
      const unresolved: string[] = [];
      const ids: string[] = [];
      for (const q of p.entities ?? []) {
        const found = await lookup(host, q);
        if (found.length === 0) unresolved.push(q);
        resolved.push({ query: q, entities: found.map(brief) });
        for (const e of found) if (!ids.includes(e.id) && ids.length < MAX_CONTEXT_ENTITIES) ids.push(e.id);
      }
      const input: Record<string, unknown> = {};
      if (ids.length > 0) input["entityIds"] = ids;
      if (p.thread !== undefined) input["threadKey"] = await resolveThread(host, p.thread);
      if (p.query !== undefined) input["query"] = p.query;
      if (p.budget !== undefined) input["budget"] = p.budget;
      if (p.asOf !== undefined) input["asOf"] = p.asOf;
      if (input["entityIds"] === undefined && input["threadKey"] === undefined) {
        throw new YrmError(
          "YRM_NO_ENTITY",
          unresolved.length > 0
            ? `nothing in YRM matches ${unresolved.map((q) => `"${q}"`).join(", ")}; try yrm_search_entities with part of the name`
            : 'give "entities" or "thread"',
        );
      }
      const bundle = (await runYrmTool(host, "yrm_context", input)) as Record<string, unknown>;
      return jsonResult({ resolved, unresolved, threadKey: input["threadKey"] ?? null, ...bundle });
    },
  };
}

function brief(e: Entity): { id: string; name: string; kind: string } {
  return { id: e.id, name: e.name, kind: e.kind };
}

// ---- yrm_facts --------------------------------------------------------------------

const FactsParams = Type.Object({
  entity: Type.Optional(Type.String({ description: "Name, email address, domain or id; must match one entity." })),
  type: Type.Optional(Type.String({ description: "commitment, ask, decision, objection, signal, role, relationship, attribute." })),
  predicate: Type.Optional(Type.String({ description: "Exact predicate, e.g. works_at, title, committed_to." })),
  validAt: Type.Optional(Type.String({ description: "World time (ISO 8601): facts true at this moment. Default now." })),
  asOf: Type.Optional(Type.String({ description: "Belief time (ISO 8601): what YRM had recorded by then. Default now." })),
  includeRetracted: Type.Optional(Type.Boolean({ description: "Include superseded and retracted versions (full history)." })),
  limit: Type.Optional(Type.Integer({ description: "Maximum facts (default 50, max 200).", minimum: 1, maximum: 200 })),
});

/** What `yrm_facts` returns, for codemode scripts that receive `structuredContent`. */
const FactsOutput = Type.Object({
  entity: Type.Union([Type.Object({ id: Type.String(), name: Type.String(), kind: Type.String() }), Type.Null()]),
  validAt: Type.String(),
  asOf: Type.String(),
  count: Type.Integer(),
  facts: Type.Array(
    Type.Object(
      {
        id: Type.String(),
        type: Type.String(),
        predicate: Type.String(),
        statement: Type.String(),
        validFrom: Type.String(),
        recordedAt: Type.String(),
        confidence: Type.Number(),
      },
      { additionalProperties: true },
    ),
  ),
});

function factsTool(lazy: LazyHost): PiToolDefinition {
  return {
    name: "yrm_facts",
    label: "YRM facts",
    description:
      "Query YRM's bi-temporal facts. `validAt` = what was true in the world at T; `asOf` = what YRM believed at T " +
      "(both default to now; set both to replay an earlier view). Each fact has provenance (event id, speaker, quote), " +
      "validFrom/validTo, recordedAt/retractedAt, confidence and origin (human > model > rule). " +
      "Codemode tool: call it from a script and print only the facts you need.",
    parameters: FactsParams,
    outputSchema: FactsOutput,
    exposure: "codemode",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, raw) {
      const p = paramsOf<Static<typeof FactsParams>>(raw);
      const host = await lazy.get();
      const entity = p.entity !== undefined ? await lookupOne(host, p.entity, "entity") : null;
      const input: Record<string, unknown> = {};
      if (entity) input["entityId"] = entity.id;
      for (const k of ["type", "predicate", "validAt", "asOf", "includeRetracted", "limit"] as const) {
        if (p[k] !== undefined) input[k] = p[k];
      }
      const out = { entity: entity ? brief(entity) : null, ...((await runYrmTool(host, "yrm_facts", input)) as Record<string, unknown>) };
      return { ...jsonResult(out), structuredContent: out };
    },
  };
}

// ---- yrm_today --------------------------------------------------------------------

const TodayParams = Type.Object({
  date: Type.Optional(Type.String({ description: "YYYY-MM-DD. Default today in the user's timezone." })),
  limit: Type.Optional(Type.Integer({ description: "Maximum items (default 50, max 200).", minimum: 1, maximum: 200 })),
});

function todayTool(lazy: LazyHost): PiToolDefinition {
  return {
    name: "yrm_today",
    label: "YRM today",
    description:
      "The user's attention queue: unanswered asks, overdue commitments, silence, meetings with open items, highest score first. " +
      "Each item has an action, a reason a person can check, and evidence facts (with provenance) and events.",
    promptSnippet: "yrm_today: what needs the user's attention today, with reasons and evidence",
    parameters: TodayParams,
    exposure: "direct",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, raw) {
      const p = paramsOf<Static<typeof TodayParams>>(raw);
      const input: Record<string, unknown> = {};
      if (p.date !== undefined) input["date"] = p.date;
      if (p.limit !== undefined) input["limit"] = p.limit;
      return jsonResult(await runYrmTool(await lazy.get(), "yrm_today", input));
    },
  };
}

// ---- yrm_search_entities ------------------------------------------------------------

const SearchParams = Type.Object({
  query: Type.String({ description: "Name fragment, email address or domain." }),
  kind: Type.Optional(Type.String({ description: "person, organization, deal or topic." })),
  status: Type.Optional(Type.Union([Type.Literal("proposed"), Type.Literal("confirmed"), Type.Literal("rejected"), Type.Literal("merged")])),
  limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 200 })),
});

function searchTool(lazy: LazyHost): PiToolDefinition {
  return {
    name: "yrm_search_entities",
    label: "YRM search",
    description:
      "Find people, organizations and deals in YRM by name substring or exact email address, domain or phone. " +
      "Returns ids, identifiers and a summary (first/last seen, open asks and commitments, organization).",
    parameters: SearchParams,
    exposure: "deferred",
    annotations: { readOnlyHint: true, openWorldHint: false },
    async execute(_id, raw) {
      const p = paramsOf<Static<typeof SearchParams>>(raw);
      return jsonResult(await runYrmTool(await lazy.get(), "yrm_search_entities", { ...p }));
    },
  };
}

// ---- yrm_record_fact ----------------------------------------------------------------

const RecordParams = Type.Object({
  type: Type.String({ description: "commitment, ask, decision, objection, signal, role, relationship or attribute." }),
  predicate: Type.String({ description: "snake_case verb, e.g. works_at, title, committed_to." }),
  subject: Type.String({ description: "Who or what the fact is about: id, name or address; must match one entity." }),
  object: Type.Optional(Type.String({ description: "The other party, when there is one; must match one entity." })),
  statement: Type.String({ description: "One sentence a person can read." }),
  value: Type.Unknown({ description: "Structured payload; shape depends on type (e.g. commitment: {what, dueAt, status})." }),
  validFrom: Type.Optional(Type.String({ description: "When it became true (ISO 8601). Default: the cited event's date." })),
  eventId: Type.Optional(Type.String({ description: "The event this fact rests on. Give this or `note`." })),
  note: Type.Optional(
    Type.Object(
      {
        title: Type.String(),
        text: Type.String({ description: "What the user told you, in their words where possible." }),
        occurredAt: Type.Optional(Type.String({ description: "When it happened (ISO 8601). Default now." })),
      },
      { description: "No event says this yet: record this note first and cite it." },
    ),
  ),
  quote: Type.Optional(Type.String({ description: "Verbatim words from the event supporting the fact." })),
  supersedes: Type.Optional(Type.String({ description: "Id of the fact this one corrects." })),
  confirm: Type.Optional(Type.Boolean({ description: "Only without an interactive UI: true after the user approved this exact fact." })),
});

/** Same rule as `yrm_record_fact` over MCP: no fact without an event it rests on. */
export const EVENT_REQUIRED =
  'every fact must rest on an event: pass "eventId", or pass "note" ({ title, text }) and YRM records the note first and cites it. Nothing was written.';

function describeWrite(p: Static<typeof RecordParams>): string {
  const cite = p.eventId !== undefined ? `citing event ${p.eventId}` : p.note ? `citing a new note "${p.note.title}"` : "";
  return `${p.statement}\n[${p.type}/${p.predicate}] about ${p.subject}${p.object ? ` and ${p.object}` : ""}, ${cite}`;
}

async function approved(ctx: PiContext, p: Static<typeof RecordParams>): Promise<boolean> {
  if (ctx.hasUI) return ctx.ui.confirm("Record this fact in YRM?", describeWrite(p));
  return p.confirm === true;
}

function recordFactTool(lazy: LazyHost): PiToolDefinition {
  return {
    name: "yrm_record_fact",
    label: "YRM record fact",
    description:
      "Record a fact the user told you as a human-origin correction or addition (confidence 1; it outranks model facts and " +
      "survives re-extraction). It must cite the event it rests on: pass `eventId`, or `note` to record what the user said first. " +
      "To correct a fact, pass its id as `supersedes`. The user is asked to approve the write.",
    parameters: RecordParams,
    exposure: "direct",
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
    async execute(_id, raw, _signal, _onUpdate, ctx) {
      const p = paramsOf<Static<typeof RecordParams>>(raw);
      if (p.eventId === undefined && p.note === undefined) throw new YrmError("YRM_EVENT_REQUIRED", EVENT_REQUIRED);
      const host = await lazy.get();
      const subject = await lookupOne(host, p.subject, "subject");
      const object = p.object !== undefined ? await lookupOne(host, p.object, "object") : undefined;
      if (!(await approved(ctx, p))) {
        throw new YrmError(
          "CONFIRMATION_REQUIRED",
          ctx.hasUI
            ? "The user declined; nothing was written."
            : 'No interactive UI to ask the user: show them the fact, get approval, then call again with "confirm": true. Nothing was written.',
        );
      }

      let eventId = p.eventId;
      let note: unknown = null;
      if (eventId === undefined && p.note) {
        const about = [subject.id, ...(object ? [object.id] : [])];
        note = await runYrmTool(host, "yrm_record_note", {
          title: p.note.title,
          text: p.note.text,
          about,
          ...(p.note.occurredAt !== undefined ? { occurredAt: p.note.occurredAt } : {}),
          confirm: true,
        });
        eventId = (note as { eventId?: string }).eventId;
        if (eventId === undefined) throw new YrmError("YRM_EVENT_REQUIRED", "yrm_record_note returned no eventId; nothing else was written");
      }

      const input: Record<string, unknown> = {
        type: p.type,
        predicate: p.predicate,
        subjectEntityId: subject.id,
        statement: p.statement,
        value: p.value,
        eventId,
        confirm: true,
      };
      if (object) input["objectEntityId"] = object.id;
      for (const k of ["validFrom", "quote", "supersedes"] as const) if (p[k] !== undefined) input[k] = p[k];
      const recorded = await runYrmTool(host, "yrm_record_fact", input);
      return jsonResult({ note, ...(recorded as Record<string, unknown>) });
    },
  };
}

/** The five tools pi gets in in-process mode, with their exposure. */
export function yrmTools(lazy: LazyHost): PiToolDefinition[] {
  return [contextTool(lazy), factsTool(lazy), todayTool(lazy), searchTool(lazy), recordFactTool(lazy)];
}
