import {
  todayIn,
  type ContextRequest,
  type Entity,
  type EntityStatus,
  type Fact,
  type FactQuery,
  type QueueItem,
  type Store,
  type Tool,
  type ToolContext,
} from "@yrm/core";
import {
  byOccurredAsc,
  byOccurredDesc,
  clampLimit,
  EventCache,
  formatEntity,
  formatEvent,
  formatFacts,
  type EntityOut,
  type FactOut,
} from "./format.ts";
import type { HostBinding } from "./host.ts";
import { asInput, optBool, optDate, optNum, optStr, optStrArray, optTime, str, ToolInputError } from "./input.ts";
import { openItems, type OpenItem } from "./open-items.ts";
import { ATTENTION_NS } from "./dismiss.ts";

const ENTITY_FACTS_LIMIT = 30;
const ENTITY_EVENTS_LIMIT = 10;
const EVIDENCE_LIMIT = 5;
const DEFAULT_CONTEXT_BUDGET = 2000;
const EVENTS_NOTE =
  "Raw event text, truncated to 1500 characters. Prefer yrm_facts: facts are extracted, deduplicated, carry provenance and respect corrections. Read events to check a quote or when no fact covers the question.";

const LIMIT_PROP = { type: "integer", description: "Maximum rows to return (default 50, max 200)." };
const ENTITY_STATUSES: EntityStatus[] = ["proposed", "confirmed", "rejected", "merged"];

/** Follow merges so callers holding an old id still land on the surviving entity. */
async function canonicalId(store: Store, id: string): Promise<string> {
  return (await store.resolveEntity(id))?.id ?? id;
}

// ---- yrm_search_entities ------------------------------------------------------

function searchEntitiesTool(): Tool {
  return {
    name: "yrm_search_entities",
    description:
      "Find people, organizations and deals by name substring or exact identifier (email address, domain, phone). " +
      "Returns entity ids, identifiers and a summary (first/last seen, event count, open asks and commitments, parentId = organization). " +
      "Start here to turn a name like 'Marcus' or 'acme-robotics.example' into an entity id for the other tools. " +
      "By default only proposed and confirmed entities are returned.",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Name fragment, email address or domain." },
        kind: { type: "string", description: "Entity kind: person, organization, deal, topic." },
        status: { type: "string", enum: ENTITY_STATUSES, description: "Only entities with this status." },
        limit: LIMIT_PROP,
      },
      required: ["query"],
    },
    exposure: "direct",
    readOnly: true,
    async run(raw, ctx) {
      const input = asInput(raw);
      const query = str(input, "query").trim();
      const kind = optStr(input, "kind");
      const statusIn = optStr(input, "status");
      if (statusIn !== undefined && !ENTITY_STATUSES.includes(statusIn as EntityStatus)) {
        throw new ToolInputError(`"status" must be one of ${ENTITY_STATUSES.join(", ")}`);
      }
      const status: EntityStatus[] = statusIn !== undefined ? [statusIn as EntityStatus] : ["proposed", "confirmed"];
      const limit = clampLimit(optNum(input, "limit"));
      const base = { tenantId: ctx.tenantId, status, ...(kind !== undefined ? { kind } : {}) };

      const found = new Map<string, Entity>();
      for (const e of await ctx.store.findEntities({ ...base, identifier: { value: query.toLowerCase() }, limit })) {
        found.set(e.id, e);
      }
      // Identifier hits first: an exact address beats a name that merely contains the text.
      for (const e of await ctx.store.findEntities({ ...base, nameLike: query, limit })) found.set(e.id, e);
      const entities = [...found.values()].slice(0, limit).map(formatEntity);
      return { count: entities.length, entities };
    },
  };
}

// ---- yrm_get_entity -----------------------------------------------------------

export async function getEntityView(
  store: Store,
  tenantId: string,
  id: string,
): Promise<{
  entity: EntityOut;
  mergedFrom: string | null;
  organization: { id: string; name: string; kind: string; status: string } | null;
  facts: FactOut[];
  recentEvents: Array<{ id: string; title: string | null; date: string; kind: string; source: string; threadKey: string | null }>;
}> {
  const entity = (await store.resolveEntity(id)) ?? (await store.getEntity(id));
  if (!entity) throw new ToolInputError(`no entity with id ${id}`);
  const parentId = entity.summary?.parentId;
  const parent = parentId ? await store.resolveEntity(parentId) : null;
  const facts = await store.queryFacts({ tenantId, entityId: entity.id, limit: ENTITY_FACTS_LIMIT });
  const events = (await store.listEvents({ tenantId, entityId: entity.id })).sort(byOccurredDesc).slice(0, ENTITY_EVENTS_LIMIT);
  return {
    entity: formatEntity(entity),
    mergedFrom: entity.id !== id ? id : null,
    organization: parent ? { id: parent.id, name: parent.name, kind: parent.kind, status: parent.status } : null,
    facts: await formatFacts(facts, new EventCache(store)),
    recentEvents: events.map((e) => ({
      id: e.id,
      title: e.content.title ?? null,
      date: e.occurredAt,
      kind: e.kind,
      source: e.source,
      threadKey: e.threadKey ?? null,
    })),
  };
}

