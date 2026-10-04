import { readdir, readFile, stat } from "node:fs/promises";
import { basename, extname, join } from "node:path";
import type { Command, ExtensionAPI, ExtensionManifest, NewSourceEvent, SourceAdapter, SyncContext } from "@yrm/core";
import { classifyNoise, type NoiseOptions } from "./noise.ts";
import { parseEml, splitMbox } from "./parse.ts";
import { stripQuotes } from "./strip.ts";
import { SOURCE_NAME, toEvent } from "./to-event.ts";

export * from "./noise.ts";
export * from "./parse.ts";
export * from "./strip.ts";
export * from "./to-event.ts";

export const manifest: ExtensionManifest = {
  name: SOURCE_NAME,
  version: "0.1.0",
  description: "Mail ingestion: .eml and .mbox import, bulk-mail filtering, quote and signature stripping.",
};

/** `settings.mail` in yrm.config.ts. */
export interface MailSettings {
  /** Emit bulk/automated mail too, tagged with `meta.noise`. Default false. */
  keepNoise?: boolean;
  /** Sender local parts treated as noise. Replaces `DEFAULT_NOISE_LOCAL_PARTS`. */
  noiseLocalParts?: string[];
  /** Sender domains treated as noise (subdomains included). */
  noiseDomains?: string[];
  /** A file or directory `sync` imports, until a live connector exists. */
  watchPath?: string;
}

/** Events handed to the host per `emit` call. */
export const EMIT_BATCH = 50;

export interface ImportStats {
  files: number;
  messages: number;
  emitted: number;
  created: number;
  noise: number;
  noiseReasons: Record<string, number>;
}

function noiseOptions(settings: MailSettings): NoiseOptions {
  const opts: NoiseOptions = {};
  if (settings.noiseLocalParts !== undefined) opts.localParts = settings.noiseLocalParts;
  if (settings.noiseDomains !== undefined) opts.domains = settings.noiseDomains;
  return opts;
}

const isMailFile = (name: string): boolean => [".eml", ".mbox"].includes(extname(name).toLowerCase());

/** Mail files under `path`, depth-first, each directory's entries sorted by name. */
export async function listMailFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (!info.isDirectory()) return [path];
  const entries = (await readdir(path, { withFileTypes: true })).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const out: string[] = [];
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) out.push(...(await listMailFiles(full)));
    else if (entry.isFile() && isMailFile(entry.name)) out.push(full);
  }
  return out;
}

/** Import a file or directory through `ctx`. Exported for hosts that drive sources directly. */
export async function importMail(path: string, ctx: SyncContext, settings: MailSettings = {}): Promise<ImportStats> {
  const stats: ImportStats = { files: 0, messages: 0, emitted: 0, created: 0, noise: 0, noiseReasons: {} };
  const noise = noiseOptions(settings);
  let batch: NewSourceEvent[] = [];
  let lastFile: string | undefined;

  // Emit full chunks; with `all`, also the remainder. An mbox can push the buffer well past one chunk.
  const flush = async (all: boolean): Promise<void> => {
    while (batch.length >= EMIT_BATCH || (all && batch.length > 0)) {
      const chunk = batch.slice(0, EMIT_BATCH);
      batch = batch.slice(EMIT_BATCH);
      const created = await ctx.emit(chunk);
      stats.emitted += chunk.length;
      stats.created += created.length;
    }
  };

  for (const file of await listMailFiles(path)) {
    if (ctx.signal.aborted) break;
    const raw = await readFile(file, "utf-8");
    const mtime = (await stat(file)).mtime.toISOString();
    const isMbox = extname(file).toLowerCase() === ".mbox";
    const messages = isMbox ? splitMbox(raw) : [raw];
    stats.files++;
    messages.forEach((m, index) => {
      const msg = parseEml(m);
      stats.messages++;
      const verdict = classifyNoise(msg, noise);
      if (verdict.noise) {
        stats.noise++;
        const reason = verdict.reason ?? "noise";
        stats.noiseReasons[reason] = (stats.noiseReasons[reason] ?? 0) + 1;
      }
      const event = toEvent(msg, {
        verdict,
        noise,
        keepNoise: settings.keepNoise === true,
        rawRef: isMbox ? `${file}#${index}` : file,
        fallbackDate: mtime,
      });
      if (event) batch.push(event);
    });
    lastFile = file;
    if (batch.length >= EMIT_BATCH) {
      await flush(false);
      await ctx.setCursor(file);
    }
  }
  await flush(true);
  if (lastFile !== undefined) await ctx.setCursor(lastFile);
  if (!settings.keepNoise && stats.noise > 0) ctx.report?.({ dropped: stats.noise });

  ctx.log.info("mail import finished", {
    path,
    files: stats.files,
    messages: stats.messages,
    created: stats.created,
    duplicates: stats.emitted - stats.created,
    noiseDropped: settings.keepNoise ? 0 : stats.noise,
    noiseReasons: stats.noiseReasons,
  });
  return stats;
}

