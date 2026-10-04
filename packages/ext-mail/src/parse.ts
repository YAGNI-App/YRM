/**
 * A small, dependency-free RFC 5322 / MIME parser. It covers what an ingester
 * needs (addressing, threading, bulk-mail signals, a readable body) and makes
 * no attempt to round-trip a message. Input is the message as a string; 8bit
 * bodies are assumed to already be decoded (files are read as UTF-8), while
 * quoted-printable and base64 parts are decoded with their declared charset.
 */

export interface Address {
  /** Lowercased. */
  address: string;
  /** Display name with RFC 2047 encoded words decoded, quotes removed. */
  name?: string;
}

export interface Attachment {
  contentType: string;
  filename?: string;
  /** Size of the encoded part body in characters, a rough guide only. */
  size: number;
}

export interface ParsedMessage {
  /** Unfolded raw header values keyed by lowercase name, in message order. */
  headers: Record<string, string[]>;
  /** As written in the header, angle brackets included, e.g. `<abc@host>`. */
  messageId?: string;
  inReplyTo?: string;
  references: string[];
  /** `Date` header as ISO 8601 UTC. */
  date?: string;
  /** Most recent `Received` timestamp as ISO 8601, when any `Received` header has one. */
  receivedAt?: string;
  from: Address[];
  to: Address[];
  cc: Address[];
  bcc: Address[];
  replyTo: Address[];
  subject?: string;
  listId?: string;
  listUnsubscribe?: string;
  precedence?: string;
  autoSubmitted?: string;
  autoResponseSuppress?: string;
  /** Readable body: the text/plain part, else the stripped text/html part. */
  text: string;
  /** Which part `text` came from. */
  bodyType: "text/plain" | "text/html" | "none";
  attachments: Attachment[];
  /** The raw header block and body, kept for content hashing when there is no Message-ID. */
  rawHeaders: string;
  rawBody: string;
}

// ---- headers -----------------------------------------------------------------

interface Entity {
  headers: Record<string, string[]>;
  body: string;
  rawHeaders: string;
}

function splitEntity(raw: string): Entity {
  const text = raw.replace(/\r\n?/g, "\n");
  // A MIME part may have no headers at all: it then starts with the blank line.
  if (text.startsWith("\n")) return { headers: {}, body: text.slice(1), rawHeaders: "" };
  // Headers end at the first empty line. A message with no blank line is all headers.
  const sep = text.indexOf("\n\n");
  const rawHeaders = sep < 0 ? text : text.slice(0, sep);
  const body = sep < 0 ? "" : text.slice(sep + 2);
  return { headers: parseHeaders(rawHeaders), body, rawHeaders };
}

/** Unfold (RFC 5322 2.2.3) and split a header block. Lines without a colon are ignored. */
export function parseHeaders(block: string): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  const unfolded = block.replace(/\r\n?/g, "\n").replace(/\n(?=[ \t])/g, "");
  for (const line of unfolded.split("\n")) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const name = line.slice(0, i).trim().toLowerCase();
    if (!/^[\x21-\x39\x3b-\x7e]+$/.test(name)) continue;
    (out[name] ??= []).push(line.slice(i + 1).trim());
  }
  return out;
}

const first = (h: Record<string, string[]>, name: string): string | undefined => h[name]?.[0];

// ---- encodings ---------------------------------------------------------------

function decodeBytes(bytes: Uint8Array, charset: string | undefined): string {
  const label = (charset ?? "utf-8").trim().toLowerCase().replace(/\*.*$/, "") || "utf-8";
  try {
    return new TextDecoder(label as ConstructorParameters<typeof TextDecoder>[0]).decode(bytes);
  } catch {
    // Unknown label: Latin-1 never fails and keeps ASCII intact.
    return new TextDecoder("latin1").decode(bytes);
  }
}

function base64Bytes(s: string): Uint8Array {
  const clean = s.replace(/[^A-Za-z0-9+/=_-]/g, "").replace(/-/g, "+").replace(/_/g, "/");
  const padded = clean.replace(/=+$/, "");
  return Uint8Array.from(Buffer.from(padded + "=".repeat((4 - (padded.length % 4)) % 4), "base64"));
}

