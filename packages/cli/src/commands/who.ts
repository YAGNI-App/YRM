import type { Entity, Host } from "@yrm/core";
import { booted, type BuiltinCommand, type CliEnv } from "../env.ts";
import { createStyle, isoDate, type Style } from "../format.ts";
import { formatFacts } from "./facts.ts";

/**
 * Find entities for a free-text query: an exact id, a name substring, and,
 * when the query looks like an address or domain, an identifier match.
 * Merged entities are followed to their survivor; results are de-duplicated.
 */
export async function findEntities(host: Host, query: string): Promise<Entity[]> {
  const tenantId = host.config.tenant.id;
  const out = new Map<string, Entity>();
  const add = async (e: Entity) => {
    const live = e.status === "merged" ? ((await host.store.resolveEntity(e.id)) ?? e) : e;
    out.set(live.id, live);
  };

  const byId = await host.store.getEntity(query);
  if (byId && byId.tenantId === tenantId) await add(byId);

  const q = query.trim().toLowerCase();
  if (q.includes("@")) {
    for (const e of await host.store.findEntities({ tenantId, identifier: { type: "email", value: q } })) await add(e);
  } else if (q.includes(".")) {
    for (const e of await host.store.findEntities({ tenantId, identifier: { type: "domain", value: q } })) await add(e);
    for (const e of await host.store.findEntities({ tenantId, identifier: { value: q } })) await add(e);
  }
  for (const e of await host.store.findEntities({ tenantId, nameLike: query.trim(), limit: 50 })) await add(e);
  return [...out.values()];
}

export function formatEntity(e: Entity, style: Style = createStyle(false)): string[] {
  const status = e.status === "confirmed" ? style.green(e.status) : e.status === "rejected" ? style.red(e.status) : style.yellow(e.status);
  const lines = [`${style.bold(e.name)}  ${style.dim(e.kind)}  [${status}]  ${style.dim(e.id)}`];
  if (e.identifiers.length > 0) lines.push(`  ${e.identifiers.map((i) => `${i.type}:${i.value}`).join(", ")}`);
  const s = e.summary;
  if (s) {
    const parts = [
      s.eventCount !== undefined ? `events ${s.eventCount}` : "",
      s.firstSeen ? `first ${isoDate(s.firstSeen)}` : "",
      s.lastSeen ? `last ${isoDate(s.lastSeen)}` : "",
      s.openCommitments !== undefined ? `open commitments ${s.openCommitments}` : "",
      s.openAsks !== undefined ? `open asks ${s.openAsks}` : "",
    ].filter(Boolean);
    if (parts.length > 0) lines.push(`  ${parts.join("  ·  ")}`);
  }
  if (e.mergedInto) lines.push(`  merged into ${e.mergedInto}`);
  return lines;
}

/**
 * Current view values (attribute facts named `view.<name>`, see ADR 0010),
 * one line. Read from facts so it works whether or not @yrm/ext-views loaded.
 */
export async function viewLine(host: Host, e: Entity): Promise<string> {
  const facts = (await host.store.queryFacts({ tenantId: host.config.tenant.id, subjectId: e.id, type: "attribute" })).filter((f) =>
    f.predicate.startsWith("view."),
  );
  const best = new Map<string, (typeof facts)[number]>();
  for (const f of facts) {
    const name = f.predicate.slice(5);
    const cur = best.get(name);
    const human = (x: typeof f): number => (x.origin.kind === "human" ? 1 : 0);
    if (!cur || human(f) > human(cur) || (human(f) === human(cur) && f.confidence > cur.confidence)) best.set(name, f);
  }
  return [...best.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([name, f]) => {
      const v = f.value as { name?: unknown } | string | number | boolean | null;
      const shown = typeof v === "object" && v !== null && typeof v.name === "string" ? v.name : typeof v === "string" ? v : JSON.stringify(v);
      return `${name}=${shown}`;
    })
    .join("  ·  ");
}

