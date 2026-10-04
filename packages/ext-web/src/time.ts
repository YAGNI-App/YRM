import { todayIn } from "@yrm/core";

const DAY_MS = 86_400_000;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isDate(s: string): boolean {
  return DATE_RE.test(s) && !Number.isNaN(Date.parse(`${s}T00:00:00Z`));
}

/** The calendar day an ISO instant falls on in `tz`. A bare date, or UTC midnight, is already a day. */
export function localDate(iso: string, tz: string): string {
  if (DATE_RE.test(iso)) return iso;
  if (/^\d{4}-\d{2}-\d{2}T00:00:00(\.000)?Z$/.test(iso)) return iso.slice(0, 10);
  const t = Date.parse(iso);
  return Number.isNaN(t) ? iso.slice(0, 10) : todayIn(tz, new Date(t));
}

/** The last instant of `date` in `tz`, so "known by Sep 3" includes everything recorded on Sep 3. */
export function endOfDay(date: string, tz: string): string {
  const guess = Date.parse(`${date}T23:59:59.000Z`);
  const parts = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", {
      timeZone: tz,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    })
      .formatToParts(guess)
      .map((p) => [p.type, p.value]),
  );
  const wall = Date.UTC(+parts.year!, +parts.month! - 1, +parts.day!, +parts.hour!, +parts.minute!, +parts.second!);
  return new Date(guess - (wall - guess) + 999).toISOString();
}

export function addDays(date: string, days: number): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);
}

/**
 * A time-machine parameter: a bare date means the end of that day in the
 * tenant's timezone; a full ISO instant is taken as is. Anything else is
 * rejected rather than silently read as "now".
 */
export function parseWhen(input: string | null | undefined, tz: string): { iso?: string; date?: string; error?: string } {
  if (input === null || input === undefined || input.trim() === "") return {};
  const s = input.trim();
  if (isDate(s)) return { iso: endOfDay(s, tz), date: s };
  const t = Date.parse(s);
  if (/^\d{4}-\d{2}-\d{2}T/.test(s) && !Number.isNaN(t)) {
    const iso = new Date(t).toISOString();
    return { iso, date: localDate(iso, tz) };
  }
  return { error: `expected YYYY-MM-DD or an ISO 8601 instant, got "${s}"` };
}

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

/** "Sep 2, 2026": unambiguous and locale-free, so pages render the same everywhere. */
export function fmtDay(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const d = localDate(iso, tz);
  const [y, m, day] = d.split("-");
  return `${MONTHS[Number(m) - 1] ?? m} ${Number(day)}, ${y}`;
}

/** "Sep 2, 2026 14:05" in the tenant timezone. */
export function fmtInstant(iso: string | undefined, tz: string): string {
  if (!iso) return "";
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const time = new Intl.DateTimeFormat("en-GB", { timeZone: tz, hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).format(t);
  return `${fmtDay(iso, tz)} ${time}`;
}