/** Quoted-printable to bytes. Non-ASCII characters already in the string are kept as UTF-8. */
function qpBytes(s: string, headerMode = false): Uint8Array {
  const src = headerMode ? s.replace(/_/g, " ") : s.replace(/=\n/g, "");
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < src.length; i++) {
    const c = src[i]!;
    if (c === "=" && /^[0-9A-Fa-f]{2}$/.test(src.slice(i + 1, i + 3))) {
      out.push(parseInt(src.slice(i + 1, i + 3), 16));
      i += 2;
    } else {
      out.push(...enc.encode(c));
    }
  }
  return Uint8Array.from(out);
}

export function decodeQuotedPrintable(s: string, charset?: string): string {
  return decodeBytes(qpBytes(s.replace(/\r\n?/g, "\n")), charset);
}

export function decodeBase64(s: string, charset?: string): string {
  return decodeBytes(base64Bytes(s), charset);
}

/** Decode RFC 2047 encoded words. Whitespace between adjacent encoded words is dropped. */
export function decodeEncodedWords(value: string): string {
  const word = /=\?([^?\s]+)\?([BbQq])\?([^?\s]*)\?=/g;
  const joined = value.replace(/(=\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)\s+(?==\?[^?\s]+\?[BbQq]\?[^?\s]*\?=)/g, "$1");
  return joined.replace(word, (_m, charset: string, enc: string, text: string) =>
    enc.toUpperCase() === "B" ? decodeBytes(base64Bytes(text), charset) : decodeBytes(qpBytes(text, true), charset),
  );
}

// ---- structured fields ---------------------------------------------------------

/** Remove RFC 5322 comments `( ... )`, respecting quoted strings and nesting. */
function stripComments(s: string): string {
  let out = "";
  let depth = 0;
  let quoted = false;
  for (let i = 0; i < s.length; i++) {
    const c = s[i]!;
    if (c === "\\" && i + 1 < s.length) {
      if (depth === 0) out += c + s[i + 1];
      i++;
      continue;
    }
    if (!quoted && c === "(") depth++;
    else if (!quoted && c === ")" && depth > 0) depth--;
    else if (depth === 0) {
      if (c === '"') quoted = !quoted;
      out += c;
    }
  }
  return out;
}

function unquote(s: string): string {
  const t = s.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) return t.slice(1, -1).replace(/\\(.)/g, "$1");
  return t;
}

/** Split an address list on top-level commas, treating group syntax `name: a, b;` as plain members. */
function splitAddressList(value: string): string[] {
  const parts: string[] = [];
  let cur = "";
  let quoted = false;
  let angle = 0;
  let paren = 0;
  for (let i = 0; i < value.length; i++) {
    const c = value[i]!;
    if (c === "\\" && i + 1 < value.length) {
      cur += c + value[++i];
      continue;
    }
    if (c === '"' && paren === 0) quoted = !quoted;
    else if (!quoted && c === "(") paren++;
    else if (!quoted && c === ")" && paren > 0) paren--;
    else if (!quoted && paren === 0 && c === "<") angle++;
    else if (!quoted && paren === 0 && c === ">" && angle > 0) angle--;
    else if (!quoted && paren === 0 && angle === 0) {
      if (c === "," || c === ";") {
        parts.push(cur);
        cur = "";
        continue;
      }
      if (c === ":") {
        // Group display name; drop it and keep its members.
        cur = "";
        continue;
      }
    }
    cur += c;
  }
  parts.push(cur);
  return parts.map((p) => p.trim()).filter((p) => p.length > 0);
}

export function parseAddressList(value: string | undefined): Address[] {
  if (!value) return [];
  const out: Address[] = [];
  for (const part of splitAddressList(value)) {
    const angle = /<([^<>]*)>\s*$/.exec(part);
    let address: string;
    let name: string | undefined;
    if (angle) {
      address = angle[1]!.trim();
      name = unquote(stripComments(part.slice(0, angle.index)));
    } else {
      // Bare address, possibly with an old-style `(Name)` comment.
      const comment = /\(([^()]*)\)/.exec(part);
      address = stripComments(part).trim();
      name = comment ? comment[1]!.trim() : undefined;
    }
    address = address.replace(/^mailto:/i, "").trim().toLowerCase();
    if (!address.includes("@")) continue;
    const decoded = name ? decodeEncodedWords(name).trim() : "";
    out.push(decoded && decoded.toLowerCase() !== address ? { address, name: decoded } : { address });
  }
  return out;
}

