import { readdir, readFile, stat } from "node:fs/promises";
import { basename, join, relative, resolve, sep } from "node:path";
import type { ExtensionAPI, ExtensionManifest, SourceAdapter, SyncContext } from "@yrm/core";
import { NOTE_KIND, SOURCE_NAME, toEvent } from "./to-event.ts";

export * from "./frontmatter.ts";
export * from "./to-event.ts";

/**
 * Settings under `settings.notes` in yrm.config.ts:
 * - `watchPath`: a Markdown file or a directory of notes, imported on every sync.
 */
export interface NotesSettings {
  watchPath?: string;
}

// Named after the source so `settings.notes` and `event.source` agree.
export const manifest: ExtensionManifest = {
  name: SOURCE_NAME,
  version: "0.1.0",
  description: "Notes from Markdown files with optional frontmatter.",
};

const isMarkdown = (name: string): boolean => /\.(md|markdown)$/i.test(name);

/** Markdown files under `dir`, recursive, sorted, skipping dotfiles and node_modules. */
export async function markdownFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await markdownFiles(full)));
    else if (entry.isFile() && isMarkdown(entry.name)) out.push(full);
  }
  return out.sort();
}

/**
 * Notes are identified by their path relative to the import root (the
 * directory imported, or the file's own directory), so moving the whole
 * notes folder does not re-create every note.
 */
async function notesUnder(path: string): Promise<Array<{ abs: string; rel: string }>> {
  const abs = resolve(path);
  if ((await stat(abs)).isFile()) return [{ abs, rel: basename(abs) }];
  return (await markdownFiles(abs)).map((f) => ({ abs: f, rel: relative(abs, f).split(sep).join("/") }));
}

export function createNotesSource(settings: () => NotesSettings | undefined): SourceAdapter {
  const importPath = async (path: string, ctx: SyncContext): Promise<void> => {
    let created = 0;
    let seen = 0;
    for (const { abs, rel } of await notesUnder(path)) {
      if (ctx.signal.aborted) break;
      const [raw, info] = await Promise.all([readFile(abs, "utf8"), stat(abs)]);
      const { event, warnings } = toEvent({ path: rel, raw, mtime: info.mtime, rawRef: abs });
      for (const w of warnings) ctx.log.warn(w);
      seen++;
      created += (await ctx.emit([event])).length;
    }
    ctx.log.info(`imported ${created} new notes (${seen} read) from ${path}`);
  };
  return {
    name: SOURCE_NAME,
    description: "Markdown notes; frontmatter supplies date, title, attendees and tags.",
    kinds: [NOTE_KIND],
    importPath,
    async sync(ctx) {
      const watchPath = settings()?.watchPath;
      if (watchPath) return importPath(watchPath, ctx);
      ctx.log.info("no notes watchPath configured; use `yrm import` for Markdown notes");
    },
  };
}

export default function notesExtension(yrm: ExtensionAPI): void {
  yrm.registerSource(createNotesSource(() => yrm.config.get<NotesSettings>()));
}