function statusTag(e: Entity, style: Style): string {
  const color = e.status === "confirmed" ? style.green : style.yellow;
  return `[${color(e.status)}]`;
}

function oneLine(e: Entity, style: Style): string {
  const ids = e.identifiers.filter((i) => i.type === "email" || i.type === "domain").map((i) => i.value);
  return [style.bold(e.name), statusTag(e, style), ids.join(", "), style.dim(e.id)].filter(Boolean).join("  ");
}

const byName = (a: Entity, b: Entity) => a.name.localeCompare(b.name);

/**
 * Every live entity (not rejected, not merged away), grouped: organizations
 * with the people who currently work there, then people with no current
 * organization, then any other kinds.
 */
export async function listAll(host: Host, style: Style = createStyle(false)): Promise<string[]> {
  const tenantId = host.config.tenant.id;
  const live = (await host.store.findEntities({ tenantId, status: ["proposed", "confirmed"] })).sort(byName);
  if (live.length === 0) return ["no entities yet; run `yrm import <path>`"];
  const byId = new Map(live.map((e) => [e.id, e]));
  const orgs = live.filter((e) => e.kind === "organization");
  const people = live.filter((e) => e.kind === "person");
  const others = live.filter((e) => e.kind !== "organization" && e.kind !== "person");

  const staff = new Map<string, Entity[]>();
  const placed = new Set<string>();
  for (const f of await host.store.queryFacts({ tenantId, predicate: "works_at" })) {
    const person = byId.get(f.subject.entityId);
    const org = f.object ? byId.get(f.object.entityId) : undefined;
    if (!person || !org || person.kind !== "person" || org.kind !== "organization") continue;
    const list = staff.get(org.id) ?? [];
    if (!list.some((p) => p.id === person.id)) list.push(person);
    staff.set(org.id, list);
    placed.add(person.id);
  }

  const lines: string[] = [];
  lines.push(style.bold(`organizations (${orgs.length})`));
  for (const org of orgs) {
    lines.push(`  ${oneLine(org, style)}`);
    for (const p of (staff.get(org.id) ?? []).sort(byName)) lines.push(`    ${oneLine(p, style)}`);
  }
  const loose = people.filter((p) => !placed.has(p.id));
  if (loose.length > 0) {
    lines.push("", style.bold(`people with no current organization (${loose.length})`));
    for (const p of loose) lines.push(`  ${oneLine(p, style)}`);
  }
  const kinds = [...new Set(others.map((e) => e.kind))].sort();
  for (const kind of kinds) {
    const of = others.filter((e) => e.kind === kind);
    lines.push("", style.bold(`${kind} (${of.length})`));
    for (const e of of) lines.push(`  ${oneLine(e, style)}`);
  }
  lines.push("", style.dim(`${people.length} people, ${orgs.length} organizations${others.length ? `, ${others.length} other` : ""}`));
  return lines;
}

export function whoCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "who",
    description: "Find people, organizations and deals by name, address or domain; with no query, list everyone",
    usage: "yrm who [<query>] [--facts] [--all]\n  with no query (or --all): every entity, people under their organization",
    needsHost: true,
    async run(ctx) {
      const { host } = booted(env);
      const query = ctx.args.join(" ");
      if (!query || ctx.flags["all"] === true) {
        for (const line of await listAll(host, env.style)) ctx.stdout(line);
        return 0;
      }
      const found = await findEntities(host, query);
      if (found.length === 0) {
        ctx.stdout(`no entity matches "${query}"`);
        return 1;
      }
      for (const e of found) {
        for (const line of formatEntity(e, env.style)) ctx.stdout(line);
        const views = await viewLine(host, e);
        if (views) ctx.stdout(`  ${env.style.dim("views")} ${views}`);
        if (ctx.flags["facts"] === true) {
          const facts = await host.store.queryFacts({ tenantId: host.config.tenant.id, entityId: e.id });
          for (const line of formatFacts(facts, { style: env.style, indent: "    " })) ctx.stdout(line);
        }
        ctx.stdout("");
      }
      return 0;
    },
  };
}
