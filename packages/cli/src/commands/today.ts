import { todayIn, type QueueItem } from "@yrm/core";
import { flagString } from "../argv.ts";
import { booted, type BuiltinCommand, type CliEnv } from "../env.ts";
import { createStyle, isoDate, plural, scoreBar, type Style } from "../format.ts";

export interface BriefOptions {
  date: string;
  tenantName?: string;
  style?: Style;
}

/** The `yrm today` brief: a header, then one numbered block per queue item. */
export function formatBrief(items: QueueItem[], opts: BriefOptions): string[] {
  const s = opts.style ?? createStyle(false);
  const who = opts.tenantName ? ` for ${opts.tenantName}` : "";
  const lines = [s.bold(`Today, ${opts.date}${who}`) + s.dim(`  (${plural(items.length, "item")})`), ""];
  if (items.length === 0) {
    lines.push("Nothing needs you today.");
    return lines;
  }
  const numWidth = String(items.length).length;
  const indent = " ".repeat(numWidth + 2);
  items.forEach((item, i) => {
    const n = String(i + 1).padStart(numWidth);
    lines.push(`${n}. ${s.cyan(scoreBar(item.score))} ${item.score.toFixed(2)}  ${s.bold(item.action)}`);
    lines.push(`${indent}${item.reason}`);
    const about = item.about.map((a) => a.name ?? a.entityId).join(", ");
    const meta = [about ? `about: ${about}` : "", item.dueAt ? `due: ${isoDate(item.dueAt)}` : ""].filter(Boolean).join("  ·  ");
    if (meta) lines.push(`${indent}${meta}`);
    lines.push(s.dim(`${indent}(facts: ${item.evidence.factIds.length}, events: ${item.evidence.eventIds.length})`));
    lines.push("");
  });
  return lines;
}

export function todayCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "today",
    description: "Show today's attention queue",
    usage: "yrm today [--date YYYY-MM-DD] [--json]",
    needsHost: true,
    async run(ctx) {
      const { host, config } = booted(env);
      const date = flagString(ctx.flags, "date") ?? todayIn(config.tenant.timezone);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
        ctx.stderr(`--date must be YYYY-MM-DD, got "${date}"`);
        return 1;
      }
      const items = await host.rank(date);
      if (ctx.flags["json"] === true) {
        ctx.stdout(JSON.stringify(items, null, 2));
        return 0;
      }
      const opts: BriefOptions = { date, style: env.style };
      if (config.tenant.name !== undefined) opts.tenantName = config.tenant.name;
      for (const line of formatBrief(items, opts)) ctx.stdout(line);
      if (host.registry.rankers.size === 0) ctx.stderr("note: no rankers registered (install @yrm/ext-attention)");
      return 0;
    },
  };
}