function getEntityTool(): Tool {
  return {
    name: "yrm_get_entity",
    description:
      "One entity in full: identifiers, status, its organization, up to 30 facts that are true now and believed now " +
      "(each with provenance: event id, speaker, quote, event title and date; plus validFrom/validTo, recordedAt/retractedAt, confidence and origin), " +
      "and the 10 most recent events it took part in. Merged ids are followed to the surviving entity.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Entity id from yrm_search_entities." } },
      required: ["id"],
    },
    exposure: "direct",
    readOnly: true,
    async run(raw, ctx) {
      return getEntityView(ctx.store, ctx.tenantId, str(asInput(raw), "id"));
    },
  };
}

// ---- yrm_facts ----------------------------------------------------------------

function factsTool(): Tool {
  return {
    name: "yrm_facts",
    description:
      "Query facts, YRM's bi-temporal knowledge. Every fact has two time ranges: " +
      "validFrom..validTo is WORLD time (when it was true), knownAt is BELIEF time (when we could first have known it; for imported mail, when it was received), recordedAt..retractedAt is when YRM wrote the row. " +
      "`validAt` answers 'what was true at T' (e.g. where did Priya work on Aug 20?). " +
      "`asOf` answers 'what did we know at T' (e.g. what did our records say on Aug 20, before we heard she left?). " +
      "Both default to now; set both to replay an earlier view exactly. `includeRetracted` returns superseded and retracted versions too (full history). " +
      "Each fact carries provenance (event id, speaker, quote, event title and date), confidence (0..1, not calibrated) and origin " +
      "(human > model > rule: a human-origin fact is a correction and wins). Types: commitment, ask, decision, objection, signal, role, relationship, attribute.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Facts where this entity is subject or object." },
        type: { type: "string", description: "Fact type, e.g. commitment, ask, objection, relationship, attribute." },
        predicate: { type: "string", description: "Exact predicate, e.g. works_at, committed_to, title." },
        validAt: { type: "string", description: "World time (ISO 8601): only facts true at this moment. Default now." },
        asOf: { type: "string", description: "Belief time (ISO 8601): only facts known by this moment (knownAt) and not yet superseded or retracted then. Default now." },
        includeRetracted: { type: "boolean", description: "Include superseded/retracted versions (ignores asOf)." },
        limit: LIMIT_PROP,
      },
    },
    exposure: "direct",
    readOnly: true,
    async run(raw, ctx) {
      const input = asInput(raw);
      const limit = clampLimit(optNum(input, "limit"));
      const q: FactQuery = { tenantId: ctx.tenantId, limit };
      const entityId = optStr(input, "entityId");
      if (entityId !== undefined) q.entityId = await canonicalId(ctx.store, entityId);
      const type = optStr(input, "type");
      if (type !== undefined) q.type = type;
      const predicate = optStr(input, "predicate");
      if (predicate !== undefined) q.predicate = predicate;
      const validAt = optTime(input, "validAt");
      if (validAt !== undefined) q.validAt = validAt;
      const asOf = optTime(input, "asOf");
      if (asOf !== undefined) q.asOf = asOf;
      const includeRetracted = optBool(input, "includeRetracted");
      if (includeRetracted !== undefined) q.includeRetracted = includeRetracted;
      const facts = await ctx.store.queryFacts(q);
      return {
        validAt: validAt ?? "now",
        asOf: includeRetracted ? "any" : (asOf ?? "now"),
        count: facts.length,
        facts: await formatFacts(facts, new EventCache(ctx.store)),
      };
    },
  };
}

// ---- yrm_events / yrm_thread ----------------------------------------------------

