/**
 * Sentence splitting for provenance. Every sentence keeps its character span
 * into the original text, so a fact's quote can be located exactly.
 *
 * Mail is not prose: bullets, numbered lists, greetings and sign-offs each
 * stand alone, and hard-wrapped lines continue a paragraph. Inside a block we
 * split on terminal punctuation, except after abbreviations and
 * inside quoted text ("integrations" with a period inside them is one sentence).
 */

export interface Sentence {
  text: string;
  start: number;
  end: number;
}

const ABBREVIATIONS = new Set([
  // Only words that rarely end a sentence: "no", "sun" or "est" would eat real boundaries.
  "mr", "mrs", "ms", "dr", "prof", "sr", "jr", "st", "vs", "etc", "e.g", "i.e", "inc", "ltd", "corp", "approx",
  "dept", "a.m", "p.m", "u.s", "u.k", "jan", "feb", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov",
  "dec", "tue", "tues", "wed", "thu", "thur", "thurs", "fri", "fig", "cf",
]);

/** `- `, `* `, `• `, `1. `, `2) `, `a) ` at the start of a line. */
const LIST_MARKER = /^[ \t]*(?:[-*•]|\d{1,2}[.)]|[a-z][)])[ \t]+/;

/** Split `text` into blocks: paragraphs, list items and single-line fragments. */
function blocks(text: string): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  const lines: Array<[number, number]> = [];
  let pos = 0;
  while (pos <= text.length) {
    const nl = text.indexOf("\n", pos);
    const end = nl === -1 ? text.length : nl;
    lines.push([pos, end]);
    if (nl === -1) break;
    pos = nl + 1;
  }
  let blockStart: number | null = null;
  let blockEnd = 0;
  for (let i = 0; i < lines.length; i++) {
    const [s, e] = lines[i]!;
    const line = text.slice(s, e);
    if (line.trim() === "") {
      if (blockStart !== null) out.push([blockStart, blockEnd]);
      blockStart = null;
      continue;
    }
    if (blockStart !== null && LIST_MARKER.test(line)) {
      out.push([blockStart, blockEnd]);
      blockStart = null;
    }
    if (blockStart === null) blockStart = s;
    blockEnd = e;
    // A line ending in terminal punctuation or a colon closes the block; a
    // hard-wrapped line (ending mid-sentence) runs on into the next one.
    if (/[.!?:]["'”’)]*\s*$/.test(line)) {
      out.push([blockStart, blockEnd]);
      blockStart = null;
    }
  }
  if (blockStart !== null) out.push([blockStart, blockEnd]);
  return out;
}

function previousWord(text: string, dot: number, floor: number): string {
  let i = dot - 1;
  while (i >= floor && /[A-Za-z.]/.test(text[i]!)) i--;
  return text.slice(i + 1, dot).toLowerCase();
}

function balancedQuotes(s: string): boolean {
  const straight = (s.match(/"/g) ?? []).length;
  const open = (s.match(/“/g) ?? []).length;
  const close = (s.match(/”/g) ?? []).length;
  return straight % 2 === 0 && open === close;
}

function pushTrimmed(out: Sentence[], text: string, start: number, end: number): void {
  let s = start;
  let e = end;
  const marker = LIST_MARKER.exec(text.slice(s, e));
  if (marker) s += marker[0].length;
  while (s < e && /\s/.test(text[s]!)) s++;
  while (e > s && /\s/.test(text[e - 1]!)) e--;
  if (e <= s) return;
  // Collapse hard wraps for readability; the span still points at the original.
  out.push({ text: text.slice(s, e).replace(/\s*\n\s*/g, " "), start: s, end: e });
}

/** Sentences of `text` with spans into it. */
export function splitSentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const [bs, be] of blocks(text)) {
    const block = text.slice(bs, be);
    const trackQuotes = balancedQuotes(block);
    let inQuote = false;
    // A list marker opens its block; its "1." is not a sentence.
    let sentStart = bs + (LIST_MARKER.exec(block)?.[0].length ?? 0);
    /** End of the sentence whose terminal mark is at `p`, or -1 if `p` does not end one. */
    const boundary = (p: number): number => {
      let j = p + 1;
      // Swallow runs of punctuation and closing quotes/brackets: `?!`, `."`, `.)`.
      while (j < be && /[.!?"'”’)\]]/.test(text[j]!)) j++;
      if (j < be && !/\s/.test(text[j]!)) return -1;
      let k = j;
      while (k < be && /\s/.test(text[k]!)) k++;
      if (k < be && !/[A-Z0-9"“'(\[$]/.test(text[k]!)) return -1;
      // Single letters are not treated as initials: "Option A." ends a sentence
      // far more often in mail than "J. Smith" continues one.
      if (text[p] === "." && ABBREVIATIONS.has(previousWord(text, p, sentStart))) return -1;
      return j;
    };
    for (let i = sentStart; i < be; i++) {
      const c = text[i]!;
      let end = -1;
      if (trackQuotes && (c === '"' || c === "“" || c === "”")) {
        inQuote = c === "“" ? true : c === "”" ? false : !inQuote;
        // `said "done."` ends at the closing quote, not inside it.
        if (!inQuote && /[.!?]/.test(text[i - 1] ?? "")) end = boundary(i - 1);
      } else if (!inQuote && (c === "." || c === "!" || c === "?")) {
        end = boundary(i);
      }
      if (end < 0) continue;
      pushTrimmed(out, text, sentStart, end);
      sentStart = end;
      i = end - 1;
    }
    pushTrimmed(out, text, sentStart, be);
  }
  return out;
}
