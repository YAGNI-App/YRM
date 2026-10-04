import type { NewSourceEvent } from "@yrm/core";
import { type NoiseOptions, type NoiseVerdict, type ParsedMessage, toEvent } from "@yrm/ext-mail";
import { SOURCE_NAME } from "./settings.ts";

/** Gmail's `raw` field (base64url, padding optional) to the RFC 822 text, read as UTF-8. */
export function decodeBase64Url(raw: string): string {
  const clean = raw.replace(/\s+/g, "").replace(/=+$/, "");
  return Buffer.from(clean, "base64url").toString("utf-8");
}

export interface GmailEventOptions {
  gmailId?: string;
  /** Gmail's hex thread id. */
  threadId?: string;
  labels?: string[];
  rawRef?: string;
  fallbackDate?: string;
  noise: NoiseOptions;
  keepNoise: boolean;
  verdict?: NoiseVerdict;
}

/** Gmail threads are a stronger signal than References chains, which clients often break. */
export const gmailThreadKey = (threadId: string): string => `gmail:${threadId}`;

/**
 * ext-mail's `toEvent`, re-labelled as a `gmail` event with Gmail's ids and
 * labels in `meta`. The external id stays the Message-ID, so the same message
 * seen under two labels (or twice) is one event.
 */
export function toGmailEvent(msg: ParsedMessage, opts: GmailEventOptions): NewSourceEvent | null {
  const mailOpts: Parameters<typeof toEvent>[1] = { noise: opts.noise, keepNoise: opts.keepNoise };
  if (opts.verdict !== undefined) mailOpts.verdict = opts.verdict;
  if (opts.rawRef !== undefined) mailOpts.rawRef = opts.rawRef;
  if (opts.fallbackDate !== undefined) mailOpts.fallbackDate = opts.fallbackDate;
  const event = toEvent(msg, mailOpts);
  if (!event) return null;
  const meta: Record<string, unknown> = { ...event.meta, labels: opts.labels ?? [] };
  if (opts.gmailId !== undefined) meta["gmailId"] = opts.gmailId;
  if (opts.threadId !== undefined) meta["threadId"] = opts.threadId;
  const out: NewSourceEvent = { ...event, source: SOURCE_NAME, meta };
  if (opts.threadId) out.threadKey = gmailThreadKey(opts.threadId);
  return out;
}

const TAKEOUT_LABELS: Record<string, string> = {
  inbox: "INBOX",
  sent: "SENT",
  important: "IMPORTANT",
  starred: "STARRED",
  unread: "UNREAD",
  spam: "SPAM",
  trash: "TRASH",
  drafts: "DRAFT",
  draft: "DRAFT",
  chat: "CHAT",
};

/**
 * Takeout writes `X-Gmail-Labels: Inbox,Sent,Opened,Custom` and the thread id
 * in decimal as `X-GM-THRID`. Map both to what the API reports so a Takeout
 * import and a later live sync agree on labels and thread keys.
 */
export function takeoutMeta(msg: ParsedMessage): { labels: string[]; threadId?: string } {
  const labelHeader = msg.headers["x-gmail-labels"]?.[0] ?? "";
  const labels = labelHeader
    .split(",")
    .map((l) => l.trim())
    .filter((l) => l.length > 0)
    .map((l) => TAKEOUT_LABELS[l.toLowerCase()] ?? l);
  const thrid = msg.headers["x-gm-thrid"]?.[0]?.trim();
  if (thrid && /^\d+$/.test(thrid)) return { labels, threadId: BigInt(thrid).toString(16) };
  return { labels };
}
