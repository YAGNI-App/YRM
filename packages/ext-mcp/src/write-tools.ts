import {
  hookContext,
  newId,
  YrmError,
  type Entity,
  type EntityRef,
  type NewFact,
  type NewSourceEvent,
  type Participant,
  type SourceAdapter,
  type Store,
  type Tool,
  type ToolContext,
} from "@yrm/core";
import { dismiss } from "./dismiss.ts";
import { EventCache, formatEntity, formatFact } from "./format.ts";
import type { HostBinding } from "./host.ts";
import { asInput, optDate, optStr, optStrArray, optTime, str, ToolInputError, type Input } from "./input.ts";

/** Version stamped on facts this extension records, so they can be audited later. */
export const ORIGIN_VERSION = "mcp/1";
export const DEFAULT_PRINCIPAL = "agent:mcp";
/** Source name for notes written through MCP. */
export const NOTE_SOURCE = "mcp";

export interface WriteSettings {
  /** Skip the `confirm: true` requirement. For trusted, non-interactive agents only. */
  unattendedWrites: boolean;
}

const CONFIRM_PROP = {
  type: "boolean",
  description: "Must be true. Ask the user before calling: this writes to the shared record every agent reads.",
};

export class ConfirmationRequiredError extends YrmError {
  constructor(tool: string) {
    super(
      "CONFIRMATION_REQUIRED",
      `${tool} writes to YRM and needs explicit confirmation. MCP cannot prompt the user, so: show the user exactly what you are about to record, ` +
        `get their approval, then call ${tool} again with "confirm": true. Nothing was written.`,
    );
  }
}

function requireConfirm(tool: string, input: Input, settings: () => WriteSettings): void {
  if (settings().unattendedWrites) return;
  if (input["confirm"] !== true) throw new ConfirmationRequiredError(tool);
}

function principalOf(ctx: ToolContext): string {
  return ctx.principal ?? DEFAULT_PRINCIPAL;
}

async function requireEntity(store: Store, id: string, field: string): Promise<Entity> {
  const e = await store.resolveEntity(id);
  if (!e) throw new ToolInputError(`"${field}": no entity with id ${id}`);
  return e;
}

function ref(e: Entity): EntityRef {
  return { entityId: e.id, name: e.name };
}

/**
 * A source that never pulls. Notes arrive one at a time from `yrm_record_note`;
 * registering it keeps `yrm doctor` and the `kinds` documentation honest.
 */
export function noteSource(): SourceAdapter {
  return {
    name: NOTE_SOURCE,
    description: "Notes written by agents and people through the MCP server.",
    kinds: ["note"],
    async sync() {},
  };
}

// ---- yrm_record_fact ------------------------------------------------------------

