import type {
  AskValue,
  CommitmentValue,
  DecisionValue,
  EntityRef,
  Extractor,
  ExtractContext,
  Fact,
  NewFact,
  ObjectionValue,
  Participant,
  Provenance,
  SourceEvent,
  Store,
} from "@yrm/core";
import { findDue } from "./dates.ts";
import { distinctByEntity, nameOf, refOf, senderOf, threadTag } from "./participants.ts";
import { splitSentences, type Sentence } from "./sentences.ts";

/**
 * The rule extractor: regex and heuristics, zero cost, always on. It is what
 * makes YRM useful with no API keys (ARCHITECTURE.md, Degradation), so it
 * aims for recall on the facts the attention queue lives on (asks and dated
 * commitments) and records everything at modest confidence with origin "rule".
 */

export const RULE_EXTRACTOR = "rule-extractor";
export const RULE_VERSION = "1";

export type RuleKind = "ask" | "commitment" | "decision" | "objection" | "role";

const ASK_START =
  /^(?:(?:also|and|so|but|then|first|second|finally|one more thing),?\s+)?(?:(?:can|could|would|will) you\b|are you able\b|let me know\b|do you\b)/i;
const ENDS_WITH_QUESTION = /\?["'”’)\]]*$/;
/** Questions that do not expect an answer. */
const RHETORICAL = /^(?:remember|guess what|who knew|how about that)\b/i;

const COMMITMENT_PHRASE =
  /\b(?:i will|i'll|we will|we'll|i can|i'm going to|i am going to|will send|will get you|will have|will share|will deliver|will follow up)\b/i;
/** "I'll need", "I'll wait": future tense that promises nothing. */
const NOT_A_PROMISE = /\b(?:i|we|she|he|they)(?:'ll| will) (?:need|want|wait|watch)\b/i;
/** Scheduling logistics are not tracked commitments (fixtures/README.md: "I'll send an invite"). */
const LOGISTICS = /\b(?:send (?:you )?(?:an?|the) (?:calendar )?invite|calendar invite)\b/i;
/** "Dana will send", "She'll have": a third party's promise, reported by the sender. */
const THIRD_PERSON = /^(?!(?:it|that|this|there|which|what)\b)\S+(?: \S+)?(?:'ll| will)\b/i;

const DECISION =
  /\b(?:we(?:'ve| have) decided|we(?:'re| are) going (?:to|with)|(?:the )?decision is|approved|signed off|green light|let's go with|is on hold|put\b.{0,60}\bon hold)\b/i;

const OBJECTION =
  /\b(?:concerns?|blockers?|can(?:'t|not) (?:proceed|move forward)|not comfortable|on hold|pause|need to see\b.{0,80}\bbefore|risks?)\b/i;
const HIGH_SEVERITY = /\b(?:blockers?|on hold|pause)\b/i;

const FULFILLED = /\b(?:attached|here is|here's|here you go|sent|done|completed|as promised|shared)\b/i;
const BROKEN =
  /\b(?:delayed|slipped|slips|pushed|won't make|will not make|need more time|did not get|didn't get|missed|not going to make)\b/i;

const ROLE_TITLE =
  /\b((?:senior |chief |deputy )?(?:CFO|CTO|CEO|COO|CIO|CISO|VP|Vice President|Head|Director|Manager|Lead|Engineer)(?: of [A-Z][\w&-]*(?: [A-Z][\w&-]*)*)?)\b/;
const ROLE_DUTY = /\b(owns the budget|controls the budget|approves|owns|runs)\b/i;
const INTRO_CUE = /\b(?:cc'?ing|copying|looping in|loop in|introduc(?:e|ing)|adding)\b/i;

/** Straight apostrophes so patterns need one spelling. */
function plain(s: string): string {
  return s.replace(/[’‘]/g, "'");
}

export function isAsk(sentence: string): boolean {
  const s = plain(sentence.trim());
  if (RHETORICAL.test(s)) return false;
  return ENDS_WITH_QUESTION.test(s) || ASK_START.test(s);
}

/** Pure classification of one sentence. Commitments need a resolvable due date. */
export function classifySentence(sentence: string, occurredAt: string): Set<RuleKind> {
  const s = plain(sentence);
  const kinds = new Set<RuleKind>();
  const ask = isAsk(s);
  if (ask) kinds.add("ask");
  const promise = (COMMITMENT_PHRASE.test(s) || THIRD_PERSON.test(s)) && !NOT_A_PROMISE.test(s) && !LOGISTICS.test(s);
  if (!ask && promise && findDue(s, occurredAt)) {
    kinds.add("commitment");
  }
  if (DECISION.test(s)) kinds.add("decision");
  if (OBJECTION.test(s)) kinds.add("objection");
  if ((INTRO_CUE.test(s) || /\b(?:is|as) our\b|, (?:who|our)\b/i.test(s)) && (ROLE_TITLE.test(s) || ROLE_DUTY.test(s))) {
    kinds.add("role");
  }
  return kinds;
}

/** True when the rule extractor would find at least one candidate. Cheap enough for `applies`. */
export function hasRuleCandidates(event: SourceEvent): boolean {
  return splitSentences(event.content.text).some((s) => classifySentence(s.text, event.occurredAt).size > 0);
}

function firstName(p: Participant, ctx: ExtractContext): string | undefined {
  const n = nameOf(p, ctx.participants);
  if (n.includes("@")) return undefined;
  return n.split(/\s+/)[0];
}

function escapeRe(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** "Dana will send..." in Jack's mail is Dana's commitment, not Jack's. */
function namedOwner(sentence: string, sender: Participant, event: SourceEvent, ctx: ExtractContext): Participant | undefined {
  const s = plain(sentence);
  for (const p of distinctByEntity(event.participants)) {
    if (p.entityId === sender.entityId) continue;
    const first = firstName(p, ctx);
    if (!first) continue;
    if (new RegExp(`^${escapeRe(first)}(?: \\w+)?(?:'ll| will)\\b`, "i").test(s)) return p;
  }
  return undefined;
}

/** The participant a role sentence is about, if they are on the message. */
function rolePerson(sentence: string, sender: Participant, event: SourceEvent, ctx: ExtractContext): Participant | undefined {
  const s = plain(sentence);
  for (const p of distinctByEntity(event.participants)) {
    if (p.entityId === sender.entityId || (p.role !== "to" && p.role !== "cc")) continue;
    const full = nameOf(p, ctx.participants);
    const first = firstName(p, ctx);
    if (!first) continue;
    const who = `(?:${escapeRe(full)}|${escapeRe(first)})`;
    const described = new RegExp(`\\b${who}(?:,\\s*(?:who|our)\\b|\\s+is\\s+(?:our|the)\\b|\\s+as\\s+our\\b)`, "i");
    const introduced = new RegExp(`${INTRO_CUE.source}\\s+(?:\\S+\\s+){0,3}?${who}\\b`, "i");
    if (described.test(s) || introduced.test(s)) return p;
  }
  return undefined;
}

function roleTitle(sentence: string): string | undefined {
  const t = ROLE_TITLE.exec(sentence);
  if (t) return t[1];
  const d = ROLE_DUTY.exec(sentence);
  if (!d) return undefined;
  return /budget/i.test(d[1]!) ? "budget owner" : d[1]!.toLowerCase();
}

function domainOf(p: Participant): string | undefined {
  const at = p.address?.lastIndexOf("@") ?? -1;
  return at >= 0 ? p.address!.slice(at + 1) : undefined;
}

interface Built {
  facts: NewFact[];
  skippedNoEntity: number;
}

function ruleOrigin() {
  return { kind: "rule" as const, by: "extract", version: RULE_VERSION };
}

/** New facts from the sentences of one event. Pure apart from reading ctx. */
export function sentenceFacts(event: SourceEvent, ctx: ExtractContext): Built {
  const out: Built = { facts: [], skippedNoEntity: 0 };
  const sender = senderOf(event);
  const text = event.content.text;
  if (!sender) return out;
  const senderRef = refOf(sender, ctx.participants);
  if (!senderRef) {
    out.skippedNoEntity = splitSentences(text).filter((s) => classifySentence(s.text, event.occurredAt).size > 0).length;
    return out;
  }
  const tag = threadTag(event);
  const tags = tag ? [tag] : undefined;
  const to = event.participants.filter((p) => p.role === "to");
  const firstSelfTo = to.find((p) => p.self);
  const askedOfP = firstSelfTo ?? to[0];
  const askedOf = askedOfP ? refOf(askedOfP, ctx.participants) : undefined;

  const base = (sentence: Sentence, confidence: number) => {
    const quote = text.slice(sentence.start, sentence.end);
    const provenance: Provenance[] = [
      { eventId: event.id, speaker: senderRef, quote, span: { start: sentence.start, end: sentence.end } },
    ];
    return {
      validFrom: event.occurredAt,
      provenance,
      confidence,
      origin: ruleOrigin(),
      ...(tags ? { tags } : {}),
    };
  };

  for (const sentence of splitSentences(text)) {
    const kinds = classifySentence(sentence.text, event.occurredAt);
    const what = sentence.text;

    if (kinds.has("ask")) {
      const value: AskValue = { what, askedBy: senderRef, answered: false };
      if (askedOf) value.askedOf = askedOf;
      out.facts.push({
        type: "ask",
        subject: senderRef,
        ...(askedOf ? { object: askedOf } : {}),
        predicate: "asked",
        value,
        statement: `${senderRef.name} asked ${askedOf?.name ?? "someone"}: ${what}`,
        ...base(sentence, ENDS_WITH_QUESTION.test(plain(what)) ? 0.6 : 0.55),
      });
    }

    if (kinds.has("commitment")) {
      const due = findDue(plain(what), event.occurredAt);
      const ownerP: Participant = namedOwner(what, sender, event, ctx) ?? sender;
      const owedBy = refOf(ownerP, ctx.participants);
      if (!owedBy) {
        out.skippedNoEntity++;
      } else {
        // Owed to: from self, the first other recipient; to self, the self side.
        // A promise the sender reports for someone on the other side is owed to the sender.
        let owedToP: Participant | undefined;
        if (ownerP !== sender && Boolean(ownerP.self) !== Boolean(sender.self)) {
          owedToP = sender;
        } else {
          const candidates = sender.self
            ? to.filter((p) => !p.self && p.entityId)
            : event.participants.filter((p) => p.self && p.entityId);
          owedToP = candidates.find((p) => p.entityId !== owedBy.entityId);
        }
        const owedTo = owedToP ? refOf(owedToP, ctx.participants) : undefined;
        const value: CommitmentValue = { what, owedBy, status: "open" };
        if (owedTo) value.owedTo = owedTo;
        if (due) value.dueAt = due.dueAt;
        out.facts.push({
          type: "commitment",
          subject: owedBy,
          ...(owedTo ? { object: owedTo } : {}),
          predicate: "committed_to",
          value,
          statement: `${owedBy.name} committed to ${owedTo?.name ?? "someone"}${due ? ` (due ${due.dueAt})` : ""}: ${what}`,
          ...base(sentence, due && /\d/.test(due.phrase) ? 0.65 : 0.6),
        });
      }
    }

    if (kinds.has("decision")) {
      const value: DecisionValue = { what, decidedBy: senderRef };
      out.facts.push({
        type: "decision",
        subject: senderRef,
        predicate: "decided",
        value,
        statement: `${senderRef.name} communicated a decision: ${what}`,
        ...base(sentence, 0.6),
      });
    }

    if (kinds.has("objection")) {
      const value: ObjectionValue = {
        what,
        raisedBy: senderRef,
        severity: HIGH_SEVERITY.test(what) ? "high" : "medium",
        resolved: false,
      };
      out.facts.push({
        type: "objection",
        subject: senderRef,
        ...(askedOf && askedOf.entityId !== senderRef.entityId ? { object: askedOf } : {}),
        predicate: "objected",
        value,
        statement: `${senderRef.name} raised a concern: ${what}`,
        ...base(sentence, 0.55),
      });
    }

    if (kinds.has("role")) {
      const person = rolePerson(what, sender, event, ctx);
      const role = roleTitle(what);
      const ref = person ? refOf(person, ctx.participants) : undefined;
      if (ref && role) {
        const scope = domainOf(person!);
        out.facts.push({
          type: "role",
          subject: ref,
          predicate: "holds_role",
          value: { role, ...(scope ? { scope } : {}) },
          statement: `${ref.name} holds the role ${role}${scope ? ` at ${scope}` : ""}.`,
          ...base(sentence, 0.5),
        });
      }
    }
  }
  return out;
}

function inThread(f: Fact, tag: string | undefined, threadIds: Set<string>): boolean {
  if (tag && f.tags?.includes(tag)) return true;
  return f.provenance.some((p) => threadIds.has(p.eventId));
}

function speakerProvenance(event: SourceEvent, speaker: EntityRef): Provenance {
  return { eventId: event.id, speaker };
}

/**
 * Close asks and commitments this event resolves. Candidates come from
 * `ctx.knownFacts` plus a direct store query, because knownFacts is capped
 * and a busy sender can push the thread's open items out of it.
 */
export async function closures(event: SourceEvent, ctx: ExtractContext, store: Store | undefined): Promise<NewFact[]> {
  const sender = senderOf(event);
  const senderRef = sender ? refOf(sender, ctx.participants) : undefined;
  const tag = threadTag(event);
  if (!sender || !senderRef || !tag) return [];
  const threadIds = new Set(ctx.thread.map((e) => e.id));
  const candidates = new Map<string, Fact>();
  for (const f of ctx.knownFacts) candidates.set(f.id, f);
  if (store) {
    const validAt = event.occurredAt;
    const q = { tenantId: ctx.tenantId, validAt, tags: [tag] };
    for (const f of await store.queryFacts({ ...q, type: "ask", objectId: senderRef.entityId })) candidates.set(f.id, f);
    for (const f of await store.queryFacts({ ...q, type: "commitment", subjectId: senderRef.entityId })) candidates.set(f.id, f);
  }

  const text = plain(event.content.text);
  const eventDay = event.occurredAt.slice(0, 10);
  const out: NewFact[] = [];
  for (const f of candidates.values()) {
    if (f.origin.kind === "human" || f.retractedAt !== undefined) continue;
    if (f.validFrom > new Date(event.occurredAt).toISOString()) continue;
    if (f.provenance.some((p) => p.eventId === event.id)) continue;
    if (!inThread(f, tag, threadIds)) continue;

    const carry = {
      type: f.type,
      subject: f.subject,
      ...(f.object ? { object: f.object } : {}),
      predicate: f.predicate,
      validFrom: event.occurredAt,
      provenance: [...f.provenance, speakerProvenance(event, senderRef)],
      origin: ruleOrigin(),
      supersedes: f.id,
      ...(f.tags ? { tags: f.tags } : {}),
    };

    if (f.type === "ask") {
      const v = f.value as Partial<AskValue> | null;
      const askedOf = v?.askedOf?.entityId ?? f.object?.entityId;
      if (v?.answered !== false || askedOf !== senderRef.entityId) continue;
      out.push({
        ...carry,
        value: { ...v, answered: true, answeredBy: event.id },
        statement: `${f.statement} (answered by ${senderRef.name} on ${eventDay})`,
        confidence: Math.max(f.confidence, 0.6),
      });
    } else if (f.type === "commitment") {
      const v = f.value as Partial<CommitmentValue> | null;
      if (v?.status !== "open" || f.subject.entityId !== senderRef.entityId) continue;
      if (FULFILLED.test(text)) {
        out.push({
          ...carry,
          value: { ...v, status: "fulfilled", resolvedBy: event.id },
          statement: `${f.statement} (fulfilled ${eventDay})`,
          confidence: Math.max(f.confidence, 0.6),
        });
      } else if (v.dueAt !== undefined && v.dueAt < eventDay && BROKEN.test(text)) {
        out.push({
          ...carry,
          value: { ...v, status: "broken", resolvedBy: event.id },
          statement: `${f.statement} (broken: missed ${v.dueAt})`,
          confidence: Math.max(f.confidence, 0.6),
        });
      }
    }
  }
  return out;
}

export function createRuleExtractor(store?: Store): Extractor {
  return {
    name: RULE_EXTRACTOR,
    version: RULE_VERSION,
    async extract(event, ctx) {
      const built = sentenceFacts(event, ctx);
      if (built.skippedNoEntity > 0) {
        ctx.log.debug("skipped rule facts whose subject has no entity", { eventId: event.id, count: built.skippedNoEntity });
      }
      return [...built.facts, ...(await closures(event, ctx, store))];
    },
  };
}
