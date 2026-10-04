import type { Command, CommandContext, Entity, Fact, Store, ViewDefinition } from "@yrm/core";
import {
  VIEW_KINDS,
  ViewDefinitionError,
  activeViews,
  appliesTo,
  dropView,
  findView,
  saveView,
  validateDefinition,
  viewNameOf,
} from "./definitions.ts";
import { setByHuman } from "./human.ts";
import { MODEL_MAX_TOKENS, type Outcome, type ViewEngine } from "./populate.ts";
import { currentValues, displayValue, getStatus } from "./values.ts";

export const USAGE = [
  "yrm view <subcommand>",
  '  define <name> --for person|organization|deal --type string|number|boolean|date|enum|entity|json [--enum a,b,c] [--by rule|model] [--force] "<description>"',
  "  list                                  every defined view",
  "  show <entity> [--kind person|organization]   current values with provenance, and why any are empty",
  "  backfill <name> [--limit N] [--dry-run]       compute a view for every entity it applies to",
  "  set <entity> <name> <value>           set a value by hand (human origin; models never override it)",
  "  drop <name>                           remove the definition; its facts stay, visible under `yrm facts`",
].join("\n");

export interface CommandDeps {
  engine: ViewEngine;
  /** Rule functions registered right now, for define validation. */
  ruleNames: () => ReadonlySet<string>;
  /** Who `view set` records as the human origin. */
  principal: string;
}

function str(flags: CommandContext["flags"], ...names: string[]): string | undefined {
  for (const n of names) {
    const v = flags[n];
    if (typeof v === "string") return v;
  }
  return undefined;
}

function pad(rows: string[][]): string[] {
  const widths: number[] = [];
  for (const r of rows) r.forEach((c, i) => (widths[i] = Math.max(widths[i] ?? 0, c.length)));
  return rows.map((r) => r.map((c, i) => (i === r.length - 1 ? c : c.padEnd(widths[i]!))).join("  ").trimEnd());
}

/** Find an entity by id, email or domain, or name substring. */
export async function findEntities(store: Store, tenantId: string, query: string, kind?: string): Promise<Entity[]> {
  const out = new Map<string, Entity>();
  const add = async (e: Entity): Promise<void> => {
    const live = e.status === "merged" ? ((await store.resolveEntity(e.id)) ?? e) : e;
    if (live.status !== "rejected" && (kind === undefined || live.kind === kind)) out.set(live.id, live);
  };
  const byId = await store.getEntity(query);
  if (byId && byId.tenantId === tenantId) await add(byId);
  if (out.size > 0) return [...out.values()];
  for (const e of await store.findEntities({ tenantId, identifier: { value: query.trim().toLowerCase() } })) await add(e);
  if (out.size > 0) return [...out.values()];
  const named = await store.findEntities({ tenantId, nameLike: query.trim(), limit: 50 });
  const exact = named.filter((e) => e.name.toLowerCase() === query.trim().toLowerCase());
  for (const e of exact.length > 0 ? exact : named) await add(e);
  return [...out.values()];
}

async function oneEntity(ctx: CommandContext, query: string): Promise<Entity | undefined> {
  const kind = str(ctx.flags, "kind");
  const found = await findEntities(ctx.store, ctx.tenantId, query, kind);
  if (found.length === 0) {
    ctx.stderr(`no ${kind ?? "entity"} matches "${query}"`);
    return undefined;
  }
  if (found.length > 1) {
    ctx.stderr(`"${query}" matches ${found.length} entities; pass an id or --kind:`);
    for (const e of found) ctx.stderr(`  ${e.id}  ${e.kind}  ${e.name}`);
    return undefined;
  }
  return found[0];
}

function originLabel(f: Fact): string {
  return `${f.origin.kind}:${f.origin.by}${f.origin.model ? ` (${f.origin.model})` : ""}`;
}

export function viewCommand(deps: CommandDeps): Command {
  return {
    name: "view",
    description: "Define, compute and inspect views: fields described in English, stored as facts",
    usage: USAGE,
    async run(ctx) {
      const [sub, ...rest] = ctx.args;
      switch (sub) {
        case "define":
          return define(ctx, rest, deps);
        case "list":
          return list(ctx, deps);
        case "show":
          return show(ctx, rest, deps);
        case "backfill":
          return backfill(ctx, rest, deps);
        case "set":
          return set(ctx, rest, deps);
        case "drop":
          return drop(ctx, rest);
        default:
          ctx.stderr(sub ? `unknown subcommand "${sub}"` : "missing subcommand");
          ctx.stderr(`usage: ${USAGE}`);
          return 1;
      }
    },
  };
}