function recordFactTool(binding: HostBinding, settings: () => WriteSettings): Tool {
  return {
    name: "yrm_record_fact",
    description:
      "Record a fact as a human-confirmed correction or addition (origin human, confidence 1). Human facts outrank model and rule facts " +
      "and are never overturned by re-extraction. Must cite the event it rests on (`eventId`); if there is no such event, " +
      "first write one with yrm_record_note and cite its id. To correct an existing fact, pass its id as `supersedes`. " +
      "Requires confirm: true (ask the user first).",
    inputSchema: {
      type: "object",
      properties: {
        type: { type: "string", description: "commitment, ask, decision, objection, signal, role, relationship or attribute." },
        predicate: { type: "string", description: "snake_case verb, e.g. works_at, title, committed_to." },
        subjectEntityId: { type: "string", description: "What the fact is about." },
        objectEntityId: { type: "string", description: "The other party, when there is one." },
        statement: { type: "string", description: "One sentence a person can read." },
        value: { description: "Structured payload; shape depends on type (e.g. commitment: {what, dueAt, status})." },
        validFrom: { type: "string", description: "When it became true in the world (ISO 8601). Default: the cited event's date." },
        eventId: { type: "string", description: "Event this fact rests on. Required." },
        quote: { type: "string", description: "Verbatim words from the event supporting the fact." },
        supersedes: { type: "string", description: "Id of the fact this one replaces." },
        confirm: CONFIRM_PROP,
      },
      required: ["type", "predicate", "subjectEntityId", "statement", "value", "eventId"],
    },
    exposure: "direct",
    readOnly: false,
    async run(raw, ctx) {
      const input = asInput(raw);
      requireConfirm("yrm_record_fact", input, settings);
      const eventId = optStr(input, "eventId");
      if (eventId === undefined) {
        throw new ToolInputError(
          '"eventId" is required: every fact must rest on an event. Write a note with yrm_record_note and cite the returned eventId.',
        );
      }
      const event = await ctx.store.getEvent(eventId);
      if (!event) throw new ToolInputError(`"eventId": no event with id ${eventId}`);
      if (!("value" in input)) throw new ToolInputError('"value" is required');

      const subject = await requireEntity(ctx.store, str(input, "subjectEntityId"), "subjectEntityId");
      const objectId = optStr(input, "objectEntityId");
      const object = objectId !== undefined ? await requireEntity(ctx.store, objectId, "objectEntityId") : undefined;
      const quote = optStr(input, "quote");
      const supersedes = optStr(input, "supersedes");

      const fact: NewFact = {
        tenantId: ctx.tenantId,
        type: str(input, "type"),
        predicate: str(input, "predicate"),
        subject: ref(subject),
        value: input["value"],
        statement: str(input, "statement"),
        validFrom: optTime(input, "validFrom") ?? event.occurredAt,
        provenance: [{ eventId, ...(quote !== undefined ? { quote } : {}) }],
        confidence: 1,
        origin: { kind: "human", by: principalOf(ctx), version: ORIGIN_VERSION },
      };
      if (object) fact.object = ref(object);
      if (supersedes !== undefined) fact.supersedes = supersedes;

      const recorded = await ctx.store.recordFact(fact);
      const host = binding.current;
      if (host) {
        await host.hooks.emit("fact:recorded", hookContext(host), recorded);
        await host.project([subject.id, ...(object ? [object.id] : [])]);
      }
      return { recorded: await formatFact(recorded, new EventCache(ctx.store)) };
    },
  };
}

// ---- yrm_record_note ------------------------------------------------------------

function recordNoteTool(binding: HostBinding, settings: () => WriteSettings): Tool {
  return {
    name: "yrm_record_note",
    description:
      "Append a note event to the log (source mcp, kind note), authored by the caller and mentioning the given entities. " +
      "Returns the event id, which yrm_record_fact can cite as provenance. Events are never edited; write a new note to correct one. " +
      "Requires confirm: true (ask the user first).",
    inputSchema: {
      type: "object",
      properties: {
        title: { type: "string", description: "Short heading." },
        text: { type: "string", description: "The note body." },
        about: { type: "array", items: { type: "string" }, description: "Entity ids the note is about." },
        occurredAt: { type: "string", description: "When what the note describes happened (ISO 8601). Default now." },
        confirm: CONFIRM_PROP,
      },
      required: ["title", "text", "about"],
    },
    exposure: "direct",
    readOnly: false,
    async run(raw, ctx) {
      const input = asInput(raw);
      requireConfirm("yrm_record_note", input, settings);
      const host = binding.require("yrm_record_note");
      const about = optStrArray(input, "about") ?? [];
      const entities: Entity[] = [];
      for (const id of about) {
        const e = await requireEntity(ctx.store, id, "about");
        if (!entities.some((x) => x.id === e.id)) entities.push(e);
      }
      const principal = principalOf(ctx);
      const participants: Participant[] = [
        { role: "author", name: principal },
        ...entities.map((e): Participant => ({ role: "mentioned", name: e.name })),
      ];
      const noteId = newId();
      const note: NewSourceEvent = {
        tenantId: ctx.tenantId,
        source: NOTE_SOURCE,
        kind: "note",
        externalId: `mcp:${noteId}`,
        occurredAt: optTime(input, "occurredAt") ?? new Date().toISOString(),
        participants,
        content: { title: str(input, "title"), text: str(input, "text") },
        meta: { principal },
      };

      // Go through the host's ingest path with a one-shot adapter so
      // ingest:before/ingest:after hooks see the note like any other event.
      const result = await host.ingest({
        name: NOTE_SOURCE,
        kinds: ["note"],
        async sync(sctx) {
          await sctx.emit([note]);
        },
      });
      const event = result.events[0];
      if (!event) {
        throw new YrmError("NOTE_DROPPED", "the note was not appended: an ingest:before hook dropped it");
      }
      // We already know who the note is about, so link mentions directly rather than asking a resolver to guess from names.
      const links = entities.map((e, i) => ({ index: i + 1, entityId: e.id }));
      if (links.length > 0) await ctx.store.setParticipantEntities(event.id, links);
      if (entities.length > 0) await host.project(entities.map((e) => e.id));
      return {
        eventId: event.id,
        occurredAt: event.occurredAt,
        about: entities.map((e) => ({ id: e.id, name: e.name })),
        next: "Cite this eventId in yrm_record_fact to record what the note establishes.",
      };
    },
  };
}

