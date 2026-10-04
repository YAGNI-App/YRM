/**
 * Pure helpers for turning header values into identifiers and display names.
 * No store access here, so every rule is unit-testable on its own.
 */

/** Consumer mail providers. A domain here says nothing about who someone works for. */
export const DEFAULT_FREEMAIL_DOMAINS: readonly string[] = [
  "gmail.com",
  "googlemail.com",
  "outlook.com",
  "hotmail.com",
  "live.com",
  "yahoo.com",
  "icloud.com",
  "me.com",
  "proton.me",
  "protonmail.com",
  "aol.com",
  "gmx.com",
  "fastmail.com",
  "hey.com",
];

/**
 * Leftmost labels that name a mail host rather than a part of the company.
 * Deliberately short: `eu.acme.com` or `labs.acme.com` may be real divisions.
 */
const MAIL_SUBDOMAINS = new Set(["mail", "email", "mx", "smtp", "mailer", "mg", "mta", "bounce", "bounces", "em"]);

/** Second-level labels under country TLDs that are not the company name (`acme.co.uk`). */
const GENERIC_SLDS = new Set(["co", "com", "org", "net", "ac", "gov", "edu", "ltd", "plc"]);

/** Local parts that belong to systems, not people. Never used for same-name suggestions. */
const AUTOMATED_LOCAL = /^(no-?reply|do-?not-?reply|newsletter|notifications?|notify|mailer-daemon|bounces?|postmaster)$/;

/** Lowercase, trim, drop `mailto:` and angle brackets. */
export function normalizeAddress(raw: string): string {
  let s = raw.trim();
  if (s.startsWith("<") && s.endsWith(">")) s = s.slice(1, -1).trim();
  s = s.replace(/^mailto:/i, "");
  const q = s.indexOf("?");
  if (q >= 0) s = s.slice(0, q);
  return s.trim().toLowerCase();
}

/** `a+tag@x` → `a@x`. Plus-addressing reaches the same mailbox, so it is the same person. */
export function baseAddress(address: string): string {
  const at = address.lastIndexOf("@");
  if (at <= 0) return address;
  const local = address.slice(0, at);
  const plus = local.indexOf("+");
  return plus > 0 ? `${local.slice(0, plus)}${address.slice(at)}` : address;
}

export function localPartOf(address: string): string {
  const at = address.lastIndexOf("@");
  return at >= 0 ? address.slice(0, at) : address;
}

/**
 * The organization domain for an address: the part after `@`, with one
 * leading mail-host label (`mail.acme.example`) removed. Accepts a bare domain too.
 */
export function domainOf(addressOrDomain: string): string | undefined {
  const s = normalizeAddress(addressOrDomain);
  const at = s.lastIndexOf("@");
  let domain = (at >= 0 ? s.slice(at + 1) : s).replace(/\.+$/, "");
  if (!domain || !domain.includes(".")) return undefined;
  const labels = domain.split(".");
  if (labels.length > 2 && MAIL_SUBDOMAINS.has(labels[0]!)) domain = labels.slice(1).join(".");
  return domain;
}

/** True for a freemail domain or any subdomain of one (`calendar.mailhub.example`). */
export function isFreemail(domain: string, extra: readonly string[] = []): boolean {
  const d = domain.toLowerCase();
  for (const f of [...DEFAULT_FREEMAIL_DOMAINS, ...extra]) {
    const fd = f.toLowerCase();
    if (d === fd || d.endsWith(`.${fd}`)) return true;
  }
  return false;
}

function titleWord(word: string): string {
  // Capitalize after word starts, hyphens and apostrophes: o'brien → O'Brien, jean-luc → Jean-Luc.
  return word.toLowerCase().replace(/(^|[-'’])(\p{L})/gu, (_m, sep: string, c: string) => sep + c.toUpperCase());
}

function titleCase(s: string): string {
  return s
    .split(/\s+/)
    .filter(Boolean)
    .map(titleWord)
    .join(" ");
}

/** `acme-robotics.example` → "Acme Robotics"; `acme.co.uk` → "Acme". */
export function orgNameFromDomain(domain: string): string {
  const labels = domain.toLowerCase().split(".").filter(Boolean);
  if (labels.length > 1) labels.pop();
  if (labels.length > 1 && GENERIC_SLDS.has(labels[labels.length - 1]!)) labels.pop();
  const label = labels[labels.length - 1] ?? domain;
  return titleCase(label.replace(/[-_]+/g, " "));
}

/** A readable name from a mailbox: `priya.raman` → "Priya Raman", `tfischer` → "Tfischer". */
export function nameFromLocalPart(address: string): string {
  const words = localPartOf(baseAddress(address))
    .split(/[._\-\s]+/)
    .filter((w) => w.length > 0 && !/^\d+$/.test(w));
  return words.length > 0 ? titleCase(words.join(" ")) : address;
}

/**
 * Best display name from a header: strips quotes and trailing comments, turns
 * "Last, First" into "First Last", title-cases ALL CAPS, and falls back to the
 * local part when the header has no usable name.
 */
export function displayNameFromHeader(name: string | undefined, address?: string): string {
  let s = (name ?? "").replace(/\\"/g, '"').replace(/\s+/g, " ").trim();
  // Quotes can be nested by sloppy clients: "'Priya Raman'".
  for (let prev = ""; prev !== s; ) {
    prev = s;
    s = s.replace(/^["'`‘’“”]+|["'`‘’“”]+$/g, "").trim();
  }
  s = s.replace(/\s*\([^)]*\)$/, "").trim();
  if (s.length === 0 || s.includes("@") || !/\p{L}/u.test(s)) {
    return address ? nameFromLocalPart(normalizeAddress(address)) : "Unknown";
  }
  const parts = s.split(",");
  if (parts.length === 2 && parts[0]!.trim() && parts[1]!.trim()) {
    s = `${parts[1]!.trim()} ${parts[0]!.trim()}`;
  }
  if (s === s.toUpperCase() && s !== s.toLowerCase()) s = titleCase(s);
  return s;
}

/** Case-, diacritic- and punctuation-insensitive form for comparing names. */
export function normalizeName(name: string): string {
  return name
    .normalize("NFKD")
    .replace(/\p{M}+/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/** A name worth matching on: at least a first and a last token. */
export function isFullName(normalized: string): boolean {
  return normalized.split(" ").filter((t) => t.length > 0).length >= 2;
}

export function isAutomatedAddress(address: string): boolean {
  return AUTOMATED_LOCAL.test(localPartOf(baseAddress(address)));
}
