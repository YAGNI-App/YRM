/**
 * A deliberately small reader for YAML-style frontmatter, the subset note
 * apps actually write:
 *
 *   ---
 *   date: 2026-06-16
 *   title: "Discovery call"
 *   attendees: [a@x.example, b@y.example]   # inline list
 *   tags:                                   # or a block list
 *     - acme
 *     - pilot
 *   ---
 *
 * Supported: `key: scalar` (quotes stripped), inline lists `[a, b]`, block
 * lists of `- item` lines, `#` comment lines. Anything else under a key
 * (nested maps, multi-line strings) is kept verbatim as a string so nothing
 * is lost, just not interpreted. This is not a YAML parser and does not try
 * to be one.
 */

export type FrontmatterValue = string | string[];

export interface ParsedNote {
  /** Every key as written, values as strings or string lists. */
  data: Record<string, FrontmatterValue>;
  /** The document with the frontmatter block removed. */
  body: string;
  /** True when a closed `---` block was found at the top. */
  hasFrontmatter: boolean;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && ((t.startsWith('"') && t.endsWith('"')) || (t.startsWith("'") && t.endsWith("'")))) return t.slice(1, -1);
  return t;
}

/** Strip a trailing ` # comment` that is not inside quotes. */
function stripComment(s: string): string {
  let quote: string | null = null;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (quote) {
      if (c === quote) quote = null;
    } else if (c === '"' || c === "'") quote = c;
    else if (c === "#" && (i === 0 || /\s/.test(s[i - 1]!))) return s.slice(0, i).trimEnd();
  }
  return s;
}

function inlineList(s: string): string[] {
  return s
    .slice(1, -1)
    .split(",")
    .map(unquote)
    .filter((x) => x.length > 0);
}

/** Split a document into frontmatter data and body. Without a closed fence the whole text is body. */
export function parseFrontmatter(raw: string): ParsedNote {
  const text = raw.replace(/^﻿/, "");
  const lines = text.split(/\r?\n/);
  if (lines[0]?.trim() !== "---") return { data: {}, body: text, hasFrontmatter: false };
  const close = lines.findIndex((l, i) => i > 0 && (l.trim() === "---" || l.trim() === "..."));
  if (close < 0) return { data: {}, body: text, hasFrontmatter: false };

  const data: Record<string, FrontmatterValue> = {};
  let key: string | null = null;
  let block: string[] = [];
  const flush = (): void => {
    if (key === null) return;
    const items = block.map((l) => l.trim()).filter((l) => l.length > 0 && !l.startsWith("#"));
    if (items.length > 0 && items.every((l) => l.startsWith("- ") || l === "-")) data[key] = items.map((l) => unquote(stripComment(l.slice(1))));
    else data[key] = block.join("\n").replace(/^\n+|\s+$/g, "");
    key = null;
    block = [];
  };

  for (const line of lines.slice(1, close)) {
    const indented = /^\s/.test(line) || line.trimStart().startsWith("- ");
    if (key !== null && (indented || line.trim() === "")) {
      block.push(line);
      continue;
    }
    flush();
    if (line.trim() === "" || line.trimStart().startsWith("#")) continue;
    const m = /^([A-Za-z0-9_][\w.-]*)\s*:(.*)$/.exec(line);
    if (!m) continue;
    const name = m[1]!;
    const value = stripComment(m[2]!).trim();
    if (value === "" || value === "|" || value === ">") {
      key = name;
      continue;
    }
    data[name] = value.startsWith("[") && value.endsWith("]") ? inlineList(value) : unquote(value);
  }
  flush();

  return { data, body: lines.slice(close + 1).join("\n").replace(/^(\r?\n)+/, ""), hasFrontmatter: true };
}

/** First value of a key as a string, if any. */
export function scalar(data: Record<string, FrontmatterValue>, key: string): string | undefined {
  const v = data[key];
  if (v === undefined) return undefined;
  const s = Array.isArray(v) ? v[0] : v;
  return s === undefined || s === "" ? undefined : s;
}

/** A key as a list: lists as-is, a comma-separated scalar split. */
export function list(data: Record<string, FrontmatterValue>, key: string): string[] {
  const v = data[key];
  if (v === undefined) return [];
  if (Array.isArray(v)) return v;
  return v
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}