// ---- entity curation ------------------------------------------------------------

function setStatusTool(
  binding: HostBinding,
  settings: () => WriteSettings,
  name: "yrm_confirm_entity" | "yrm_reject_entity",
): Tool {
  const confirming = name === "yrm_confirm_entity";
  return {
    name,
    description: confirming
      ? "Confirm a proposed entity: a person agrees it is a real person, organization or deal. Re-ingestion never undoes it. Requires confirm: true."
      : "Reject a proposed entity (not a real person or organization, e.g. a mailing list). Re-ingestion never undoes it. Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string", description: "Entity id." }, confirm: CONFIRM_PROP },
      required: ["id"],
    },
    exposure: "direct",
    readOnly: false,
    async run(raw, ctx) {
      const input = asInput(raw);
      requireConfirm(name, input, settings);
      const id = str(input, "id");
      const entity = await ctx.store.getEntity(id);
      if (!entity) throw new ToolInputError(`no entity with id ${id}`);
      if (entity.status === "merged") {
        throw new ToolInputError(`entity ${id} was merged into ${entity.mergedInto ?? "another entity"}; act on that one`);
      }
      const updated = await ctx.store.updateEntity(id, { status: confirming ? "confirmed" : "rejected" });
      const host = binding.current;
      if (host && confirming) await host.hooks.emit("entity:confirmed", hookContext(host), updated);
      return { entity: formatEntity(updated), by: principalOf(ctx) };
    },
  };
}

function mergeTool(binding: HostBinding, settings: () => WriteSettings): Tool {
  return {
    name: "yrm_merge_entities",
    description:
      "Merge two entities that are the same person or organization (e.g. one person seen under a work and a personal address). " +
      "`from` stops existing as its own entity; identifiers, facts and event links move to `into`. Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        from: { type: "string", description: "Entity id that disappears." },
        into: { type: "string", description: "Entity id that survives." },
        confirm: CONFIRM_PROP,
      },
      required: ["from", "into"],
    },
    exposure: "direct",
    readOnly: false,
    async run(raw, ctx) {
      const input = asInput(raw);
      requireConfirm("yrm_merge_entities", input, settings);
      const fromId = str(input, "from");
      const before = await ctx.store.getEntity(fromId);
      if (!before) throw new ToolInputError(`"from": no entity with id ${fromId}`);
      const into = await ctx.store.mergeEntities(fromId, str(input, "into"), principalOf(ctx));
      const host = binding.current;
      if (host) {
        const from = (await ctx.store.getEntity(fromId)) ?? before;
        await host.hooks.emit("entity:merged", hookContext(host), from, into);
        await host.project([into.id]);
      }
      return { merged: fromId, into: formatEntity(into), by: principalOf(ctx) };
    },
  };
}

// ---- yrm_dismiss ------------------------------------------------------------------

function dismissTool(settings: () => WriteSettings): Tool {
  return {
    name: "yrm_dismiss",
    description:
      "Hide an attention-queue item (by its key from yrm_today), optionally until a date when it may come back. Requires confirm: true.",
    inputSchema: {
      type: "object",
      properties: {
        key: { type: "string", description: "Queue item key from yrm_today." },
        until: { type: "string", description: "ISO date (YYYY-MM-DD) the item may reappear. Omit to hide it for good." },
        confirm: CONFIRM_PROP,
      },
      required: ["key"],
    },
    exposure: "direct",
    readOnly: false,
    async run(raw, ctx) {
      const input = asInput(raw);
      requireConfirm("yrm_dismiss", input, settings);
      const key = str(input, "key");
      const until = optDate(input, "until") ?? null;
      await dismiss(ctx.store, { key, until, by: principalOf(ctx), at: new Date().toISOString() });
      return { dismissed: key, until };
    },
  };
}

export function writeTools(binding: HostBinding, settings: () => WriteSettings): Tool[] {
  return [
    recordFactTool(binding, settings),
    recordNoteTool(binding, settings),
    setStatusTool(binding, settings, "yrm_confirm_entity"),
    setStatusTool(binding, settings, "yrm_reject_entity"),
    mergeTool(binding, settings),
    dismissTool(settings),
  ];
}
