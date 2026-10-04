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

export function whoCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "who",
    description: "Find people, organizations and deals by name, address or domain",
    usage: "yrm who <query> [--facts]",
    needsHost: true,
    async run(ctx) {
      const { host } = booted(env);
      const query = ctx.args.join(" ");
      if (!query) {
        ctx.stderr("usage: yrm who <query> [--facts]");
        return 1;
      }
      const found = await findEntities(host, query);
      if (found.length === 0) {
        ctx.stdout(`no entity matches "${query}"`);
        return 1;
      }
      for (const e of found) {
        for (const line of formatEntity(e, env.style)) ctx.stdout(line);
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