async function define(ctx: CommandContext, args: string[], deps: CommandDeps): Promise<number> {
  const [name, ...words] = args;
  const description = str(ctx.flags, "description") ?? words.join(" ");
  const kinds = str(ctx.flags, "for", "applies-to");
  if (!name || !kinds || !str(ctx.flags, "type")) {
    ctx.stderr('usage: yrm view define <name> --for person|organization|deal --type <type> [--enum a,b,c] [--by rule|model] "<description>"');
    return 1;
  }
  const unknownKind = kinds.split(",").map((k) => k.trim()).find((k) => !(VIEW_KINDS as readonly string[]).includes(k));
  if (unknownKind) {
    ctx.stderr(`--for must be ${VIEW_KINDS.join(", ")} (comma-separated for several); got "${unknownKind}"`);
    return 1;
  }
  const enumRaw = str(ctx.flags, "enum");
  let def: ViewDefinition;
  try {
    def = validateDefinition(
      {
        name,
        appliesTo: kinds,
        description,
        valueType: str(ctx.flags, "type"),
        populatedBy: str(ctx.flags, "by") ?? "model",
        ...(enumRaw !== undefined ? { enumValues: enumRaw.split(",") } : {}),
      },
      deps.ruleNames(),
    );
  } catch (err) {
    if (err instanceof ViewDefinitionError) {
      ctx.stderr(err.message);
      return 1;
    }
    throw err;
  }
  const existing = await findView(ctx.store, ctx.tenantId, def.name);
  if (existing && ctx.flags["force"] !== true) {
    ctx.stderr(`view "${def.name}" already exists (${existing.valueType} on ${existing.appliesTo}); pass --force to redefine it`);
    return 1;
  }
  await saveView(ctx.store, ctx.tenantId, def);
  ctx.stdout(`${existing ? "redefined" : "defined"} ${def.name}: ${def.valueType}${def.enumValues ? ` (${def.enumValues.join(" | ")})` : ""} on ${def.appliesTo}, by ${def.populatedBy}`);
  ctx.stdout(`next: yrm view backfill ${def.name} --dry-run`);
  return 0;
}

async function list(ctx: CommandContext, deps: CommandDeps): Promise<number> {
  const views = await activeViews(ctx.store, ctx.tenantId);
  if (views.length === 0) {
    ctx.stdout('no views defined; try: yrm view define economic_buyer --for organization --type entity "the person who controls the budget"');
    return 0;
  }
  const rows = [["name", "for", "type", "by", "description"]];
  for (const v of views) {
    const type = v.valueType === "enum" ? `enum(${(v.enumValues ?? []).join("|")})` : v.valueType;
    rows.push([v.name, v.appliesTo, type, v.populatedBy, v.description]);
  }
  for (const l of pad(rows)) ctx.stdout(l);
  const blocker = deps.engine.modelBlocker();
  if (blocker && views.some((v) => v.populatedBy === "model")) ctx.stdout(`model views are not computed: ${blocker}`);
  return 0;
}

async function show(ctx: CommandContext, args: string[], deps: CommandDeps): Promise<number> {
  const query = args.join(" ");
  if (!query) {
    ctx.stderr("usage: yrm view show <entity> [--kind person|organization]");
    return 1;
  }
  const entity = await oneEntity(ctx, query);
  if (!entity) return 1;
  const views = (await activeViews(ctx.store, ctx.tenantId)).filter((v) => appliesTo(v, entity));
  const values = await currentValues(ctx.store, ctx.tenantId, entity.id);
  ctx.stdout(`${entity.name}  ${entity.kind}  ${entity.id}`);
  const rows = [["view", "value", "conf", "origin", "evidence"]];
  const blocker = deps.engine.modelBlocker();
  for (const v of views) {
    const f = values.get(v.name);
    if (f) {
      rows.push([v.name, displayValue(f.value), f.confidence.toFixed(2), originLabel(f), f.provenance.map((p) => p.eventId).join(", ")]);
      continue;
    }
    const status = await getStatus(ctx.store, entity.id, v.name);
    const why =
      v.populatedBy === "model" && blocker ? blocker
      : status ? status.reason
      : `run \`yrm view backfill ${v.name}\``;
    rows.push([v.name, "-", "", "", `not computed: ${why}`]);
  }
  const defined = new Set(views.map((v) => v.name));
  for (const [name, f] of values) {
    if (defined.has(name)) continue;
    rows.push([`${name} (no definition)`, displayValue(f.value), f.confidence.toFixed(2), originLabel(f), f.provenance.map((p) => p.eventId).join(", ")]);
  }
  if (rows.length === 1) {
    ctx.stdout(`no views apply to ${entity.kind}s; define one with \`yrm view define\``);
    return 0;
  }
  for (const l of pad(rows)) ctx.stdout(`  ${l}`);
  // Quotes are what make a model value checkable; show them under the table.
  for (const [name, f] of values) {
    const q = f.provenance.find((p) => p.quote);
    if (q?.quote && f.origin.kind === "model") ctx.stdout(`  ${name}: "${q.quote}" (${q.eventId})`);
  }
  return 0;
}

