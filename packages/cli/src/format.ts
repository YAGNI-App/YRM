/** Small output helpers. ANSI styling only when the caller says the output is a TTY. */

export interface Style {
  bold(s: string): string;
  dim(s: string): string;
  red(s: string): string;
  green(s: string): string;
  yellow(s: string): string;
  cyan(s: string): string;
}

const wrap = (open: number, close: number) => (s: string) => `\u001b[${open}m${s}\u001b[${close}m`;

export function createStyle(color: boolean): Style {
  if (!color) {
    const id = (s: string) => s;
    return { bold: id, dim: id, red: id, green: id, yellow: id, cyan: id };
  }
  return { bold: wrap(1, 22), dim: wrap(2, 22), red: wrap(31, 39), green: wrap(32, 39), yellow: wrap(33, 39), cyan: wrap(36, 39) };
}

const ANSI = /\u001b\[[0-9;]*m/g;

export function visibleWidth(s: string): number {
  return [...s.replace(ANSI, "")].length;
}

export function pad(s: string, width: number, align: "left" | "right" = "left"): string {
  const fill = " ".repeat(Math.max(0, width - visibleWidth(s)));
  return align === "left" ? s + fill : fill + s;
}

export interface TableOptions {
  header?: string[];
  /** Per column; defaults to left. */
  align?: Array<"left" | "right">;
  indent?: string;
  /** Space between columns. */
  gap?: string;
}

/** Fixed-width columns. Trailing whitespace is trimmed from each line. */
export function table(rows: string[][], opts: TableOptions = {}): string[] {
  const all = opts.header ? [opts.header, ...rows] : rows;
  const cols = Math.max(0, ...all.map((r) => r.length));
  const widths = Array.from({ length: cols }, (_, c) => Math.max(0, ...all.map((r) => visibleWidth(r[c] ?? ""))));
  const gap = opts.gap ?? "  ";
  const line = (r: string[]) =>
    (opts.indent ?? "") +
    widths
      .map((w, c) => pad(r[c] ?? "", w, opts.align?.[c] ?? "left"))
      .join(gap)
      .trimEnd();
  const out: string[] = [];
  if (opts.header) {
    out.push(line(opts.header));
    out.push((opts.indent ?? "") + widths.map((w) => "-".repeat(w)).join(gap));
  }
  for (const r of rows) out.push(line(r));
  return out;
}

/** `█████░░░░░` for a 0..1 score. */
export function scoreBar(score: number, width = 10): string {
  const clamped = Math.min(1, Math.max(0, Number.isFinite(score) ? score : 0));
  const filled = Math.round(clamped * width);
  return "█".repeat(filled) + "░".repeat(width - filled);
}

/** ISO date part, or the input when it is not an ISO timestamp. */
export function isoDate(iso: string | undefined): string {
  if (!iso) return "";
  return /^\d{4}-\d{2}-\d{2}/.test(iso) ? iso.slice(0, 10) : iso;
}

/** `2026-06-03 14:05` (UTC) from an ISO timestamp. */
export function isoMinute(iso: string | undefined): string {
  if (!iso) return "";
  return /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}/.test(iso) ? `${iso.slice(0, 10)} ${iso.slice(11, 16)}` : iso;
}

export function ms(n: number): string {
  return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(2)}s`;
}

export function usd(n: number): string {
  if (n === 0) return "$0.00";
  return n < 0.01 ? `$${n.toFixed(4)}` : `$${n.toFixed(2)}`;
}

export function bytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

export function plural(n: number, word: string, many = `${word}s`): string {
  return `${n} ${n === 1 ? word : many}`;
}
