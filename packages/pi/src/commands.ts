// Bun only. `/yrm today|who|facts`: the CLI's views, rendered into pi.
import { findEntities, formatBrief, formatEntity, formatFacts, parseArgv, parseInstant, type BriefOptions } from "@yrm/cli";
import { todayIn, type FactQuery, type Host } from "@yrm/core";
import { lookup } from "./host.ts";

export const YRM_USAGE = [
  "/yrm today [YYYY-MM-DD]           the attention queue",
  "/yrm who <name|address|domain>    find people, organizations and deals",
  "/yrm facts <entity> [--at <iso>] [--as-of <iso>] [--all]",
  "    --at     what was true in the world then (default now)",
  "    --as-of  what YRM believed then; also sets --at when --at is omitted",
  "    --all    include retracted and superseded facts",
].join("\n");

/** Split like a shell, without expansion: `who "Acme Robotics"` is one argument. */
export function splitArgs(input: string): string[] {
  const out: string[] = [];
  const re = /"([^"]*)"|'([^']*)'|(\S+)/g;
  for (let m = re.exec(input); m; m = re.exec(input)) out.push(m[1] ?? m[2] ?? m[3] ?? "");
  return out;
}

/** Run one `/yrm` subcommand and return the text to show. */
export async function runYrmCommand(host: Host, input: string): Promise<string> {
  const [sub, ...rest] = splitArgs(input);
  const parsed = parseArgv(rest, new Set(["all"]));
  const query = parsed.positionals.join(" ").trim();
  switch (sub) {
    case "today": {
      const date = parsed.positionals[0] ?? todayIn(host.config.tenant.timezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return `date must be YYYY-MM-DD, got "${date}"`;
      const opts: BriefOptions = { date };
      if (host.config.tenant.name !== undefined) opts.tenantName = host.config.tenant.name;
      const lines = formatBrief(await host.rank(date), opts);
      if (host.registry.rankers.size === 0) lines.push("note: no rankers registered (install @yrm/ext-attention)");
      return lines.join("\n");
    }
    case "who": {
      if (!query) return "usage: /yrm who <name|address|domain>";
      const found = await findEntities(host, query);
      if (found.length === 0) return `no entity matches "${query}"`;
      return found.map((e) => formatEntity(e).join("\n")).join("\n\n");
    }
    case "facts": {
      if (!query) return "usage: /yrm facts <entity> [--at <iso>] [--as-of <iso>] [--all]";
      const found = await lookup(host, query);
      if (found.length === 0) return `no entity matches "${query}"`;
      if (found.length > 1) {
        return [`"${query}" matches ${found.length} entities; pass an id:`, ...found.map((e) => `  ${e.id}  ${e.kind}  ${e.name}`)].join("\n");
      }
      const entity = found[0]!;
      const q: FactQuery = { tenantId: host.config.tenant.id, entityId: entity.id };
      const asOf = parsed.flags["as-of"];
      const at = parsed.flags["at"] ?? asOf;
      if (typeof asOf === "string") q.asOf = parseInstant(asOf, "--as-of");
      if (typeof at === "string") q.validAt = parseInstant(at, "--at");
      if (parsed.flags["all"] === true) q.includeRetracted = true;
      const lens = `true at ${q.validAt ?? "now"}, ${q.includeRetracted ? "including retracted" : `as known ${q.asOf ?? "now"}`}`;
      return [...formatEntity(entity), `  facts ${lens}`, "", ...formatFacts(await host.store.queryFacts(q))].join("\n");
    }
    default:
      return YRM_USAGE;
  }
}