function usd(n: number): string {
  return n === 0 ? "$0" : n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

async function backfill(ctx: CommandContext, args: string[], deps: CommandDeps): Promise<number> {
  const name = args[0];
  if (!name) {
    ctx.stderr("usage: yrm view backfill <name> [--limit N] [--dry-run]");
    return 1;
  }
  const def = await findView(ctx.store, ctx.tenantId, name);
  if (!def) {
    ctx.stderr(`no view named "${name}"; see \`yrm view list\``);
    return 1;
  }
  const limitRaw = str(ctx.flags, "limit");
  const limit = limitRaw !== undefined ? Number(limitRaw) : undefined;
  if (limit !== undefined && !(Number.isInteger(limit) && limit > 0)) {
    ctx.stderr("--limit must be a positive integer");
    return 1;
  }
  const dryRun = ctx.flags["dry-run"] !== undefined && ctx.flags["dry-run"] !== false;
  const outcomes = await deps.engine.backfill(def, { dryRun, ...(limit !== undefined ? { limit } : {}) });
  if (outcomes.length === 0) {
    ctx.stdout(`no ${def.appliesTo} entities to compute ${def.name} for`);
    return 0;
  }
  const rows = [["entity", dryRun ? "would" : "result", "value / reason"]];
  for (const o of outcomes) rows.push([o.entity.name, o.state, outcomeDetail(o)]);
  for (const l of pad(rows)) ctx.stdout(l);
  ctx.stdout("");
  ctx.stdout(summary(def, outcomes, deps, dryRun));
  return 0;
}

function outcomeDetail(o: Outcome): string {
  if (o.state === "recorded" || o.state === "unchanged" || (o.state === "would_compute" && o.value !== undefined)) return displayValue(o.value);
  if (o.state === "would_compute" && o.inputTokens !== undefined) return `~${o.inputTokens} input tokens`;
  return o.reason;
}

function summary(def: ViewDefinition, outcomes: Outcome[], deps: CommandDeps, dryRun: boolean): string {
  const count = (s: Outcome["state"]): number => outcomes.filter((o) => o.state === s).length;
  if (def.populatedBy === "rule") {
    return dryRun
      ? `${outcomes.length} entities; rule view, no model calls, $0`
      : `${count("recorded")} recorded, ${count("unchanged")} unchanged, ${count("no_value")} without a value; rule view, $0`;
  }
  const calls = outcomes.filter((o) => o.inputTokens !== undefined && (dryRun || (o.state !== "unavailable" && o.state !== "held_by_human")));
  const input = calls.reduce((n, o) => n + (o.inputTokens ?? 0), 0);
  const output = calls.length * MODEL_MAX_TOKENS;
  const price = deps.engine.pricing();
  const cost = price ? (input * price.input + output * price.output) / 1_000_000 : 0;
  const route = price ? `${price.route}${price.input === 0 && price.output === 0 ? ", no price configured" : ""}` : "no extract route";
  const costLine = `${calls.length} model calls, ~${input} input + up to ${output} output tokens, est ${usd(cost)} (${route})`;
  if (dryRun) {
    const blocker = deps.engine.modelBlocker();
    return blocker ? `${costLine}; model views would not run now: ${blocker}` : costLine;
  }
  return `${count("recorded")} recorded, ${count("unchanged")} unchanged, ${count("no_value")} no evidence, ${count("rejected")} rejected, ${count("unavailable")} not computed, ${count("held_by_human")} held by a human; ${costLine}`;
}

async function set(ctx: CommandContext, args: string[], deps: CommandDeps): Promise<number> {
  const [query, name, ...valueWords] = args;
  const value = valueWords.join(" ");
  if (!query || !name || !value) {
    ctx.stderr('usage: yrm view set <entity> <name> <value>   (quote names with spaces: "Acme Robotics")');
    return 1;
  }
  const def = await findView(ctx.store, ctx.tenantId, name);
  if (!def) {
    ctx.stderr(`no view named "${name}"; see \`yrm view list\``);
    return 1;
  }
  const entity = await oneEntity(ctx, query);
  if (!entity) return 1;
  if (!appliesTo(def, entity)) {
    ctx.stderr(`${name} applies to ${def.appliesTo}, and ${entity.name} is a ${entity.kind}`);
    return 1;
  }
  const r = await setByHuman(ctx.store, ctx.tenantId, def, entity, value, deps.principal);
  if (!r.ok) {
    ctx.stderr(`cannot set ${name}: ${r.reason}`);
    return 1;
  }
  ctx.stdout(r.unchanged ? `${r.fact.statement} (unchanged)` : `${r.fact.statement} Recorded as ${deps.principal}; models will not override it.`);
  return 0;
}

async function drop(ctx: CommandContext, args: string[]): Promise<number> {
  const name = args[0];
  if (!name) {
    ctx.stderr("usage: yrm view drop <name>");
    return 1;
  }
  if (!(await dropView(ctx.store, ctx.tenantId, name))) {
    ctx.stderr(`no view named "${name}"`);
    return 1;
  }
  const kept = (await ctx.store.queryFacts({ tenantId: ctx.tenantId, predicate: `view.${name}`, includeRetracted: true })).filter(
    (f) => viewNameOf(f.predicate) === name,
  ).length;
  ctx.stdout(`dropped ${name}; ${kept} fact${kept === 1 ? "" : "s"} kept and still visible under \`yrm facts\``);
  return 0;
}
