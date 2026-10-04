import type { Fact, FactQuery } from "@yrm/core";
import { flagString } from "../argv.ts";
import { booted, type BuiltinCommand, type CliEnv } from "../env.ts";
import { createStyle, isoDate, isoMinute, table, type Style } from "../format.ts";
import { findEntities, formatEntity } from "./who.ts";

export interface FactFormatOptions {
  style?: Style;
  indent?: string;
}

function origin(f: Fact): string {
  const version = f.origin.version ? `@${f.origin.version}` : "";
  const model = f.origin.model ? ` (${f.origin.model})` : "";
  return `${f.origin.kind}:${f.origin.by}${version}${model}`;
}

/**
 * One line per fact:
 *   statement  [type/predicate]  valid from..to  [known on]  recorded at  conf  origin  ← eventId
 * The known column appears only when some fact was known on a different day
 * than it was recorded (imported history), and is blank on rows where the two
 * agree. Facts that are no longer believed show when they were retracted.
 */
export function formatFacts(facts: Fact[], opts: FactFormatOptions = {}): string[] {
  const s = opts.style ?? createStyle(false);
  if (facts.length === 0) return [`${opts.indent ?? ""}${s.dim("(no facts)")}`];
  const sorted = [...facts].sort((a, b) => (a.validFrom === b.validFrom ? a.recordedAt.localeCompare(b.recordedAt) : a.validFrom.localeCompare(b.validFrom)));
  const known = (f: Fact): string =>
    f.knownAt !== undefined && isoDate(f.knownAt) !== isoDate(f.recordedAt) ? isoDate(f.knownAt) : "";
  const showKnown = sorted.some((f) => known(f) !== "");
  const rows = sorted.map((f) => {
    const valid = `${isoDate(f.validFrom)}..${f.validTo ? isoDate(f.validTo) : ""}`;
    // For imported history the retraction was known (the closing message arrived) long before it was recorded.
    const unknown = f.knownUntil && f.retractedAt && isoDate(f.knownUntil) !== isoDate(f.retractedAt) ? `, known ${isoDate(f.knownUntil)}` : "";
    const recorded = f.retractedAt ? `${isoMinute(f.recordedAt)} (retracted ${isoMinute(f.retractedAt)}${unknown})` : isoMinute(f.recordedAt);
    const events = f.provenance.map((p) => p.eventId).join(", ");
    const statement = f.retractedAt ? s.dim(`x ${f.statement}`) : f.statement;
    const head = [statement, s.dim(`[${f.type}/${f.predicate}]`), valid];
    const tail = [recorded, f.confidence.toFixed(2), origin(f), `← ${events}`];
    return showKnown ? [...head, known(f), ...tail] : [...head, ...tail];
  });
  return table(rows, {
    header: ["statement", "type/predicate", "valid", ...(showKnown ? ["known"] : []), "recorded", "conf", "origin", "evidence"],
    align: ["left", "left", "left", ...(showKnown ? (["left"] as const) : []), "left", "right", "left", "left"],
    indent: opts.indent ?? "",
  });
}

/** `2026-06-03` means the end of that day (UTC), so "as of June 3rd" includes what was learned that day. */
export function parseInstant(v: string, flag: string): string {
  const s = /^\d{4}-\d{2}-\d{2}$/.test(v) ? `${v}T23:59:59.999Z` : v;
  const t = Date.parse(s);
  if (Number.isNaN(t)) throw new Error(`${flag} must be an ISO date or timestamp, got "${v}"`);
  return new Date(t).toISOString();
}

export function factsCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "facts",
    description: "Show what YRM knows about an entity, at any point in world and record time",
    usage:
      "yrm facts <entity-id|query> [--kind person|organization] [--at <iso>] [--as-of <iso>] [--all]\n" +
      "  --kind   only match entities of this kind (to pick between a person and a company with the same name)\n" +
      "  --at     what was true in the world at this time (default now)\n" +
      "  --as-of  what we knew at this time (for imported mail, by when it was received); also sets --at when --at is omitted\n" +
      "  --all    include retracted and superseded facts",
    needsHost: true,
    async run(ctx) {
      const { host } = booted(env);
      const query = ctx.args.join(" ");
      if (!query) {
        ctx.stderr("usage: yrm facts <entity-id|query> [--kind person|organization] [--at <iso>] [--as-of <iso>] [--all]");
        return 1;
      }
      const kind = flagString(ctx.flags, "kind");
      const found = (await findEntities(host, query)).filter((e) => kind === undefined || e.kind === kind);
      const what = kind === undefined ? "entity" : kind;
      if (found.length === 0) {
        ctx.stderr(`no ${what} matches "${query}"`);
        return 1;
      }
      if (found.length > 1) {
        ctx.stderr(`"${query}" matches ${found.length} entities; pass an id${kind === undefined ? " or --kind" : ""}:`);
        for (const e of found) ctx.stderr(`  ${e.id}  ${e.kind}  ${e.name}`);
        return 1;
      }
      const entity = found[0]!;

      const q: FactQuery = { tenantId: host.config.tenant.id, entityId: entity.id };
      const asOfRaw = flagString(ctx.flags, "as-of");
      const atRaw = flagString(ctx.flags, "at") ?? asOfRaw;
      if (asOfRaw !== undefined) q.asOf = parseInstant(asOfRaw, "--as-of");
      if (atRaw !== undefined) q.validAt = parseInstant(atRaw, "--at");
      if (ctx.flags["all"] === true) q.includeRetracted = true;

      for (const line of formatEntity(entity, env.style)) ctx.stdout(line);
      const lens = [
        `true at ${q.validAt ? isoMinute(q.validAt) : "now"}`,
        q.includeRetracted ? "including retracted" : `as known ${q.asOf ? `on ${isoMinute(q.asOf)}` : "now"}`,
      ];
      ctx.stdout(env.style.dim(`  facts ${lens.join(", ")}`));
      ctx.stdout("");
      for (const line of formatFacts(await host.store.queryFacts(q), { style: env.style })) ctx.stdout(line);
      return 0;
    },
  };
}