function eventsTool(): Tool {
  return {
    name: "yrm_events",
    description:
      "Raw source events (mail, meetings, notes), newest first, with text truncated to 1500 characters. " +
      "Use to verify a fact's quote or read context no fact covers; prefer yrm_facts for answers.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "Events this entity took part in." },
        threadKey: { type: "string", description: "Events in this thread." },
        since: { type: "string", description: "Only events after this time (ISO 8601)." },
        until: { type: "string", description: "Only events before this time (ISO 8601)." },
        limit: LIMIT_PROP,
      },
    },
    exposure: "deferred",
    readOnly: true,
    async run(raw, ctx) {
      const input = asInput(raw);
      const limit = clampLimit(optNum(input, "limit"));
      const entityId = optStr(input, "entityId");
      const threadKey = optStr(input, "threadKey");
      const since = optTime(input, "since");
      const until = optTime(input, "until");
      const events = await ctx.store.listEvents({
        tenantId: ctx.tenantId,
        ...(entityId !== undefined ? { entityId: await canonicalId(ctx.store, entityId) } : {}),
        ...(threadKey !== undefined ? { threadKey } : {}),
        ...(since !== undefined ? { occurredAfter: since } : {}),
        ...(until !== undefined ? { occurredBefore: until } : {}),
      });
      const page = events.sort(byOccurredDesc).slice(0, limit);
      return { note: EVENTS_NOTE, total: events.length, count: page.length, events: page.map((e) => formatEvent(e)) };
    },
  };
}

function threadTool(): Tool {
  return {
    name: "yrm_thread",
    description:
      "All events in one conversation thread, oldest first, text truncated to 1500 characters each (the latest 50 if longer). " +
      "Thread keys appear on events from yrm_events and yrm_get_entity.",
    inputSchema: {
      type: "object",
      properties: { threadKey: { type: "string", description: "Thread key from an event." } },
      required: ["threadKey"],
    },
    exposure: "deferred",
    readOnly: true,
    async run(raw, ctx) {
      const threadKey = str(asInput(raw), "threadKey");
      const events = (await ctx.store.listEvents({ tenantId: ctx.tenantId, threadKey })).sort(byOccurredAsc);
      const page = events.slice(-clampLimit(undefined));
      return { note: EVENTS_NOTE, threadKey, total: events.length, count: page.length, events: page.map((e) => formatEvent(e)) };
    },
  };
}

// ---- yrm_today ----------------------------------------------------------------

function headlineOf(brief: unknown): string | null {
  if (typeof brief === "string") return brief;
  if (typeof brief === "object" && brief !== null) {
    const h = (brief as Record<string, unknown>)["headline"];
    if (typeof h === "string") return h;
  }
  return null;
}

async function queueItemView(item: QueueItem, store: Store, events: EventCache): Promise<Record<string, unknown>> {
  const facts: Fact[] = [];
  for (const id of item.evidence.factIds.slice(0, EVIDENCE_LIMIT)) {
    const f = await store.getFact(id);
    if (f) facts.push(f);
  }
  const evs: Array<{ id: string; title: string | null; date: string | null }> = [];
  for (const id of item.evidence.eventIds.slice(0, EVIDENCE_LIMIT)) {
    const e = await events.get(id);
    evs.push({ id, title: e?.content.title ?? null, date: e?.occurredAt ?? null });
  }
  return {
    key: item.key,
    action: item.action,
    reason: item.reason,
    score: item.score,
    dueAt: item.dueAt ?? null,
    about: item.about,
    by: item.by,
    evidence: { facts: await formatFacts(facts, events), events: evs },
  };
}

export async function todayView(
  binding: HostBinding,
  ctx: Pick<ToolContext, "store">,
  date: string | undefined,
  limit: number,
): Promise<Record<string, unknown>> {
  const host = binding.require("yrm_today");
  const day = date ?? todayIn(host.config.tenant.timezone);
  const items = await host.rank(day);
  const brief = await ctx.store.kvGet<unknown>(ATTENTION_NS, `brief:${day}`);
  const events = new EventCache(ctx.store);
  const out: Record<string, unknown>[] = [];
  for (const item of items.slice(0, limit)) out.push(await queueItemView(item, ctx.store, events));
  return { date: day, headline: headlineOf(brief), total: items.length, count: out.length, items: out };
}

function todayTool(binding: HostBinding): Tool {
  return {
    name: "yrm_today",
    description:
      "The attention queue for a day: what deserves action (unanswered asks, overdue commitments, silence, meetings with open items), " +
      "highest score first. Each item has an action, a reason a person can check, and its evidence facts (with provenance) and events. " +
      "Includes the day's headline when a brief exists. Dismissed items are hidden (see yrm_dismiss).",
    inputSchema: {
      type: "object",
      properties: {
        date: { type: "string", description: "ISO date (YYYY-MM-DD). Default today in the tenant's timezone." },
        limit: LIMIT_PROP,
      },
    },
    exposure: "direct",
    readOnly: true,
    async run(raw, ctx) {
      const input = asInput(raw);
      return todayView(binding, ctx, optDate(input, "date"), clampLimit(optNum(input, "limit")));
    },
  };
}

