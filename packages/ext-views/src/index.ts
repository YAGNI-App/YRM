import type { Entity, ExtensionAPI, ExtensionManifest, Fact } from "@yrm/core";
import { viewCommand } from "./commands.ts";
import { PREDICATE_PREFIX, VIEWS, activeViews, appliesTo, applyDefinitions, readSettings } from "./definitions.ts";
import { ViewEngine } from "./populate.ts";
import { BUILTIN_RULES, RULE_TOPIC, type ViewRule } from "./rules.ts";
import { contextSection, viewsTool } from "./tool.ts";

export const manifest: ExtensionManifest = {
  name: VIEWS,
  version: "0.1.0",
  description: "Views: fields described in English, stored as attribute facts, populated by rules or the extract tier.",
};

/**
 * Wiring:
 * - `host:start` applies the built-in rule views and `settings.views.definitions`.
 * - `resolve:after` and `fact:recorded` mark touched entities; `host:stop`
 *   recomputes their views once each (the debounce is "once per entity per run").
 * - `context:build` adds a Views section; `yrm_views` reads values; `yrm view` manages them.
 *
 * Other extensions add rule views by emitting `{ name, rule }` on the
 * `views:rule` topic from their factory, then defining the view.
 */
export default function views(yrm: ExtensionAPI): void {
  const settings = readSettings(yrm.config.get<Record<string, unknown>>());
  const rules = new Map<string, ViewRule>(BUILTIN_RULES.map((b) => [b.def.name, b.rule]));
  yrm.events.on(RULE_TOPIC, (payload) => {
    const p = payload as { name?: unknown; rule?: unknown } | null;
    if (p && typeof p.name === "string" && typeof p.rule === "function") rules.set(p.name, p.rule as ViewRule);
    else yrm.log.warn(`ignoring malformed ${RULE_TOPIC} payload`);
  });
  const tenantId = yrm.config.tenantId;
  const engine = new ViewEngine({
    store: yrm.store,
    models: yrm.models,
    tenantId,
    tenant: yrm.config.tenant,
    settings,
    rules,
    log: yrm.log,
  });
  const touched = new Set<string>();

  yrm.on("host:start", async (ctx) => {
    engine.reset();
    touched.clear();
    const defs = [
      ...BUILTIN_RULES.map((b) => ({ def: b.def, from: "builtin" })),
      ...settings.definitions.map((def) => ({ def, from: "settings.views.definitions" })),
    ];
    const applied = await applyDefinitions(ctx.store, tenantId, defs, new Set(rules.keys()), ctx.log);
    if (applied.length > 0) ctx.log.debug("views defined", { views: applied });
  });

  if (settings.incremental !== "off") {
    yrm.on("resolve:after", async (_ctx, _event, entities) => {
      for (const e of entities) touched.add(e.id);
    });
    yrm.on("fact:recorded", async (_ctx, fact) => {
      // Our own facts never come through here, but another extension's view facts might.
      if (fact.predicate.startsWith(PREDICATE_PREFIX)) return;
      markFact(touched, fact);
    });
    yrm.on("host:stop", async (ctx) => {
      if (touched.size === 0) return;
      const ids = [...touched];
      touched.clear();
      try {
        await recompute(engine, ids, settings.incremental === "rules");
      } catch (err) {
        ctx.log.warn(`incremental view update failed: ${err instanceof Error ? err.message : String(err)}`);
      }
    });
  }

  yrm.on("context:build", contextSection);
  yrm.registerTool(viewsTool(engine));
  yrm.registerCommand(
    viewCommand({
      engine,
      ruleNames: () => new Set(rules.keys()),
      principal: `user:${yrm.config.tenant.selfAddresses[0] ?? "local"}`,
    }),
  );
}

function markFact(touched: Set<string>, fact: Fact): void {
  touched.add(fact.subject.entityId);
  if (fact.object) touched.add(fact.object.entityId);
}

/**
 * Recompute every applicable view for the touched entities and, for people,
 * their organization (an org's views read its people's facts and events).
 */
export async function recompute(engine: ViewEngine, entityIds: Iterable<string>, rulesOnly = false): Promise<number> {
  const { store, tenantId } = engine.deps;
  const defs = (await activeViews(store, tenantId)).filter((d) => !rulesOnly || d.populatedBy === "rule");
  if (defs.length === 0) return 0;
  const entities = new Map<string, Entity>();
  for (const id of entityIds) {
    const e = await store.resolveEntity(id);
    if (!e || e.status === "rejected") continue;
    entities.set(e.id, e);
    const parent = e.summary?.parentId ? await store.resolveEntity(e.summary.parentId) : null;
    if (parent && parent.status !== "rejected") entities.set(parent.id, parent);
  }
  let n = 0;
  for (const e of entities.values()) {
    for (const def of defs) {
      if (!appliesTo(def, e)) continue;
      const o = await engine.compute(def, e);
      if (o.state === "recorded") n++;
    }
  }
  return n;
}

export { viewCommand, findEntities, USAGE, type CommandDeps } from "./commands.ts";
export * from "./definitions.ts";
export { setByHuman, type HumanSetResult } from "./human.ts";
export {
  buildPrompt,
  checkAnswer,
  MODEL_CONFIDENCE_CAP,
  MODEL_MAX_TOKENS,
  schemaFor,
  SYSTEM_V1,
  ViewEngine,
  type EngineDeps,
  type Outcome,
  type Prompt,
} from "./populate.ts";
export { BUILTIN_RULES, lastContact, openItems, RULE_CONFIDENCE, RULE_TOPIC, type RuleInput, type RuleResult, type ViewRule } from "./rules.ts";
export { contextSection, viewValues, viewsTool, type ViewValueOut } from "./tool.ts";
export * from "./values.ts";
