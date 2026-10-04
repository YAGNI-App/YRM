import type { QueueItem } from "@yrm/core";

/** Pure renderers for the queue: the `yrm today` terminal brief and Markdown for MCP and READMEs. */

export interface BriefOptions {
  /** ISO date the queue was ranked for. */
  today: string;
  tenantName?: string;
  /** One-line summary from the model brief, when there is one. */
  headline?: string;
  /** Wrap width in columns. Default 80. */
  width?: number;
  /** ANSI colour. Default false. */
  color?: boolean;
}

const BAR_WIDTH = 10;

export function scoreBar(score: number): string {
  const filled = Math.round(Math.min(1, Math.max(0, score)) * BAR_WIDTH);
  return "█".repeat(filled) + "░".repeat(BAR_WIDTH - filled);
}

function longDate(iso: string): string {
  const t = Date.parse(`${iso.slice(0, 10)}T12:00:00Z`);
  if (Number.isNaN(t)) return iso;
  return new Intl.DateTimeFormat("en-US", { timeZone: "UTC", weekday: "long", year: "numeric", month: "long", day: "numeric" }).format(t);
}

function wrap(text: string, width: number, indent: string): string[] {
  const max = Math.max(20, width - indent.length);
  const lines: string[] = [];
  let line = "";
  for (const word of text.split(/\s+/).filter(Boolean)) {
    if (line && line.length + 1 + word.length > max) {
      lines.push(indent + line);
      line = word;
    } else {
      line = line ? `${line} ${word}` : word;
    }
  }
  if (line) lines.push(indent + line);
  return lines;
}

function count(n: number, word: string): string {
  return `${n} ${word}${n === 1 ? "" : "s"}`;
}

function details(it: QueueItem): string {
  const parts: string[] = [];
  const names = it.about.map((a) => a.name ?? a.entityId);
  if (names.length > 0) parts.push(`about ${names.join(", ")}`);
  if (it.dueAt) parts.push(`due ${it.dueAt.slice(0, 10)}`);
  parts.push(`evidence: ${count(it.evidence.factIds.length, "fact")}, ${count(it.evidence.eventIds.length, "event")}`);
  return parts.join(" · ");
}

/** The `yrm today` output. */
export function formatBrief(items: QueueItem[], opts: BriefOptions): string {
  const width = opts.width ?? 80;
  const c = opts.color === true;
  const bold = (s: string): string => (c ? `\x1b[1m${s}\x1b[22m` : s);
  const dim = (s: string): string => (c ? `\x1b[2m${s}\x1b[22m` : s);
  const cyan = (s: string): string => (c ? `\x1b[36m${s}\x1b[39m` : s);

  const out: string[] = [];
  const who = opts.tenantName ? `${opts.tenantName}: ` : "";
  out.push(bold(`${who}${longDate(opts.today)}`));
  out.push(dim(items.length === 0 ? "Nothing needs your attention today." : `${count(items.length, "item")} need${items.length === 1 ? "s" : ""} your attention.`));
  if (opts.headline) {
    out.push("");
    out.push(...wrap(opts.headline, width, ""));
  }
  const numWidth = String(items.length).length;
  items.forEach((it, i) => {
    const num = `${String(i + 1).padStart(numWidth)}.`;
    const indent = " ".repeat(num.length + 1);
    out.push("");
    out.push(`${num} ${cyan(scoreBar(it.score))} ${it.score.toFixed(2)}`);
    out.push(...wrap(it.action, width, indent).map(bold));
    out.push(...wrap(it.reason, width, indent));
    out.push(...wrap(details(it), width, indent).map(dim));
  });
  return out.join("\n");
}

function md(s: string): string {
  return s.replace(/([\\`*_[\]<>|])/g, "\\$1");
}

/** Markdown for the MCP server and README demos. */
export function queueToMarkdown(items: QueueItem[]): string {
  if (items.length === 0) return "_Nothing needs attention._\n";
  const lines = items.map((it, i) => {
    const meta = `score ${it.score.toFixed(2)} · ${md(details(it))} · \`${it.key}\``;
    return `${i + 1}. **${md(it.action)}**  \n   ${md(it.reason)}  \n   ${meta}`;
  });
  return `${lines.join("\n")}\n`;
}
