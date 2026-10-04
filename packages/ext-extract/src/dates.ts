/**
 * A small due-date resolver for phrases people put after "by" in mail:
 * "by Friday", "tomorrow", "EOD", "end of week", "next week", "June 5",
 * "5 June", "06/05", "2026-06-05", "the 17th".
 *
 * Dates resolve relative to the event's `occurredAt` and come back as ISO
 * calendar dates (YYYY-MM-DD). The reference day is the calendar date written
 * in `occurredAt`: with an offset that is the sender's local date, with `Z` it
 * is the UTC date. "Next week" and "end of week" mean that week's Friday,
 * because that is what people mean when they promise something for a week.
 */

export interface DueMatch {
  /** ISO calendar date, YYYY-MM-DD. */
  dueAt: string;
  /** The phrase that produced it, as written. */
  phrase: string;
  index: number;
}

const MONTHS: Record<string, number> = {
  january: 0, jan: 0, february: 1, feb: 1, march: 2, mar: 2, april: 3, apr: 3, may: 4, june: 5, jun: 5,
  july: 6, jul: 6, august: 7, aug: 7, september: 8, sep: 8, sept: 8, october: 9, oct: 9, november: 10, nov: 10,
  december: 11, dec: 11,
};
const MONTH_RE =
  "(january|february|march|april|may|june|july|august|september|october|november|december|jan|feb|mar|apr|jun|jul|aug|sept|sep|oct|nov|dec)";

const WEEKDAYS: Record<string, number> = {
  sunday: 0, sun: 0, monday: 1, mon: 1, tuesday: 2, tue: 2, tues: 2, wednesday: 3, wed: 3, thursday: 4, thu: 4,
  thur: 4, thurs: 4, friday: 5, fri: 5, saturday: 6, sat: 6,
};
const WEEKDAY_RE = "(sunday|monday|tuesday|wednesday|thursday|friday|saturday)";

const DAY_MS = 86_400_000;
/** An explicit date without a year this far before the reference is read as next year. */
const PAST_TOLERANCE_DAYS = 60;

/** Midnight UTC of the calendar date written in `occurredAt`. */
export function referenceDay(occurredAt: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(occurredAt);
  if (m) return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  const d = new Date(occurredAt);
  if (Number.isNaN(d.getTime())) throw new RangeError(`invalid occurredAt: ${occurredAt}`);
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function addDays(d: Date, n: number): Date {
  return new Date(d.getTime() + n * DAY_MS);
}

function makeDate(year: number, month: number, day: number): Date | undefined {
  const d = new Date(Date.UTC(year, month, day));
  return d.getUTCMonth() === month && d.getUTCDate() === day ? d : undefined;
}

/** A month/day with no year: this year, unless that is well in the past. */
function yearless(ref: Date, month: number, day: number): Date | undefined {
  const d = makeDate(ref.getUTCFullYear(), month, day);
  if (!d) return undefined;
  if (d.getTime() < ref.getTime() - PAST_TOLERANCE_DAYS * DAY_MS) return makeDate(ref.getUTCFullYear() + 1, month, day);
  return d;
}

function fullYear(y: string | undefined, ref: Date): number {
  if (y === undefined) return ref.getUTCFullYear();
  const n = Number(y);
  return n < 100 ? 2000 + n : n;
}

/** Next occurrence of `weekday` strictly after `ref`. */
function nextWeekday(ref: Date, weekday: number): Date {
  const delta = (weekday - ref.getUTCDay() + 7) % 7 || 7;
  return addDays(ref, delta);
}

/** Friday of the week containing `ref` (weeks start Monday); on a weekend, the coming Friday. */
function fridayOfWeek(ref: Date): Date {
  const dow = ref.getUTCDay();
  if (dow === 6 || dow === 0) return nextWeekday(ref, 5);
  return addDays(ref, 5 - dow);
}

function mondayOfNextWeek(ref: Date): Date {
  const dow = ref.getUTCDay();
  return addDays(ref, ((8 - dow) % 7) || 7);
}

interface Rule {
  re: RegExp;
  resolve(m: RegExpExecArray, ref: Date): Date | undefined;
}

// Ordered by specificity: an explicit calendar date beats a weekday in the same phrase.
const RULES: Rule[] = [
  {
    re: /\b(\d{4})-(\d{2})-(\d{2})\b/g,
    resolve: (m) => makeDate(Number(m[1]), Number(m[2]) - 1, Number(m[3])),
  },
  {
    re: new RegExp(`\\b${MONTH_RE}\\.?\\s+(\\d{1,2})(?:st|nd|rd|th)?\\b(?:,?\\s+(\\d{4})\\b)?`, "gi"),
    resolve: (m, ref) => {
      const month = MONTHS[m[1]!.toLowerCase()]!;
      const day = Number(m[2]);
      return m[3] ? makeDate(Number(m[3]), month, day) : yearless(ref, month, day);
    },
  },
  {
    re: new RegExp(`\\b(\\d{1,2})(?:st|nd|rd|th)?\\s+(?:of\\s+)?${MONTH_RE}\\b(?:,?\\s+(\\d{4})\\b)?`, "gi"),
    resolve: (m, ref) => {
      const month = MONTHS[m[2]!.toLowerCase()]!;
      const day = Number(m[1]);
      return m[3] ? makeDate(Number(m[3]), month, day) : yearless(ref, month, day);
    },
  },
  {
    // US order. 24/7 and fractions fail validation or the month check.
    re: /\b(\d{1,2})\/(\d{1,2})(?:\/(\d{2}|\d{4}))?\b/g,
    resolve: (m, ref) => {
      const month = Number(m[1]) - 1;
      const day = Number(m[2]);
      if (month < 0 || month > 11) return undefined;
      return m[3] ? makeDate(fullYear(m[3], ref), month, day) : yearless(ref, month, day);
    },
  },
  {
    re: /\bthe\s+(\d{1,2})(?:st|nd|rd|th)\b/gi,
    resolve: (m, ref) => {
      const day = Number(m[1]);
      for (let i = 0; i < 3; i++) {
        const base = new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + i, 1));
        const cand = makeDate(base.getUTCFullYear(), base.getUTCMonth(), day);
        if (cand && cand.getTime() >= ref.getTime()) return cand;
      }
      return undefined;
    },
  },
  { re: /\btomorrow\b/gi, resolve: (_m, ref) => addDays(ref, 1) },
  {
    re: /\b(?:eod|cob|end of (?:the )?(?:business )?day|close of business|tonight|today)\b/gi,
    resolve: (_m, ref) => ref,
  },
  { re: /\bend of (?:the |this )?week\b/gi, resolve: (_m, ref) => fridayOfWeek(ref) },
  {
    re: /\bend of (?:the |this )?month\b/gi,
    resolve: (_m, ref) => new Date(Date.UTC(ref.getUTCFullYear(), ref.getUTCMonth() + 1, 0)),
  },
  { re: /\bnext week\b/gi, resolve: (_m, ref) => addDays(mondayOfNextWeek(ref), 4) },
  {
    re: new RegExp(`\\b(next|this)?\\s*${WEEKDAY_RE}\\b`, "gi"),
    resolve: (m, ref) => {
      const wd = WEEKDAYS[m[2]!.toLowerCase()]!;
      if (m[1]?.toLowerCase() === "next") return addDays(mondayOfNextWeek(ref), (wd + 6) % 7);
      return nextWeekday(ref, wd);
    },
  },
  { re: /\bthis week\b/gi, resolve: (_m, ref) => fridayOfWeek(ref) },
];

