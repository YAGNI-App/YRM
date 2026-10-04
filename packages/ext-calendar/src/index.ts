import { readdir, readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import type { ExtensionAPI, ExtensionManifest, NewSourceEvent, SourceAdapter, SyncContext } from "@yrm/core";
import { parseIcs } from "./ics.ts";
import { latestRevisions, MEETING_KIND, SOURCE_NAME, toEvent } from "./to-event.ts";

export * from "./ics.ts";
export * from "./to-event.ts";

/**
 * Settings under `settings.calendar` in yrm.config.ts:
 * - `watchPath`: an .ics file or a directory of them, imported on every sync.
 * - `defaultTimezone`: IANA zone for floating times (no `Z`, no TZID). Defaults to UTC.
 */
export interface CalendarSettings {
  watchPath?: string;
  defaultTimezone?: string;
}

// Named after the source so `settings.calendar` and `event.source` agree.
export const manifest: ExtensionManifest = {
  name: SOURCE_NAME,
  version: "0.1.0",
  description: "Meetings from iCalendar (.ics) files.",
};

/** `.ics` files under `path` (a file or a directory, recursive), sorted, skipping dotfiles. */
export async function icsFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];
  const out: string[] = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...(await icsFiles(full)));
    else if (entry.isFile() && entry.name.toLowerCase().endsWith(".ics")) out.push(full);
  }
  return out.sort();
}

/** Parse one .ics document into meeting events, logging what was skipped. */
export function eventsFromIcs(raw: string, ctx: Pick<SyncContext, "log">, opts: { rawRef?: string; defaultTimezone?: string } = {}): NewSourceEvent[] {
  const cal = parseIcs(raw, opts.defaultTimezone !== undefined ? { defaultTimezone: opts.defaultTimezone } : {});
  for (const w of cal.warnings) ctx.log.warn(w, opts.rawRef !== undefined ? { file: opts.rawRef } : undefined);
  const out: NewSourceEvent[] = [];
  for (const ev of latestRevisions(cal.events)) {
    const e = toEvent(ev, { ...(cal.method !== undefined && { method: cal.method }), ...(opts.rawRef !== undefined && { rawRef: opts.rawRef }) });
    if (e) out.push(e);
    else ctx.log.warn(`event ${ev.uid} has no DTSTART; skipped`);
  }
  return out;
}

export function createCalendarSource(settings: () => CalendarSettings | undefined): SourceAdapter {
  const importPath = async (path: string, ctx: SyncContext): Promise<void> => {
    const tz = settings()?.defaultTimezone;
    let created = 0;
    let seen = 0;
    for (const file of await icsFiles(resolve(path))) {
      if (ctx.signal.aborted) break;
      const events = eventsFromIcs(await readFile(file, "utf8"), ctx, { rawRef: file, ...(tz !== undefined && { defaultTimezone: tz }) });
      seen += events.length;
      created += (await ctx.emit(events)).length;
    }
    ctx.log.info(`imported ${created} new meetings (${seen} read) from ${path}`);
  };
  return {
    name: SOURCE_NAME,
    description: "Meetings from iCalendar files. CalDAV and Google Calendar sync are planned.",
    kinds: [MEETING_KIND],
    importPath,
    async sync(ctx) {
      const watchPath = settings()?.watchPath;
      if (watchPath) return importPath(watchPath, ctx);
      ctx.log.info("no calendar watchPath configured; CalDAV and Google Calendar sync are planned, use `yrm import` for .ics files");
    },
  };
}

export default function calendarExtension(yrm: ExtensionAPI): void {
  yrm.registerSource(createCalendarSource(() => yrm.config.get<CalendarSettings>()));
}
