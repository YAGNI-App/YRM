import { createHash } from "node:crypto";
import type { NewSourceEvent, Participant } from "@yrm/core";
import { classifyNoise, type NoiseOptions, type NoiseVerdict } from "./noise.ts";
import type { Address, ParsedMessage } from "./parse.ts";
import { stripQuotes } from "./strip.ts";

export const SOURCE_NAME = "mail";

export interface ToEventOptions {
  /** Emit noise anyway, with `meta.noise` set to the reason. Default false. */
  keepNoise?: boolean;
  noise?: NoiseOptions;
  /** Pointer to the raw payload, e.g. the file path. */
  rawRef?: string;
  /** Used for `occurredAt` when the message has neither `Date` nor `Received`. */
  fallbackDate?: string;
  /** Precomputed verdict, so callers that already classified do not pay twice. */
  verdict?: NoiseVerdict;
}

/** `<abc@host>` to `abc@host`, the form used for `threadKey`. */
export function normalizeMessageId(id: string): string {
  return id.trim().replace(/^<|>$/g, "");
}

/** Content hash used as the external id when a message has no Message-ID. */
export function contentId(msg: ParsedMessage): string {
  return `sha256:${createHash("sha256").update(msg.rawHeaders).update("\n\n").update(msg.rawBody).digest("hex")}`;
}

function participants(msg: ParsedMessage): Participant[] {
  const out: Participant[] = [];
  const seen = new Set<string>();
  const add = (role: Participant["role"], list: Address[]): void => {
    for (const a of list) {
      const key = `${role}\u0000${a.address}`;
      if (seen.has(key)) continue;
      seen.add(key);
      const p: Participant = { role, address: a.address.toLowerCase() };
      if (a.name !== undefined) p.name = a.name;
      out.push(p);
    }
  };
  add("from", msg.from);
  add("to", msg.to);
  add("cc", msg.cc);
  add("bcc", msg.bcc);
  return out;
}

/**
 * Map a parsed message to a source event, or null when it is noise (unless
 * `keepNoise`). Deterministic: the same message always yields the same event.
 */
export function toEvent(msg: ParsedMessage, opts: ToEventOptions = {}): NewSourceEvent | null {
  const verdict = opts.verdict ?? classifyNoise(msg, opts.noise);
  if (verdict.noise && !opts.keepNoise) return null;

  const externalId = msg.messageId ?? contentId(msg);
  const root = msg.references[0] ?? msg.inReplyTo ?? externalId;
  const { text, stripped } = stripQuotes(msg.text);

  const meta: Record<string, unknown> = {
    subject: msg.subject ?? "",
    messageId: msg.messageId ?? null,
    references: msg.references,
    hasAttachments: msg.attachments.length > 0,
    originalLength: msg.text.length,
  };
  if (msg.listId !== undefined) meta["listId"] = msg.listId;
  // When delivery lagged the Date header (quarantine, retries), extractors may care which one we knew.
  if (msg.receivedAt !== undefined) meta["receivedAt"] = msg.receivedAt;
  if (msg.date === undefined) meta["dateMissing"] = true;
  if (verdict.noise) meta["noise"] = verdict.reason ?? "noise";

  const event: NewSourceEvent = {
    source: SOURCE_NAME,
    kind: "message",
    externalId,
    occurredAt: msg.date ?? msg.receivedAt ?? opts.fallbackDate ?? new Date().toISOString(),
    participants: participants(msg),
    content: { text, tokens: Math.ceil(text.length / 4), mime: "text/plain" },
    threadKey: root.startsWith("sha256:") ? root : normalizeMessageId(root),
    meta,
  };
  if (msg.subject !== undefined) event.content.title = msg.subject;
  if (stripped !== "") event.content.stripped = stripped;
  if (msg.inReplyTo !== undefined) event.inReplyTo = [msg.inReplyTo];
  if (opts.rawRef !== undefined) event.rawRef = opts.rawRef;
  return event;
}