/** Words that mark a phrase as a deadline rather than an incidental date. */
const DEADLINE_CUE = new RegExp(
  `\\b(?:by|before|until|till|due|no later than|on or before)\\s+(?:the\\s+)?(?:end of\\s+)?(?:(?:next|this)\\s+)?(?:${WEEKDAY_RE},?\\s+)?$`,
  "i",
);

/**
 * Find the due date in `text`. When several dates appear, one introduced by a
 * deadline cue ("by", "before", "until") wins; otherwise the most specific.
 */
export function findDue(text: string, occurredAt: string): DueMatch | undefined {
  const ref = referenceDay(occurredAt);
  const candidates: Array<DueMatch & { rank: number; cued: boolean }> = [];
  const claimed: Array<[number, number]> = [];
  RULES.forEach((rule, rank) => {
    rule.re.lastIndex = 0;
    for (let m = rule.re.exec(text); m !== null; m = rule.re.exec(text)) {
      const start = m.index + (m[0].length - m[0].trimStart().length);
      const end = m.index + m[0].length;
      // A less specific rule may not reuse text a more specific one already read ("Friday, June 5").
      if (claimed.some(([s, e]) => start < e && end > s)) continue;
      const d = rule.resolve(m, ref);
      if (!d) continue;
      claimed.push([start, end]);
      const before = text.slice(Math.max(0, start - 40), start);
      candidates.push({ dueAt: isoDate(d), phrase: m[0].trim(), index: start, rank, cued: DEADLINE_CUE.test(before) });
    }
  });
  if (candidates.length === 0) return undefined;
  // "by Friday, June 5": both are cued, and the explicit date outranks the weekday.
  candidates.sort((a, b) => Number(b.cued) - Number(a.cued) || a.rank - b.rank || a.index - b.index);
  const best = candidates[0]!;
  return { dueAt: best.dueAt, phrase: best.phrase, index: best.index };
}

/** Convenience: just the date. */
export function resolveDue(text: string, occurredAt: string): string | undefined {
  return findDue(text, occurredAt)?.dueAt;
}
