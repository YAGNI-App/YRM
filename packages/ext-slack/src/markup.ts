/**
 * Slack's message markup ("mrkdwn" references) to plain text. Slack escapes
 * only `&`, `<` and `>` in text and wraps every reference in `<...>`, so
 * references are rewritten first and entities unescaped last; an escaped
 * `&lt;@U1&gt;` typed by a person therefore stays literal text.
 */

export interface MarkupLookup {
  /** Display name for a user id, if known. */
  user(id: string): string | undefined;
  /** Name for a channel id, if known. */
  channel(id: string): string | undefined;
}

export interface Normalized {
  text: string;
  /** User ids referenced with `<@U...>`, in order, without duplicates. */
  mentions: string[];
}

const BROADCASTS = new Set(["here", "channel", "everyone"]);

export function unescapeEntities(s: string): string {
  return s.replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&");
}

function split(inner: string): [string, string | undefined] {
  const bar = inner.indexOf("|");
  return bar < 0 ? [inner, undefined] : [inner.slice(0, bar), inner.slice(bar + 1)];
}

function link(target: string, label: string | undefined): string {
  if (target.startsWith("mailto:")) {
    const address = target.slice("mailto:".length);
    return label === undefined || label === address ? address : `${label} (${address})`;
  }
  return label === undefined || label === "" || label === target ? target : `${label} (${target})`;
}

function special(body: string, label: string | undefined): string {
  if (BROADCASTS.has(body)) return `@${body}`;
  // <!subteam^S123|@sales-team>, <!date^1392734382^{date}|Feb 18>: the label is what Slack shows.
  if (label !== undefined && label !== "") return label;
  const caret = body.indexOf("^");
  return caret < 0 ? `@${body}` : `@${body.slice(caret + 1)}`;
}

export function normalizeMarkup(text: string, lookup: MarkupLookup): Normalized {
  const mentions: string[] = [];
  const out = text.replace(/<([^<>\n]+)>/g, (_whole, inner: string) => {
    const [target, label] = split(inner);
    if (target.startsWith("@")) {
      const id = target.slice(1);
      if (!mentions.includes(id)) mentions.push(id);
      const name = lookup.user(id) ?? label?.replace(/^@/, "") ?? id;
      return `@${name}`;
    }
    if (target.startsWith("#")) {
      const id = target.slice(1);
      return `#${label || lookup.channel(id) || id}`;
    }
    if (target.startsWith("!")) return special(target.slice(1), label);
    return link(target, label);
  });
  return { text: unescapeEntities(out), mentions };
}
