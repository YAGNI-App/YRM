import { basename, extname } from "node:path";
import type { NewSourceEvent, Participant } from "@yrm/core";
import { list, parseFrontmatter, scalar, type FrontmatterValue } from "./frontmatter.ts";

export const SOURCE_NAME = "notes";
export const NOTE_KIND = "note";

/** What downstream extensions may rely on in a note event's `meta`. */
export interface NoteMeta {
  /** Path relative to the import root, `/`-separated. Also the externalId. */
  path: string;
  /** sha256 hex of the raw file, so a later pass can tell an edited note from a re-delivery. */
  contentHash: string;
  tags: string[];
  /** Every frontmatter key, as parsed. */
  frontmatter: Record<string, FrontmatterValue>;
}

export interface NoteFile {
  /** Relative, `/`-separated path; the note's stable identity. */
  path: string;
  raw: string;
  /** Fallback for `occurredAt` when frontmatter has no usable date. */
  mtime: Date;
  /** Pointer to the file, stored as `rawRef`. */
  rawRef?: string;
}

export function sha256(text: string): string {
  return new Bun.CryptoHasher("sha256").update(text).digest("hex");
}

export function slugify(s: string): string {
  return s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Frontmatter dates: a bare `YYYY-MM-DD` is midnight UTC of that day; anything
 * else `Date` can parse is taken as given. Unparseable values return null.
 */
export function parseNoteDate(value: string): string | null {
  const v = value.trim();
  const d = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (d) return new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)).toISOString();
  const ms = Date.parse(v);
  return Number.isNaN(ms) ? null : new Date(ms).toISOString();
}

/** `Name <a@b>`, `a@b`, or a bare name. Addresses are lowercased. */
export function attendee(value: string): Participant {
  const v = value.trim();
  const angle = /^(.*?)\s*<([^<>\s]+@[^<>\s]+)>$/.exec(v);
  if (angle) {
    const p: Participant = { role: "attendee", address: angle[2]!.toLowerCase() };
    const name = angle[1]!.replace(/^"(.*)"$/, "$1").trim();
    if (name) p.name = name;
    return p;
  }
  const bare = v.replace(/^mailto:/i, "");
  if (/^[^\s@]+@[^\s@]+$/.test(bare)) return { role: "attendee", address: bare.toLowerCase() };
  return { role: "attendee", name: v };
}

function headingOf(body: string): string | undefined {
  const m = /^#[ \t]+(.+?)[ \t#]*$/m.exec(body);
  return m?.[1]?.trim() || undefined;
}

export interface ToEventResult {
  event: NewSourceEvent;
  /** Non-fatal problems, e.g. an unparseable date that fell back to mtime. */
  warnings: string[];
}

/** Map a Markdown note to a `note` event authored by the tenant. */
export function toEvent(file: NoteFile): ToEventResult {
  const warnings: string[] = [];
  const { data, body } = parseFrontmatter(file.raw);

  let occurredAt: string | null = null;
  const date = scalar(data, "date");
  if (date !== undefined) {
    occurredAt = parseNoteDate(date);
    if (occurredAt === null) warnings.push(`${file.path}: unparseable date "${date}", using file mtime`);
  }
  occurredAt ??= file.mtime.toISOString();

  const title = scalar(data, "title") ?? headingOf(body) ?? basename(file.path, extname(file.path));

  // The tenant writes their own notes. A note has no author address, so the
  // host cannot mark self from one; the source knows and says so.
  const participants: Participant[] = [{ role: "author", self: true }, ...list(data, "attendees").map(attendee)];

  const meta: NoteMeta = {
    path: file.path,
    contentHash: sha256(file.raw),
    tags: list(data, "tags"),
    frontmatter: data,
  };
  const event: NewSourceEvent = {
    source: SOURCE_NAME,
    kind: NOTE_KIND,
    externalId: file.path,
    occurredAt,
    participants,
    content: { text: body.trim(), title, mime: "text/markdown" },
    // Notes about the same meeting share a title, so they thread together.
    threadKey: `notes:${slugify(title) || slugify(file.path)}`,
    meta: { ...meta },
  };
  if (file.rawRef !== undefined) event.rawRef = file.rawRef;
  return { event, warnings };
}
