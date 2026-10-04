import { existsSync, readdirSync, statSync } from "node:fs";
import { extname, join, resolve } from "node:path";
import type { Host, SourceEvent } from "@yrm/core";
import { SOURCE_PACKAGES } from "../builtins.ts";
import { booted, type BuiltinCommand, type CliEnv } from "../env.ts";
import { ms, table } from "../format.ts";

export interface ImportStep {
  source: string;
  path: string;
}

const BY_EXTENSION: Readonly<Record<string, string>> = {
  ".eml": "mail",
  ".mbox": "mail",
  ".ics": "calendar",
  ".md": "notes",
};

/** Subdirectory names that route straight to a source, as in `fixtures/acme`. */
const BY_SUBDIR: ReadonlyArray<[string, string]> = [
  ["mail", "mail"],
  ["calendar", "calendar"],
  ["notes", "notes"],
];

/**
 * Decide which source imports a path.
 *   file.eml / file.mbox      -> mail
 *   file.ics                  -> calendar
 *   file.md                   -> notes
 *   dir with mail/, calendar/ or notes/ subdirs -> each subdir with its source
 *   dir of files              -> one step per source whose extension appears
 * Throws on a path that does not exist or that nothing can import.
 */
export function planImport(input: string, cwd: string = process.cwd()): ImportStep[] {
  const path = resolve(cwd, input);
  if (!existsSync(path)) throw new Error(`no such file or directory: ${input}`);
  const st = statSync(path);
  if (st.isFile()) {
    const source = BY_EXTENSION[extname(path).toLowerCase()];
    if (!source) throw new Error(`don't know how to import ${input} (expected .eml, .mbox, .ics or .md)`);
    return [{ source, path }];
  }
  if (!st.isDirectory()) throw new Error(`cannot import ${input}: not a file or directory`);

  const subdirs = BY_SUBDIR.filter(([dir]) => isDir(join(path, dir))).map(([dir, source]) => ({ source, path: join(path, dir) }));
  if (subdirs.length > 0) return subdirs;

  const sources = new Set<string>();
  for (const f of readdirSync(path)) {
    const source = BY_EXTENSION[extname(f).toLowerCase()];
    if (source && statSync(join(path, f)).isFile()) sources.add(source);
  }
  if (sources.size === 0) throw new Error(`nothing to import in ${input} (no .eml, .mbox, .ics or .md files, and no mail/, calendar/ or notes/ subdirectories)`);
  // Stable order: mail first so people exist before meetings and notes mention them.
  return ["mail", "calendar", "notes"].filter((s) => sources.has(s)).map((source) => ({ source, path }));
}

function isDir(p: string): boolean {
  return existsSync(p) && statSync(p).isDirectory();
}

export interface ImportSummary {
  steps: Array<ImportStep & { created: number; duplicates: number; dropped: number }>;
  events: number;
  duplicates: number;
  dropped: number;
  resolved: number;
  entitiesProposed: number;
  facts: number;
  extractSkipped: number;
  ms: number;
}

/**
 * Import, then resolve, extract and project what was created. `host.run()`
 * covers `sync` but not one-shot imports, so this is the import-shaped
 * equivalent. Extraction runs in world-time order across sources so later
 * events can supersede earlier facts.
 */
export async function importAndProcess(host: Host, steps: ImportStep[], opts: { extract: boolean }): Promise<ImportSummary> {
  const t0 = performance.now();
  const tenantId = host.config.tenant.id;
  const entitiesBefore = (await host.store.findEntities({ tenantId })).length;

  const summary: ImportSummary = {
    steps: [],
    events: 0,
    duplicates: 0,
    dropped: 0,
    resolved: 0,
    entitiesProposed: 0,
    facts: 0,
    extractSkipped: 0,
    ms: 0,
  };
  const created: SourceEvent[] = [];
  for (const step of steps) {
    const r = await host.importPath(step.source, step.path);
    summary.steps.push({ ...step, created: r.events.length, duplicates: r.duplicates, dropped: r.dropped });
    summary.duplicates += r.duplicates;
    summary.dropped += r.dropped;
    created.push(...r.events);
  }
  summary.events = created.length;
  created.sort((a, b) => (a.occurredAt === b.occurredAt ? (a.id < b.id ? -1 : 1) : a.occurredAt < b.occurredAt ? -1 : 1));

  const touched = new Set<string>();
  const resolved: SourceEvent[] = [];
  for (const e of created) {
    const r = await host.resolve(e);
    summary.resolved += r.assigned;
    for (const ent of r.entities) touched.add(ent.id);
    resolved.push(r.event);
  }
  if (opts.extract) {
    for (const e of resolved) {
      const r = await host.extract(e);
      if (r.skipped) summary.extractSkipped++;
      summary.facts += r.facts.length;
      for (const f of r.facts) {
        touched.add(f.subject.entityId);
        if (f.object) touched.add(f.object.entityId);
      }
    }
  }
  await host.project(touched);

  summary.entitiesProposed = (await host.store.findEntities({ tenantId })).length - entitiesBefore;
  summary.ms = performance.now() - t0;
  return summary;
}

export function formatImportSummary(s: ImportSummary, opts: { extract: boolean }): string[] {
  const rows = s.steps.map((st) => [st.source, st.path, String(st.created), String(st.duplicates), String(st.dropped)]);
  const lines = table(rows, { header: ["source", "path", "created", "dup", "dropped"], align: ["left", "left", "right", "right", "right"] });
  lines.push("");
  lines.push(
    ...table(
      [
        ["events created", String(s.events)],
        ["duplicates", String(s.duplicates)],
        ["dropped", String(s.dropped)],
        ["participants resolved", String(s.resolved)],
        ["entities proposed", String(s.entitiesProposed)],
        ["facts recorded", opts.extract ? String(s.facts) : "skipped (--no-extract)"],
        ["time", ms(s.ms)],
      ],
      { align: ["left", "right"] },
    ),
  );
  return lines;
}

export function importCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "import",
    description: "Import files or directories (.eml, .mbox, .ics, .md) and process them",
    usage: "yrm import <path...> [--no-extract]",
    needsHost: true,
    async run(ctx) {
      const { host } = booted(env);
      if (ctx.args.length === 0) {
        ctx.stderr("usage: yrm import <path...> [--no-extract]");
        return 1;
      }
      const steps: ImportStep[] = [];
      for (const p of ctx.args) {
        try {
          steps.push(...planImport(p, env.cwd));
        } catch (err) {
          ctx.stderr(err instanceof Error ? err.message : String(err));
          return 1;
        }
      }

      const missing = [...new Set(steps.map((s) => s.source))].filter((s) => !host.registry.sources.has(s));
      for (const source of missing) {
        const pkg = SOURCE_PACKAGES[source] ?? `an extension that registers the "${source}" source`;
        ctx.stderr(`source "${source}" is not registered; install ${pkg} (bun add ${pkg}) to import these files`);
      }
      const runnable = steps.filter((s) => !missing.includes(s.source));
      if (runnable.length === 0) return 1;

      const extract = ctx.flags["extract"] !== false;
      if (extract && host.registry.extractors.size === 0) {
        ctx.stderr("note: no extractors registered (install @yrm/ext-extract); importing events only");
      }
      if (host.registry.resolvers.size === 0) {
        ctx.stderr("note: no resolvers registered (install @yrm/ext-resolve); participants stay unlinked");
      }

      const summary = await importAndProcess(host, runnable, { extract });
      for (const line of formatImportSummary(summary, { extract })) ctx.stdout(line);
      return missing.length > 0 ? 1 : 0;
    },
  };
}
