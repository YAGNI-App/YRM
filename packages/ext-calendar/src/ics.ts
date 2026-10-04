/**
 * A small, dependency-free iCalendar (RFC 5545) reader. It covers what a
 * meeting log needs from VEVENTs: identity, times, people, status and text.
 * It does not expand RRULEs; recurring masters are returned once with the
 * rule attached so a later version can expand them.
 */

export interface IcsProperty {
  /** Upper-cased property name, e.g. "DTSTART". */
  name: string;
  /** Parameter names upper-cased; values unquoted. */
  params: Record<string, string>;
  /** Raw value, still escaped for TEXT properties. */
  value: string;
}

export interface IcsDate {
  /** ISO 8601 UTC instant. All-day dates are midnight UTC of that date. */
  iso: string;
  allDay: boolean;
  /** The TZID the source gave, when any. */
  tzid?: string;
}

export interface CalAddress {
  /** Lower-cased email address with `mailto:` removed; absent when the value is not an address. */
  address?: string;
  /** Common name (CN) as given. */
  name?: string;
  /** Participation status (PARTSTAT), upper-cased. */
  partstat?: string;
  role?: string;
}

export interface VEvent {
  uid: string;
  summary?: string;
  description?: string;
  location?: string;
  url?: string;
  /** Upper-cased STATUS: TENTATIVE, CONFIRMED or CANCELLED. */
  status?: string;
  sequence: number;
  start?: IcsDate;
  end?: IcsDate;
  recurrenceId?: IcsDate;
  rrule?: string;
  organizer?: CalAddress;
  attendees: CalAddress[];
  /** Every property as parsed, for callers that need something not modelled here. */
  props: IcsProperty[];
}

export interface IcsCalendar {
  /** Calendar-level METHOD (PUBLISH, REQUEST, CANCEL), upper-cased. */
  method?: string;
  events: VEvent[];
  /** Non-fatal problems: unknown TZIDs, events without UID, RRULEs not expanded. */
  warnings: string[];
}

export interface ParseOptions {
  /** IANA zone for floating times (no `Z`, no TZID). Defaults to UTC. */
  defaultTimezone?: string;
}

/** Undo RFC 5545 line folding: CRLF (or LF) followed by one space or tab continues the line. */
export function unfold(raw: string): string[] {
  return raw
    .replace(/^﻿/, "")
    .replace(/\r?\n[ \t]/g, "")
    .split(/\r?\n/)
    .filter((l) => l.length > 0);
}

/** Split `NAME;P1=a;P2="b:c":value` respecting quoted parameter values. */
export function parseProperty(line: string): IcsProperty | null {
  let i = 0;
  let inQuotes = false;
  const parts: string[] = [];
  let start = 0;
  for (; i < line.length; i++) {
    const c = line[i];
    if (c === '"') inQuotes = !inQuotes;
    else if (!inQuotes && c === ";") {
      parts.push(line.slice(start, i));
      start = i + 1;
    } else if (!inQuotes && c === ":") break;
  }
  if (i >= line.length) return null;
  parts.push(line.slice(start, i));
  const [name, ...rawParams] = parts;
  if (!name) return null;
  const params: Record<string, string> = {};
  for (const p of rawParams) {
    const eq = p.indexOf("=");
    if (eq <= 0) continue;
    params[p.slice(0, eq).toUpperCase()] = p.slice(eq + 1).replace(/^"(.*)"$/, "$1");
  }
  return { name: name.toUpperCase(), params, value: line.slice(i + 1) };
}

/** Unescape a TEXT value: `\n`, `\N`, `\,`, `\;` and `\\`. */
export function unescapeText(value: string): string {
  return value.replace(/\\([nN,;\\])/g, (_, c: string) => (c === "n" || c === "N" ? "\n" : c));
}

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatterFor(timeZone: string): Intl.DateTimeFormat {
  let f = formatters.get(timeZone);
  if (!f) {
    // Throws RangeError for unknown zones; callers turn that into a warning.
    f = new Intl.DateTimeFormat("en-US", {
      timeZone,
      hourCycle: "h23",
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      second: "2-digit",
    });
    formatters.set(timeZone, f);
  }
  return f;
}

/** Offset of `timeZone` from UTC at instant `ms`, in milliseconds (Denver in summer: -6h). */
export function zoneOffsetMs(ms: number, timeZone: string): number {
  const parts: Record<string, number> = {};
  for (const p of formatterFor(timeZone).formatToParts(new Date(ms))) {
    if (p.type !== "literal") parts[p.type] = Number(p.value);
  }
  const asUtc = Date.UTC(parts["year"]!, parts["month"]! - 1, parts["day"]!, parts["hour"]!, parts["minute"]!, parts["second"]!);
  return asUtc - Math.floor(ms / 1000) * 1000;
}

/** Convert a wall-clock time in `timeZone` to a UTC instant (ms). */
export function zonedToUtc(wallMs: number, timeZone: string): number {
  // Guess with the offset at the wall time read as UTC, then correct once for
  // DST transitions between the guess and the answer.
  const first = wallMs - zoneOffsetMs(wallMs, timeZone);
  const second = wallMs - zoneOffsetMs(first, timeZone);
  return second;
}

const DATE_RE = /^(\d{4})(\d{2})(\d{2})$/;
const DATE_TIME_RE = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})(Z?)$/;

/**
 * Convert a DATE or DATE-TIME property to an ISO instant. `Z` is UTC; a TZID
 * is resolved through Intl; floating times use `defaultTimezone`.
 */
