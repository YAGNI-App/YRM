import { tokens } from "./eval.ts";

/**
 * Content-word overlap between a promise or question and a later message, for
 * closing facts across threads. Names, dates and the delivery verbs themselves
 * say nothing about *what* was delivered, so they are dropped before comparing:
 * "Priya will share pick data by June 23" and "Here you go, as promised: two
 * weeks of pick data" should meet on "pick data", not on "Priya" or "June".
 */

const NOT_CONTENT = new Set(
  (
    "january february march april may june july august september october november december " +
    "jan feb mar apr jun jul aug sep sept oct nov dec " +
    "monday tuesday wednesday thursday friday saturday sunday mon tue tues wed thu thur thurs fri sat sun " +
    "today tomorrow yesterday week weeks eod eow morning afternoon " +
    "send sending sent share sharing shared deliver delivering delivered attached attach promised promise " +
    "get got give back please find go thanks thank received receive done completed hi hello " +
    "ll let know make sure"
  ).split(" "),
);

/** Content words of `s`, minus names, dates and delivery verbs. Possessive `'s` is dropped first. */
export function contentWords(s: string, drop: ReadonlySet<string> = new Set()): Set<string> {
  const out = new Set<string>();
  for (const t of tokens(s.replace(/[’']s\b/gi, ""))) {
    if (NOT_CONTENT.has(t) || drop.has(t) || /^\d+(?:st|nd|rd|th)?$/.test(t)) continue;
    out.add(t);
  }
  return out;
}

export function jaccardSets(x: ReadonlySet<string>, y: ReadonlySet<string>): number {
  if (x.size === 0 || y.size === 0) return 0;
  let inter = 0;
  for (const t of x) if (y.has(t)) inter++;
  return inter / (x.size + y.size - inter);
}

/**
 * Best Jaccard between `target` and any of `candidates`: the whole sentence or
 * one of its clauses. A clause ("Attached is the pilot proposal") is usually
 * where the deliverable is named; the rest of the sentence dilutes it.
 */
export function bestOverlap(target: ReadonlySet<string>, sentence: string, drop: ReadonlySet<string>): number {
  const pieces = [sentence, ...sentence.split(/[,;:()]|\s[-–—]\s/)];
  let best = 0;
  for (const p of pieces) best = Math.max(best, jaccardSets(target, contentWords(p, drop)));
  return best;
}
