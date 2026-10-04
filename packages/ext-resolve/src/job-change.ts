import type { Entity, Extractor, Fact, NewFact, SourceEvent } from "@yrm/core";

/** Cheap gate: phrases people use when they announce a move. */
export const JOB_CHANGE_TRIGGER =
  /\b(my last day|i('|’| a)m leaving|moving on from|joining|starting at|new role at|no longer (at|with))\b/i;

/** Phrases that announce a move on their own. "joining" alone ("joining the call") does not. */
const STRONG = /\b(my last day|i('|’| a)m leaving|moving on from|no longer (at|with))\b/i;
const FIRST_PERSON = /\b(i|i'm|i’m|i've|i’ve|i'll|i’ll|i am|i will)\b/i;

// A run of capitalized words: "Northwind Automation", "Acme", "Smith & Co".
const COMPANY = String.raw`([A-Z][\w&'’-]*(?:\s+(?:&\s+)?[A-Z][\w&'’-]*)*)`;
const LEAVING = new RegExp(String.raw`\b(?:my last day (?:at|with)|leaving|moving on from|no longer (?:at|with))\s+${COMPANY}`);
const JOINING = new RegExp(
  String.raw`\b(?:joining|starting at|start(?:ing)? (?:at|with)|new role (?:at|with)|leaving for|moving to|(?:accepted|taken|took|taking) (?:a|an|the) (?:new )?(?:role|job|position|offer) (?:at|with|from))\s+${COMPANY}`,
);

export interface JobChangeValue {
  leaving?: string;
  joining?: string;
}

interface Sentence {
  text: string;
  start: number;
  end: number;
}

function sentences(text: string): Sentence[] {
  const out: Sentence[] = [];
  for (const m of text.matchAll(/[^.!?\n]+[.!?]*/g)) {
    const raw = m[0];
    const lead = raw.length - raw.trimStart().length;
    const trimmed = raw.trim();
    if (!trimmed) continue;
    const start = (m.index ?? 0) + lead;
    out.push({ text: trimmed, start, end: start + trimmed.length });
  }
  return out;
}

function company(re: RegExp, s: string): string | undefined {
  const m = re.exec(s);
  // Drop a trailing pronoun-ish capital that starts the next clause ("Acme I") and stray punctuation.
  return m?.[1]?.replace(/[.'’-]+$/, "").replace(/\s+I$/, "").trim() || undefined;
}

/** What the text says about leaving and joining, from the trigger sentence and the two after it. */
export function parseJobChange(text: string): { value: JobChangeValue; quote: Sentence } | null {
  const all = sentences(text);
  const at = all.findIndex((s) => JOB_CHANGE_TRIGGER.test(s.text));
  if (at < 0) return null;
  const trigger = all[at]!;
  const window = all.slice(at, at + 3);
  const value: JobChangeValue = {};
  let last = trigger;
  for (const s of window) {
    const leaving = value.leaving ?? company(LEAVING, s.text);
    const joining = value.joining ?? company(JOINING, s.text);
    if (leaving !== value.leaving || joining !== value.joining) last = s;
    if (leaving) value.leaving = leaving;
    if (joining) value.joining = joining;
  }
  const strong = STRONG.test(trigger.text);
  // Weak phrasing counts only when the writer talks about themselves and names a destination.
  if (!strong && !(value.joining && FIRST_PERSON.test(trigger.text))) return null;
  return {
    value,
    quote: { text: text.slice(trigger.start, last.end), start: trigger.start, end: last.end },
  };
}

function currentEmployer(facts: Fact[], personId: string): string | undefined {
  return facts
    .filter((f) => f.predicate === "works_at" && f.subject.entityId === personId && f.object?.name)
    .sort((a, b) => (a.validFrom < b.validFrom ? 1 : -1))[0]?.object?.name;
}

/**
 * `resolve:job-change`: a rule that records a `job_change` signal for the
 * sender. `validFrom` is the message date, not the import time, so a message
 * delivered late still says when the change happened.
 *
 * It deliberately does not end the old `works_at`: the signal is evidence, and
 * closing valid time is for the attention and extract layers (or a human) to
 * decide once they have weighed it.
 */
export function jobChangeExtractor(): Extractor {
  return {
    name: "resolve:job-change",
    version: "1",
    applies: (event: SourceEvent) => JOB_CHANGE_TRIGGER.test(event.content.text),
    async extract(event, ctx): Promise<NewFact[]> {
      const parsed = parseJobChange(event.content.text);
      if (!parsed) return [];
      const fromId = event.participants.find((p) => p.role === "from")?.entityId;
      if (!fromId) return [];
      const sender: Entity | undefined = ctx.participants.find((e) => e.id === fromId);
      if (!sender) return [];
      const value: JobChangeValue = { ...parsed.value };
      if (!value.leaving) {
        const employer = currentEmployer(ctx.knownFacts, sender.id);
        if (employer) value.leaving = employer;
      }
      const parts = [value.leaving && `leaving ${value.leaving}`, value.joining && `joining ${value.joining}`].filter(Boolean);
      const fact: NewFact<JobChangeValue> = {
        type: "signal",
        subject: { entityId: sender.id, name: sender.name },
        predicate: "job_change",
        value,
        statement: `${sender.name} is changing jobs${parts.length ? `: ${parts.join(", ")}` : ""}.`,
        validFrom: event.occurredAt,
        provenance: [
          {
            eventId: event.id,
            speaker: { entityId: sender.id, name: sender.name },
            quote: parsed.quote.text,
            span: { start: parsed.quote.start, end: parsed.quote.end },
          },
        ],
        confidence: 0.7,
        origin: { kind: "rule", by: "resolve", version: "1" },
      };
      return [fact];
    },
  };
}
