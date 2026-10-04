/**
 * Quote and signature stripping for plain-text mail bodies. The goal is that
 * `content.text` holds only what the sender wrote in this message; everything
 * removed is returned as `stripped` so provenance spans can still point at it.
 *
 * Works line by line: some patterns cut from their line to the end of the body
 * (reply attributions, forwarded-header blocks, the `-- ` signature delimiter),
 * others remove single lines (`>` quotes, mobile sign-offs) so interleaved
 * replies survive. Then a heuristic removes a trailing contact block after a
 * sign-off. If all that leaves nothing, the first paragraph is restored.
 */

export interface StripResult {
  text: string;
  stripped: string;
}

/** Attribution lines are matched over up to this many joined lines, since clients wrap them. */
const ATTRIBUTION_SPAN = 3;

const ATTRIBUTION = [
  /^On\b.{0,400}\bwrote\s*:$/i,
  /^Le\b.{0,400}\ba écrit\s*:$/i,
  /^Am\b.{0,400}\bschrieb\b.{0,200}:$/i,
  /^El\b.{0,400}\bescribió\s*:$/i,
  /^Op\b.{0,400}\bschreef\b.{0,200}:$/i,
];

const ORIGINAL_MESSAGE = /^-{2,}\s*(Original Message|Ursprüngliche Nachricht|Message d'origine)\s*-{2,}\s*$/i;
const UNDERSCORE_RULE = /^_{5,}\s*$/;
const HEADER_FROM = /^\*?(From|De|Von)\s*:\*?\s*\S/i;
const HEADER_OTHER = /^\*?(Sent|Date|To|Subject|Cc|Envoyé|Gesendet|Objet|Betreff|À|An)\s*:\*?/i;
const SIG_DELIMITER = /^--\s*$/;
const MOBILE = /^(Sent from my \S.*|Sent from (Outlook|Mail|Yahoo Mail|Gmail)\b.*|Get Outlook for (iOS|Android).*|Sent via .*mobile.*)$/i;
const SIGN_OFF = /^(thanks|thank you|thanks again|many thanks|best|best regards|kind regards|warm regards|regards|cheers|all the best|sincerely|talk soon|speak soon)[,.!]?$/i;
const PHONE = /(\+?\d[\d\s().-]{7,}\d)/;
const URL = /(https?:\/\/|www\.|\b[a-z0-9-]+\.(com|io|net|org|co|ai|app|dev|example)\b)/i;
const TITLE = /\b(CEO|CTO|COO|CFO|CRO|VP|SVP|EVP|Director|Manager|Head of|Founder|Co-founder|Engineer|Lead|Partner|President|Officer|Consultant|Specialist|Analyst|Architect|Counsel|Associate)\b/i;

function isAttribution(lines: string[], i: number): boolean {
  let joined = "";
  for (let k = 0; k < ATTRIBUTION_SPAN && i + k < lines.length; k++) {
    const line = lines[i + k]!.trim();
    if (k > 0 && line === "") break;
    joined = k === 0 ? line : `${joined} ${line}`;
    if (ATTRIBUTION.some((re) => re.test(joined))) return true;
  }
  return false;
}

/** `From:` followed within a few lines by at least one other header line (Outlook/Apple reply blocks). */
function isHeaderBlock(lines: string[], i: number): boolean {
  if (!HEADER_FROM.test(lines[i]!.trim())) return false;
  let others = 0;
  for (let k = 1; k <= 4 && i + k < lines.length; k++) {
    if (HEADER_OTHER.test(lines[i + k]!.trim())) others++;
  }
  return others >= 2;
}

/** Index where quoted history or the signature starts, or `lines.length`. */
function cutIndex(lines: string[]): number {
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!.trim();
    // Must check the raw line: "-- " is the delimiter, a line of prose ending in "--" is not.
    if (SIG_DELIMITER.test(lines[i]!)) return i;
    if (ORIGINAL_MESSAGE.test(line)) return i;
    if (isAttribution(lines, i)) return i;
    if (UNDERSCORE_RULE.test(line)) {
      let k = i + 1;
      while (k < lines.length && lines[k]!.trim() === "") k++;
      if (k < lines.length && isHeaderBlock(lines, k)) return i;
    }
    if (isHeaderBlock(lines, i)) return i;
  }
  return lines.length;
}

const isShort = (line: string): boolean => line.trim().length <= 80;
const looksLikeName = (line: string): boolean => {
  const t = line.trim();
  return t.length > 0 && t.length <= 40 && !/[.?!:;]$/.test(t) && t.split(/\s+/).length <= 5;
};

/**
 * After a sign-off and a name line, up to 6 short trailing lines with a phone,
 * title or URL are a contact block. Returns the index of the first line to drop.
 */
function contactBlockStart(lines: string[], keep: boolean[]): number | undefined {
  const kept = lines.map((_, i) => i).filter((i) => keep[i] && lines[i]!.trim() !== "");
  for (let n = kept.length - 2; n >= 0 && n >= kept.length - 9; n--) {
    const signOff = kept[n]!;
    if (!SIGN_OFF.test(lines[signOff]!.trim())) continue;
    const name = kept[n + 1]!;
    if (!looksLikeName(lines[name]!)) continue;
    const tail = kept.slice(n + 2);
    if (tail.length === 0 || tail.length > 6) return undefined;
    if (!tail.every((i) => isShort(lines[i]!))) return undefined;
    if (!tail.some((i) => PHONE.test(lines[i]!) || URL.test(lines[i]!) || TITLE.test(lines[i]!))) return undefined;
    return name + 1;
  }
  return undefined;
}

function joinLines(lines: string[], mask: boolean[], want: boolean): string {
  return lines
    .filter((_, i) => mask[i] === want)
    .map((l) => (l.trim() === "" ? "" : l.trimEnd()))
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/^\n+|\n+$/g, "");
}

export function stripQuotes(input: string): StripResult {
  const lines = input.replace(/\r\n?/g, "\n").split("\n");
  const keep = lines.map(() => true);

  const cut = cutIndex(lines);
  for (let i = cut; i < lines.length; i++) keep[i] = false;

  for (let i = 0; i < cut; i++) {
    const line = lines[i]!.trim();
    if (line.startsWith(">") || MOBILE.test(line)) keep[i] = false;
  }

  const contact = contactBlockStart(lines, keep);
  if (contact !== undefined) for (let i = contact; i < lines.length; i++) keep[i] = false;

  // Never return nothing for a message that said something: fall back to its first paragraph.
  if (!lines.some((l, i) => keep[i] && l.trim() !== "")) {
    const start = lines.findIndex((l) => l.trim() !== "");
    for (let i = start; start >= 0 && i < lines.length && lines[i]!.trim() !== ""; i++) keep[i] = true;
  }

  return { text: joinLines(lines, keep, true), stripped: joinLines(lines, keep, false) };
}
