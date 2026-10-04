import type { ContextBundle, ContextRequest, Entity, Fact, HookContext, Store, Tool, ViewDefinition } from "@yrm/core";
import { activeViews, appliesTo } from "./definitions.ts";
import type { ViewEngine } from "./populate.ts";
import { currentValues, displayValue, getStatus } from "./values.ts";

export interface ViewValueOut {
  name: string;
  description: string | null;
  valueType: string | null;
  populatedBy: string | null;
  /** null when not computed; see `status`. */
  value: unknown;
  display: string | null;
  confidence: number | null;
  origin: Fact["origin"] | null;
  factId: string | null;
  validFrom: string | null;
  recordedAt: string | null;
  provenance: Array<{ eventId: string; quote: string | null }>;
  /** Why there is no value, when there is none. */
  status: string | null;
}

/** Defined views for the entity's kind with their current values, plus values whose definition was dropped. */
export async function viewValues(store: Store, tenantId: string, entity: Entity, engine?: ViewEngine): Promise<ViewValueOut[]> {
  const views = (await activeViews(store, tenantId)).filter((v) => appliesTo(v, entity));
  const values = await currentValues(store, tenantId, entity.id);
  const blocker = engine?.modelBlocker();
  const out: ViewValueOut[] = [];
  const row = (name: string, def: ViewDefinition | undefined, f: Fact | undefined, status: string | null): ViewValueOut => ({
    name,
    description: def?.description ?? null,
    valueType: def?.valueType ?? null,
    populatedBy: def?.populatedBy ?? null,
    value: f?.value ?? null,
    display: f ? displayValue(f.value) : null,
    confidence: f?.confidence ?? null,
    origin: f?.origin ?? null,
    factId: f?.id ?? null,
    validFrom: f?.validFrom ?? null,
    recordedAt: f?.recordedAt ?? null,
    provenance: f ? f.provenance.map((p) => ({ eventId: p.eventId, quote: p.quote ?? null })) : [],
    status,
  });
  for (const v of views) {
    const f = values.get(v.name);
    if (f) {
      out.push(row(v.name, v, f, null));
      continue;
    }
    const s = await getStatus(store, entity.id, v.name);
    out.push(row(v.name, v, undefined, `not computed: ${v.populatedBy === "model" && blocker ? blocker : (s?.reason ?? "not backfilled yet")}`));
  }
  const defined = new Set(views.map((v) => v.name));
  for (const [name, f] of values) if (!defined.has(name)) out.push(row(name, undefined, f, null));
  return out;
}

export function viewsTool(engine: ViewEngine): Tool {
  return {
    name: "yrm_views",
    description:
      "Current view values for one entity: user-defined fields such as economic_buyer, deal_stage or last_contact, " +
      "each with confidence, origin (human values outrank model and rule ones) and the events it rests on. " +
      "Views with no value say why (no model route, no evidence). Read-only.",
    inputSchema: {
      type: "object",
      properties: { entityId: { type: "string", description: "Entity id, e.g. from yrm_search_entities." } },
      required: ["entityId"],
    },
    exposure: "direct",
    readOnly: true,
    async run(raw, ctx) {
      const entityId = typeof raw === "object" && raw !== null ? (raw as Record<string, unknown>)["entityId"] : undefined;
      if (typeof entityId !== "string" || entityId.trim() === "") throw new Error('"entityId" is required');
      const entity = await ctx.store.resolveEntity(entityId);
      if (!entity || entity.tenantId !== ctx.tenantId) throw new Error(`no entity with id ${entityId}`);
      return {
        entity: { id: entity.id, name: entity.name, kind: entity.kind },
        views: await viewValues(ctx.store, ctx.tenantId, entity, engine),
      };
    },
  };
}

/** `context:build`: one "Views" section with the current values for the requested entities. */
export async function contextSection(ctx: HookContext, request: ContextRequest, draft: ContextBundle): Promise<ContextBundle | undefined> {
  const ids = new Set(request.entityIds ?? []);
  if (request.threadKey) {
    for (const e of await ctx.store.listEvents({ tenantId: ctx.tenantId, threadKey: request.threadKey })) {
      for (const p of e.participants) if (p.entityId && !p.self) ids.add(p.entityId);
    }
  }
  const lines: string[] = [];
  const factIds: string[] = [];
  const seen = new Set<string>();
  for (const id of ids) {
    const entity = await ctx.store.resolveEntity(id);
    if (!entity || seen.has(entity.id)) continue;
    seen.add(entity.id);
    for (const [name, f] of await currentValues(ctx.store, ctx.tenantId, entity.id, request.asOf)) {
      const ev = f.provenance.map((p) => p.eventId).slice(0, 3).join(", ");
      lines.push(`- ${entity.name} · ${name}: ${displayValue(f.value)} (${f.origin.kind}, confidence ${f.confidence.toFixed(2)}, source: ${ev})`);
      factIds.push(f.id);
    }
  }
  if (lines.length === 0) return undefined;
  const section = { title: "Views", text: lines.join("\n"), factIds };
  return { ...draft, sections: [...draft.sections, section] };
}