/** Every `<id>` token in a Message-ID style field, in order. */
export function parseMessageIds(value: string | undefined): string[] {
  if (!value) return [];
  const ids = [...stripComments(value).matchAll(/<[^<>\s]+>/g)].map((m) => m[0]);
  if (ids.length > 0) return ids;
  // Some senders omit the brackets; accept a lone id-shaped token.
  const bare = stripComments(value).trim();
  return /^[^\s<>]+@[^\s<>]+$/.test(bare) ? [`<${bare}>`] : [];
}

const MONTHS: Record<string, number> = {
  jan: 0, feb: 1, mar: 2, apr: 3, may: 4, jun: 5, jul: 6, aug: 7, sep: 8, oct: 9, nov: 10, dec: 11,
};
// RFC 5322 4.3 obsolete zones; military zones are treated as UTC per the RFC's advice.
const ZONES: Record<string, number> = {
  UT: 0, GMT: 0, Z: 0, EST: -300, EDT: -240, CST: -360, CDT: -300, MST: -420, MDT: -360, PST: -480, PDT: -420,
};

/** RFC 2822 date to ISO 8601 UTC, or undefined when it cannot be read. */
export function parseRfc2822Date(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const s = stripComments(value).replace(/\s+/g, " ").trim();
  const m = /^(?:[A-Za-z]{3},?\s*)?(\d{1,2})\s+([A-Za-z]{3})[a-z]*\s+(\d{2,4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?\s*([+-]\d{4}|[A-Za-z]{1,5})?/.exec(s);
  if (m) {
    const month = MONTHS[m[2]!.toLowerCase()];
    let year = Number(m[3]);
    if (m[3]!.length === 2) year += year < 50 ? 2000 : 1900;
    else if (m[3]!.length === 3) year += 1900;
    if (month !== undefined) {
      const zone = m[7];
      let offset = 0;
      if (zone && /^[+-]\d{4}$/.test(zone)) {
        const sign = zone[0] === "-" ? -1 : 1;
        offset = sign * (Number(zone.slice(1, 3)) * 60 + Number(zone.slice(3, 5)));
      } else if (zone) {
        offset = ZONES[zone.toUpperCase()] ?? 0;
      }
      const utc = Date.UTC(year, month, Number(m[1]), Number(m[4]), Number(m[5]), Number(m[6] ?? 0)) - offset * 60_000;
      if (!Number.isNaN(utc)) return new Date(utc).toISOString();
    }
  }
  const fallback = Date.parse(s);
  return Number.isNaN(fallback) ? undefined : new Date(fallback).toISOString();
}

interface ContentType {
  type: string;
  params: Record<string, string>;
}

/** `type/subtype; a=b; c="d"`, with RFC 2231 `name*=charset''value` decoded. */
export function parseContentType(value: string | undefined, fallback = "text/plain"): ContentType {
  if (!value) return { type: fallback, params: {} };
  const [head, ...rest] = splitParams(stripComments(value));
  const params: Record<string, string> = {};
  for (const p of rest) {
    const i = p.indexOf("=");
    if (i <= 0) continue;
    let key = p.slice(0, i).trim().toLowerCase();
    let val = unquote(p.slice(i + 1));
    if (key.endsWith("*")) {
      key = key.slice(0, -1);
      const enc = /^([^']*)'[^']*'(.*)$/.exec(val);
      if (enc) {
        try {
          val = decodeURIComponent(enc[2]!);
        } catch {
          val = enc[2]!;
        }
      }
    }
    params[key] = decodeEncodedWords(val);
  }
  return { type: (head ?? "").trim().toLowerCase() || fallback, params };
}

function splitParams(s: string): string[] {
  const out: string[] = [];
  let cur = "";
  let quoted = false;
  for (const c of s) {
    if (c === '"') quoted = !quoted;
    if (c === ";" && !quoted) {
      out.push(cur);
      cur = "";
    } else cur += c;
  }
  out.push(cur);
  return out;
}

// ---- bodies --------------------------------------------------------------------

const ENTITIES: Record<string, string> = { nbsp: " ", amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", hellip: "...", mdash: "-", ndash: "-", rsquo: "'", lsquo: "'", rdquo: '"', ldquo: '"' };

function decodeHtmlEntities(s: string): string {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e: string) => {
    if (e[0] === "#") {
      const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
      return Number.isFinite(code) ? String.fromCodePoint(code) : m;
    }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}

/**
 * HTML to plain text. Block elements become line breaks and `<blockquote>`
 * content is prefixed with `>` so quote stripping treats it like a plain-text reply.
 */
export function htmlToText(html: string): string {
  const OPEN = "\u0001";
  const CLOSE = "\u0002";
  const text = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(head|style|script|title)\b[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<blockquote\b[^>]*>/gi, `\n${OPEN}\n`)
    .replace(/<\/blockquote\s*>/gi, `\n${CLOSE}\n`)
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/(p|div|tr|h[1-6]|table|ul|ol)\s*>/gi, "\n")
    .replace(/<(p|div|tr|h[1-6]|table|ul|ol)\b[^>]*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<hr\b[^>]*>/gi, "\n___\n")
    .replace(/<[^>]+>/g, "");
  const lines: string[] = [];
  let depth = 0;
  for (const rawLine of decodeHtmlEntities(text).split("\n")) {
    if (rawLine.trim() === OPEN) {
      depth++;
      continue;
    }
    if (rawLine.trim() === CLOSE) {
      depth = Math.max(0, depth - 1);
      continue;
    }
    const line = rawLine.replace(/[ \t ]+/g, " ").trim();
    lines.push(depth > 0 && line !== "" ? `${">".repeat(depth)} ${line}` : line);
  }
  return lines.join("\n").replace(/\n{3,}/g, "\n\n").trim();
}

function decodeTransfer(body: string, encoding: string | undefined, charset: string | undefined): string {
  switch ((encoding ?? "").trim().toLowerCase()) {
    case "base64":
      return decodeBase64(body, charset);
    case "quoted-printable":
      return decodeQuotedPrintable(body, charset);
    default:
      return body;
  }
}

interface Bodies {
  text: string[];
  html: string[];
  attachments: Attachment[];
}

function splitMultipart(body: string, boundary: string): string[] {
  const parts: string[] = [];
  const delimiter = `--${boundary}`;
  let cur: string[] | null = null;
  for (const line of body.split("\n")) {
    const trimmed = line.trimEnd();
    if (trimmed === `${delimiter}--`) {
      if (cur) parts.push(cur.join("\n"));
      cur = null;
      break;
    }
    if (trimmed === delimiter) {
      if (cur) parts.push(cur.join("\n"));
      cur = [];
      continue;
    }
    cur?.push(line);
  }
  // Truncated message without a closing delimiter: keep what we have.
  if (cur) parts.push(cur.join("\n"));
  return parts;
}

function collect(entity: Entity, out: Bodies, depth = 0): void {
  const ct = parseContentType(first(entity.headers, "content-type"));
  const disposition = parseContentType(first(entity.headers, "content-disposition"), "inline");
  const filename = disposition.params["filename"] ?? ct.params["name"];
  const isAttachment = disposition.type === "attachment" || filename !== undefined;

  if (ct.type.startsWith("multipart/") && ct.params["boundary"] && depth < 20) {
    const children = splitMultipart(entity.body, ct.params["boundary"]).map(splitEntity);
    if (ct.type === "multipart/alternative") {
      // Alternatives describe the same content: take the first plain and the last (richest) html.
      const alt: Bodies = { text: [], html: [], attachments: [] };
      for (const child of children) collect(child, alt, depth + 1);
      if (alt.text[0] !== undefined) out.text.push(alt.text[0]);
      if (alt.html.length > 0) out.html.push(alt.html[alt.html.length - 1]!);
      out.attachments.push(...alt.attachments);
      return;
    }
    for (const child of children) collect(child, out, depth + 1);
    return;
  }

  if (!isAttachment && (ct.type === "text/plain" || ct.type === "text/html")) {
    const decoded = decodeTransfer(entity.body, first(entity.headers, "content-transfer-encoding"), ct.params["charset"]);
    (ct.type === "text/plain" ? out.text : out.html).push(decoded);
    return;
  }

  const attachment: Attachment = { contentType: ct.type, size: entity.body.length };
  if (filename !== undefined) attachment.filename = filename;
  out.attachments.push(attachment);
}

// ---- public entry points ----------------------------------------------------------

/** Parse one RFC 5322 message. Never throws on malformed input; missing fields are left undefined. */
export function parseEml(raw: string): ParsedMessage {
  const entity = splitEntity(raw);
  const h = entity.headers;
  const bodies: Bodies = { text: [], html: [], attachments: [] };
  collect(entity, bodies);

  let text = "";
  let bodyType: ParsedMessage["bodyType"] = "none";
  const plain = bodies.text.filter((t) => t.trim().length > 0);
  const html = bodies.html.filter((t) => t.trim().length > 0);
  if (plain.length > 0) {
    text = plain.join("\n\n");
    bodyType = "text/plain";
  } else if (html.length > 0) {
    text = html.map(htmlToText).join("\n\n");
    bodyType = "text/html";
  }

  const received = (h["received"] ?? [])
    .map((r) => parseRfc2822Date(r.slice(r.lastIndexOf(";") + 1)))
    .filter((d): d is string => d !== undefined)
    .sort();

  const msg: ParsedMessage = {
    headers: h,
    references: parseMessageIds(first(h, "references")),
    from: parseAddressList(first(h, "from")),
    to: (h["to"] ?? []).flatMap((v) => parseAddressList(v)),
    cc: (h["cc"] ?? []).flatMap((v) => parseAddressList(v)),
    bcc: (h["bcc"] ?? []).flatMap((v) => parseAddressList(v)),
    replyTo: parseAddressList(first(h, "reply-to")),
    text: text.replace(/\r\n?/g, "\n"),
    bodyType,
    attachments: bodies.attachments,
    rawHeaders: entity.rawHeaders,
    rawBody: entity.body,
  };
  const set = <K extends keyof ParsedMessage>(key: K, value: ParsedMessage[K] | undefined): void => {
    if (value !== undefined && value !== "") msg[key] = value;
  };
  set("messageId", parseMessageIds(first(h, "message-id"))[0]);
  set("inReplyTo", parseMessageIds(first(h, "in-reply-to"))[0]);
  set("date", parseRfc2822Date(first(h, "date")));
  set("receivedAt", received[received.length - 1]);
  const subject = first(h, "subject");
  set("subject", subject === undefined ? undefined : decodeEncodedWords(subject).trim());
  set("listId", first(h, "list-id"));
  set("listUnsubscribe", first(h, "list-unsubscribe"));
  set("precedence", first(h, "precedence")?.toLowerCase());
  set("autoSubmitted", first(h, "auto-submitted")?.toLowerCase());
  set("autoResponseSuppress", first(h, "x-auto-response-suppress"));
  return msg;
}

/**
 * Split an mbox file into raw messages. A message starts at a `From ` line at
 * the top of the file or after a blank line; mboxrd `>From ` escapes are undone.
 */
export function splitMbox(raw: string): string[] {
  const lines = raw.replace(/\r\n?/g, "\n").split("\n");
  const messages: string[] = [];
  let cur: string[] | null = null;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    if (line.startsWith("From ") && (i === 0 || lines[i - 1] === "")) {
      if (cur) messages.push(cur.join("\n"));
      cur = [];
      continue;
    }
    if (cur === null) {
      // Content before the first From_ line: tolerate a file that is a single bare message.
      if (line.trim() === "") continue;
      cur = [];
    }
    cur.push(/^>+From /.test(line) ? line.slice(1) : line);
  }
  if (cur) messages.push(cur.join("\n"));
  return messages.map((m) => m.replace(/\n+$/, "\n")).filter((m) => m.trim().length > 0);
}

export function parseMbox(raw: string): ParsedMessage[] {
  return splitMbox(raw).map(parseEml);
}