export function parseIcsDate(prop: IcsProperty, defaultTimezone = "UTC", warnings: string[] = []): IcsDate | null {
  const value = prop.value.trim();
  const d = DATE_RE.exec(value);
  if (d || prop.params["VALUE"] === "DATE") {
    if (!d) return null;
    return { iso: new Date(Date.UTC(+d[1]!, +d[2]! - 1, +d[3]!)).toISOString(), allDay: true };
  }
  const m = DATE_TIME_RE.exec(value);
  if (!m) {
    warnings.push(`${prop.name}: unrecognised date "${value}"`);
    return null;
  }
  const wall = Date.UTC(+m[1]!, +m[2]! - 1, +m[3]!, +m[4]!, +m[5]!, +m[6]!);
  const tzid = prop.params["TZID"];
  const out = (ms: number): IcsDate => {
    const r: IcsDate = { iso: new Date(ms).toISOString(), allDay: false };
    if (tzid !== undefined) r.tzid = tzid;
    return r;
  };
  if (m[7] === "Z") return out(wall);
  const zone = tzid ?? defaultTimezone;
  try {
    return out(zonedToUtc(wall, zone));
  } catch {
    warnings.push(`${prop.name}: unknown TZID "${zone}", reading the time as UTC`);
    return out(wall);
  }
}

/** Parse an RFC 5545 DURATION (`P1D`, `PT1H30M`, `P2W`) to milliseconds. */
export function parseDuration(value: string): number | null {
  const m = /^([+-])?P(?:(\d+)W)?(?:(\d+)D)?(?:T(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?)?$/.exec(value.trim());
  if (!m) return null;
  const [, sign, w, d, h, min, s] = m;
  const ms = (((+(w ?? 0) * 7 + +(d ?? 0)) * 24 + +(h ?? 0)) * 60 + +(min ?? 0)) * 60_000 + +(s ?? 0) * 1000;
  return sign === "-" ? -ms : ms;
}

function calAddress(prop: IcsProperty): CalAddress {
  const out: CalAddress = {};
  const v = prop.value.trim();
  const addr = v.replace(/^mailto:/i, "");
  if (addr.includes("@")) out.address = addr.toLowerCase();
  if (prop.params["CN"]) out.name = prop.params["CN"];
  if (prop.params["PARTSTAT"]) out.partstat = prop.params["PARTSTAT"].toUpperCase();
  if (prop.params["ROLE"]) out.role = prop.params["ROLE"].toUpperCase();
  return out;
}

function buildEvent(props: IcsProperty[], tz: string, warnings: string[]): VEvent | null {
  const first = (name: string): IcsProperty | undefined => props.find((p) => p.name === name);
  const text = (name: string): string | undefined => {
    const p = first(name);
    return p ? unescapeText(p.value) : undefined;
  };
  const uid = first("UID")?.value.trim();
  if (!uid) {
    warnings.push(`VEVENT without UID skipped (SUMMARY: ${text("SUMMARY") ?? "none"})`);
    return null;
  }
  const ev: VEvent = { uid, sequence: Number.parseInt(first("SEQUENCE")?.value ?? "0", 10) || 0, attendees: [], props };
  const set = <K extends keyof VEvent>(key: K, value: VEvent[K] | undefined | null): void => {
    if (value !== undefined && value !== null) ev[key] = value;
  };
  set("summary", text("SUMMARY"));
  set("description", text("DESCRIPTION"));
  set("location", text("LOCATION"));
  set("url", first("URL")?.value.trim());
  set("status", first("STATUS")?.value.trim().toUpperCase());
  set("rrule", first("RRULE")?.value.trim());

  const dtstart = first("DTSTART");
  const start = dtstart ? parseIcsDate(dtstart, tz, warnings) : null;
  set("start", start);
  const dtend = first("DTEND");
  if (dtend) set("end", parseIcsDate(dtend, tz, warnings));
  else if (start) {
    // RFC 5545: no DTEND means DURATION, else one day for dates and zero for date-times.
    const dur = first("DURATION");
    const ms = dur ? parseDuration(dur.value) : start.allDay ? 86_400_000 : 0;
    const end: IcsDate = { ...start, iso: new Date(Date.parse(start.iso) + (ms ?? 0)).toISOString() };
    ev.end = end;
  }
  const rid = first("RECURRENCE-ID");
  if (rid) set("recurrenceId", parseIcsDate(rid, tz, warnings));

  const org = first("ORGANIZER");
  if (org) ev.organizer = calAddress(org);
  ev.attendees = props.filter((p) => p.name === "ATTENDEE").map(calAddress);
  return ev;
}

/** Parse every VEVENT in an iCalendar document. Nested components (VALARM) are ignored. */
export function parseIcs(raw: string, opts: ParseOptions = {}): IcsCalendar {
  const tz = opts.defaultTimezone ?? "UTC";
  const cal: IcsCalendar = { events: [], warnings: [] };
  let current: IcsProperty[] | null = null;
  // Depth of components nested inside the current VEVENT (VALARM and friends).
  let nested = 0;
  for (const line of unfold(raw)) {
    const prop = parseProperty(line);
    if (!prop) continue;
    if (prop.name === "BEGIN") {
      const what = prop.value.trim().toUpperCase();
      if (current) nested++;
      else if (what === "VEVENT") current = [];
      continue;
    }
    if (prop.name === "END") {
      const what = prop.value.trim().toUpperCase();
      if (current && nested > 0) nested--;
      else if (current && what === "VEVENT") {
        const ev = buildEvent(current, tz, cal.warnings);
        if (ev) cal.events.push(ev);
        current = null;
      }
      continue;
    }
    if (current) {
      if (nested === 0) current.push(prop);
    } else if (prop.name === "METHOD") cal.method = prop.value.trim().toUpperCase();
  }
  for (const ev of cal.events) {
    if (ev.rrule) cal.warnings.push(`event ${ev.uid} has RRULE "${ev.rrule}"; recurrence is not expanded in 0.1`);
  }
  return cal;
}