// ---- yrm_context --------------------------------------------------------------

function contextTool(binding: HostBinding): Tool {
  return {
    name: "yrm_context",
    description:
      "A token-budgeted context bundle for entities or a thread: who they are, the facts that matter (each citing its source event), " +
      "and open items. This is YRM's context-layer entry point; every installed extension can contribute sections. " +
      "Use it before drafting a reply or preparing a meeting. Set `asOf` to see the bundle as it would have looked at an earlier time.",
    inputSchema: {
      type: "object",
      properties: {
        entityIds: { type: "array", items: { type: "string" }, description: "Entities to cover." },
        threadKey: { type: "string", description: "Cover everyone in this thread." },
        query: { type: "string", description: "What you are working on, for relevance." },
        budget: { type: "integer", description: "Token budget for the whole bundle (default 2000)." },
        asOf: { type: "string", description: "Build the bundle as of this time (ISO 8601). Default now." },
      },
    },
    exposure: "direct",
    readOnly: true,
    async run(raw) {
      const input = asInput(raw);
      const host = binding.require("yrm_context");
      const request: ContextRequest = { budget: Math.max(100, Math.floor(optNum(input, "budget") ?? DEFAULT_CONTEXT_BUDGET)) };
      const entityIds = optStrArray(input, "entityIds");
      if (entityIds !== undefined) request.entityIds = entityIds;
      const threadKey = optStr(input, "threadKey");
      if (threadKey !== undefined) request.threadKey = threadKey;
      const query = optStr(input, "query");
      if (query !== undefined) request.query = query;
      const asOf = optTime(input, "asOf");
      if (asOf !== undefined) request.asOf = asOf;
      if (!request.entityIds?.length && !request.threadKey) {
        throw new ToolInputError('give "entityIds" or "threadKey"');
      }
      const bundle = await host.buildContext(request);
      return { tokens: bundle.tokens, budget: request.budget, sections: bundle.sections };
    },
  };
}

// ---- yrm_open_items -----------------------------------------------------------

function openItemsTool(): Tool {
  return {
    name: "yrm_open_items",
    description:
      "Everything still open: unanswered asks, open and overdue commitments (with due dates), and unresolved objections, " +
      "for one entity, for an organization and its people (orgId), or across everything. Each item is a fact with provenance.",
    inputSchema: {
      type: "object",
      properties: {
        entityId: { type: "string", description: "One person, organization or deal." },
        orgId: { type: "string", description: "An organization: includes facts about everyone whose parent is this org." },
      },
    },
    exposure: "direct",
    readOnly: true,
    async run(raw, ctx) {
      const input = asInput(raw);
      const entityId = optStr(input, "entityId");
      const orgId = optStr(input, "orgId");
      let ids: string[] | undefined;
      if (entityId !== undefined || orgId !== undefined) {
        const set = new Set<string>();
        if (entityId !== undefined) set.add(await canonicalId(ctx.store, entityId));
        if (orgId !== undefined) {
          const org = await canonicalId(ctx.store, orgId);
          set.add(org);
          for (const p of await ctx.store.findEntities({ tenantId: ctx.tenantId, parentId: org })) {
            if (p.status !== "merged" && p.status !== "rejected") set.add(p.id);
          }
        }
        ids = [...set];
      }
      const items = await openItems(ctx.store, ctx.tenantId, ids);
      const events = new EventCache(ctx.store);
      const view = async (list: OpenItem[]): Promise<FactOut[]> =>
        formatFacts(
          list.slice(0, clampLimit(undefined)).map((i) => i.fact),
          events,
        );
      const of = (kind: OpenItem["kind"], overdue?: boolean): OpenItem[] =>
        items.filter((i) => i.kind === kind && (overdue === undefined || i.overdue === overdue));
      return {
        counts: {
          asks: of("ask").length,
          commitmentsOpen: of("commitment", false).length,
          commitmentsOverdue: of("commitment", true).length,
          objections: of("objection").length,
        },
        asks: await view(of("ask")),
        commitments: { overdue: await view(of("commitment", true)), open: await view(of("commitment", false)) },
        objections: await view(of("objection")),
      };
    },
  };
}

export function readTools(binding: HostBinding): Tool[] {
  return [
    searchEntitiesTool(),
    getEntityTool(),
    factsTool(),
    eventsTool(),
    threadTool(),
    todayTool(binding),
    contextTool(binding),
    openItemsTool(),
  ];
}
