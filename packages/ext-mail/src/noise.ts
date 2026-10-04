import type { ParsedMessage } from "./parse.ts";

/**
 * Bulk and automated mail is dropped at ingest so it never reaches the
 * extractors. Every rule is a header or address check; no model is involved.
 */

export const DEFAULT_NOISE_LOCAL_PARTS: readonly string[] = [
  "noreply",
  "no-reply",
  "donotreply",
  "notifications",
  "notification",
  "mailer-daemon",
  "postmaster",
  "bounce",
  "alerts",
  "newsletter",
  "news",
  "marketing",
  "digest",
];

export interface NoiseOptions {
  /** Sender local parts that mark mail as noise. Replaces the defaults when given. */
  localParts?: readonly string[];
  /** Sender domains whose mail is always noise. A domain also matches its subdomains. */
  domains?: readonly string[];
}

export interface NoiseVerdict {
  noise: boolean;
  /** Which rule fired, e.g. `list-unsubscribe`, `precedence:bulk`, `sender:noreply`. */
  reason?: string;
}

const BULK_PRECEDENCE = new Set(["bulk", "list", "junk"]);

/**
 * First matching rule wins, in order: `List-Unsubscribe`, `Precedence`,
 * `Auto-Submitted`, sender local part, sender domain. A display name such as
 * "Jane via Docs" is deliberately not a signal: SaaS tools send real person-to-person
 * mail that way, and those messages carry the headers above when they are bulk.
 */
export function classifyNoise(msg: ParsedMessage, opts: NoiseOptions = {}): NoiseVerdict {
  if (msg.listUnsubscribe !== undefined) return { noise: true, reason: "list-unsubscribe" };

  const precedence = msg.precedence?.trim().toLowerCase();
  if (precedence !== undefined && BULK_PRECEDENCE.has(precedence)) return { noise: true, reason: `precedence:${precedence}` };

  // RFC 3834: any value other than "no" means the message was generated automatically.
  const auto = msg.autoSubmitted?.split(";")[0]?.trim().toLowerCase();
  if (auto !== undefined && auto !== "" && auto !== "no") return { noise: true, reason: `auto-submitted:${auto}` };

  const sender = msg.from[0]?.address;
  if (sender !== undefined) {
    const at = sender.lastIndexOf("@");
    // Sub-addressing (`alerts+billing@`) still names the same mailbox.
    const local = (at >= 0 ? sender.slice(0, at) : sender).split("+")[0]!;
    const domain = at >= 0 ? sender.slice(at + 1) : "";
    const localParts = new Set((opts.localParts ?? DEFAULT_NOISE_LOCAL_PARTS).map((l) => l.toLowerCase()));
    if (localParts.has(local)) return { noise: true, reason: `sender:${local}` };
    for (const d of opts.domains ?? []) {
      const nd = d.toLowerCase().replace(/^@/, "");
      if (domain === nd || domain.endsWith(`.${nd}`)) return { noise: true, reason: `domain:${nd}` };
    }
  }

  return { noise: false };
}
