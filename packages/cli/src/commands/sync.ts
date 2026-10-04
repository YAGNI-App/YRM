import type { RunSummary } from "@yrm/core";
import { booted, type BuiltinCommand, type CliEnv } from "../env.ts";
import { ms, plural, table } from "../format.ts";

export function formatRunSummary(s: RunSummary): string[] {
  const lines = table(
    s.sources.map((r) => [r.name, String(r.created), String(r.duplicates), String(r.dropped)]),
    { header: ["source", "created", "dup", "dropped"], align: ["left", "right", "right", "right"] },
  );
  lines.push("");
  lines.push(
    ...table(
      [
        ["events created", String(s.events)],
        ["participants resolved", String(s.resolved)],
        ["facts recorded", String(s.facts)],
        ["entities updated", String(s.entitiesProjected)],
        ["queue", plural(s.queue.length, "item")],
        [
          "time",
          `${ms(s.timing.totalMs)} (ingest ${ms(s.timing.ingestMs)}, resolve ${ms(s.timing.resolveMs)}, extract ${ms(s.timing.extractMs)}, rank ${ms(s.timing.rankMs)})`,
        ],
      ],
      { align: ["left", "right"] },
    ),
  );
  return lines;
}

export function syncCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "sync",
    description: "Pull new events from every source (or one), then resolve, extract and rank",
    usage: "yrm sync [source]",
    needsHost: true,
    async run(ctx) {
      const { host } = booted(env);
      const source = ctx.args[0];
      if (host.registry.sources.size === 0) {
        ctx.stderr("no sources registered; install @yrm/ext-mail, @yrm/ext-calendar or @yrm/ext-notes");
        return 1;
      }
      if (source !== undefined && !host.registry.sources.has(source)) {
        const known = host.registry.sources.list().map((s) => s.name);
        ctx.stderr(`unknown source "${source}"; registered: ${known.join(", ")}`);
        return 1;
      }
      const summary = await host.run(source);
      for (const line of formatRunSummary(summary)) ctx.stdout(line);
      return 0;
    },
  };
}