/** Two columns, for eyeballing what stripping kept against what it removed. */
function sideBySide(left: string, right: string, width = 60): string[] {
  const wrap = (s: string): string[] =>
    s.split("\n").flatMap((line) => {
      if (line.length <= width) return [line];
      const parts: string[] = [];
      for (let i = 0; i < line.length; i += width) parts.push(line.slice(i, i + width));
      return parts;
    });
  const l = wrap(left);
  const r = wrap(right);
  const rows: string[] = [`${"KEPT (content.text)".padEnd(width)} | REMOVED (content.stripped)`, `${"-".repeat(width)}-+-${"-".repeat(width)}`];
  for (let i = 0; i < Math.max(l.length, r.length); i++) rows.push(`${(l[i] ?? "").padEnd(width)} | ${r[i] ?? ""}`.trimEnd());
  return rows;
}

export default function mailExtension(yrm: ExtensionAPI): void {
  const settings = (): MailSettings => yrm.config.get<MailSettings>() ?? {};

  const source: SourceAdapter = {
    name: SOURCE_NAME,
    description: "Email from .eml files and .mbox archives.",
    kinds: ["message"],
    async sync(ctx) {
      const s = settings();
      if (s.watchPath === undefined) {
        ctx.log.info("mail sync requires a connector (Gmail planned for 0.2)");
        return;
      }
      await importMail(s.watchPath, ctx, s);
    },
    async importPath(path, ctx) {
      await importMail(path, ctx, settings());
    },
  };
  yrm.registerSource(source);

  const inspect: Command = {
    name: "mail:inspect",
    description: "Show how a message is parsed, classified and stripped.",
    usage: "mail:inspect <file.eml>",
    async run(ctx) {
      const file = ctx.args[0];
      if (file === undefined) {
        ctx.stderr("usage: mail:inspect <file.eml>");
        return 1;
      }
      const s = settings();
      const msg = parseEml(await readFile(file, "utf-8"));
      const verdict = classifyNoise(msg, noiseOptions(s));
      const { text, stripped } = stripQuotes(msg.text);
      const fmt = (list: Array<{ address: string; name?: string }>): string =>
        list.map((a) => (a.name ? `${a.name} <${a.address}>` : a.address)).join(", ");
      const rows: Array<[string, string | undefined]> = [
        ["file", basename(file)],
        ["message-id", msg.messageId],
        ["date", msg.date],
        ["from", fmt(msg.from)],
        ["to", fmt(msg.to)],
        ["cc", fmt(msg.cc)],
        ["bcc", fmt(msg.bcc)],
        ["subject", msg.subject],
        ["in-reply-to", msg.inReplyTo],
        ["references", msg.references.join(" ")],
        ["body", `${msg.bodyType}, ${msg.text.length} chars, ${msg.attachments.length} attachment(s)`],
        ["noise", verdict.noise ? `yes (${verdict.reason})` : "no"],
        ["kept", `${text.length} chars`],
      ];
      for (const [k, v] of rows) if (v) ctx.stdout(`${k.padEnd(12)} ${v}`);
      ctx.stdout("");
      for (const line of sideBySide(text, stripped)) ctx.stdout(line);
      return 0;
    },
  };
  yrm.registerCommand(inspect);
}
