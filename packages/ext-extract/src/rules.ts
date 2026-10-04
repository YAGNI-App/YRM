import type {
  AskValue,
  CommitmentValue,
  DecisionValue,
  EntityRef,
  Extractor,
  ExtractContext,
  Fact,
  FactQuery,
  NewFact,
  ObjectionValue,
  Participant,
  Provenance,
  SourceEvent,
  Store,
} from "@yrm/core";
import { findDue } from "./dates.ts";
import { tokens } from "./eval.ts";
import { bestOverlap, contentWords } from "./overlap.ts";
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
/** Pleasantries with a question mark: "How are you?", "Hope you're well?" */
const GREETING = /\b(?:how are (?:you|things)|how's it going|how have you been|hope (?:you're|you are|all is|all's) well|how was (?:your|the) (?:weekend|trip|holiday))\b/i;
/** Check-ins with no object: "Does that work?", "Make sense?" */
const BARE_CHECK = /^(?:(?:so|and|but),?\s+)?(?:(?:does|do|would|will|did) (?:that|this|it) (?:work|help|make sense)(?: for you)?|(?:does (?:that|this|it) )?makes? sense|sound good|ok(?:ay)?|right|thoughts)\s*\?/i;
/** Proposing a slot is scheduling, not an ask to track (like LOGISTICS for promises). */
const SCHEDULING_ASK =
  /\b(?:call|meeting|chat|time|slot|date|day|morning|afternoon|week|monday|tuesday|wednesday|thursday|friday|\d{1,2}(?::\d\d)?\s*(?:am|pm))\b.*\bwork(?: for (?:you|everyone|both of you|you both))?\s*\?["'”’)\]]*$/i;

const COMMITMENT_PHRASE =
  /\b(?:i will|i'll|we will|we'll|i can|i'm going to|i am going to|will send|will get you|will have|will share|will deliver|will follow up)\b/i;
/** "I'll need", "I'll wait": future tense that promises nothing. */
/** "We'll make a call on scope": a promise to decide is not a deliverable owed to anyone. */
const NOT_A_PROMISE = /\b(?:i|we|she|he|they)(?:'ll| will) (?:need|want|wait|watch|make a (?:call|decision)|decide)\b/i;
/** Scheduling logistics are not tracked commitments (fixtures/README.md: "I'll send an invite", "I'll pencil in Luis"). */
const LOGISTICS = /\b(?:send (?:you )?(?:an?|the) (?:calendar )?invite|calendar invite|pencil(?:ling|ed)? (?:\w+ )?in)\b/i;
/** "Dana will send", "She'll have": a third party's promise, reported by the sender. */
const THIRD_PERSON = /^(?!(?:it|that|this|there|which|what)\b)\S+(?: \S+)?(?:'ll| will)\b/i;
/** "She'll have the order form back to you": who "she" is comes from earlier sentences. */
const PRONOUN_SUBJECT = /^(?:she|he|they)(?:'ll| will)\b/i;
/** First-person markers: a calendar description in the organizer's own voice. */
const FIRST_PERSON = /\b(?:i|i'm|i'll|i've|i'd|me|my|we|we're|we'll|we've|us|our)\b/i;

const DECISION =
  /\b(?:we(?:'ve| have) decided|we(?:'re| are) going (?:to|with)|(?:the )?decision is|approved|signed off|green light|let's go with|is on hold|put\b.{0,60}\bon hold)\b/i;

const OBJECTION =
  /\b(?:concerns?|blockers?|can(?:'t|not) (?:proceed|move forward)|not comfortable|on hold|pause|need to see\b.{0,80}\bbefore|risks?)\b/i;
const HIGH_SEVERITY = /\b(?:blockers?|on hold|pause)\b/i;

const FULFILLED =
  /\b(?:attached|here is|here's|here you go|sent|sending|shared|as promised|please find|done|completed|delivered)\b/i;
/** The party owed something says they have it. */
const RECEIVED = /\b(?:thanks for (?:sending|the)|thank you for (?:sending|the)|got it|received)\b/i;
/** Overlap needed to close a commitment from another thread, and an ask from another thread. */
export const COMMITMENT_OVERLAP = 0.25;
export const ASK_OVERLAP = 0.35;
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

/**
 * An ask needs something to act on: at least four content words, or a
 * "can you <verb> <object>" opening. "Does that work?" has neither.
 */
function hasSubstance(s: string): boolean {
  if (tokens(s).size >= 4) return true;
  const start = ASK_START.exec(s);
  if (!start) return false;
  return s.slice(start[0].length).replace(/[?.!"'”’)\]]+\s*$/, "").trim().split(/\s+/).filter(Boolean).length >= 2;
}

export function isAsk(sentence: string): boolean {
  const s = plain(sentence.trim());
  if (RHETORICAL.test(s) || GREETING.test(s) || BARE_CHECK.test(s) || SCHEDULING_ASK.test(s)) return false;
  if (!ENDS_WITH_QUESTION.test(s) && !ASK_START.test(s)) return false;
  return hasSubstance(s);
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

/** Roles that can stand behind "she", "he" or "they": the people a message is addressed to, or who were in the room. */
function canBeReferent(p: Participant, event: SourceEvent): boolean {
  if (p.role === "to" || p.role === "cc") return true;
  return (event.kind === "note" || event.kind === "meeting") && p.role === "attendee";
}

/**
 * "Rachel Kim in procurement is copied. She'll have the order form back to
 * you by July 17." The pronoun is the most recently named participant in the
 * sentences before it, if that person is on the message. `undefined` means the
 * sentence does not open with a pronoun; `null` means it does and we could
 * not tell who, so the caller keeps the sender at lower confidence.
 */
function pronounOwner(
  sentence: Sentence,
  sentences: Sentence[],
  sender: Participant,
  event: SourceEvent,
  ctx: ExtractContext,
): Participant | null | undefined {
  if (!PRONOUN_SUBJECT.test(plain(sentence.text))) return undefined;
  const before = sentences.filter((x) => x.end <= sentence.start).map((x) => plain(x.text)).join(" ");
  let best: { p: Participant; at: number } | undefined;
  for (const p of distinctByEntity(event.participants)) {
    if (p.entityId === sender.entityId) continue;
    const full = nameOf(p, ctx.participants);
    const first = firstName(p, ctx);
    if (!first) continue;
    const re = new RegExp(`\\b(?:${escapeRe(full)}|${escapeRe(first)})\\b`, "gi");
    let at = -1;
    for (const m of before.matchAll(re)) at = m.index ?? at;
    if (at >= 0 && (!best || at > best.at)) best = { p, at };
  }
  return best && canBeReferent(best.p, event) ? best.p : null;
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
  // A cancelled meeting's description is a note about why it is off, not a fresh round of facts.
  if (isCancelledMeeting(event)) return out;
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

  const sentences = splitSentences(text);
  for (const sentence of sentences) {
    const kinds = classifySentence(sentence.text, event.occurredAt);
    const what = sentence.text;
    // A calendar description is the organizer's agenda, not something anyone said:
    // only what is written in the first person counts as a promise, decision or concern.
    if (event.kind === "meeting" && !FIRST_PERSON.test(plain(what))) {
      kinds.delete("commitment");
      kinds.delete("decision");
      kinds.delete("objection");
    }

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
      const pronoun = pronounOwner(sentence, sentences, sender, event, ctx);
      const ownerP: Participant = namedOwner(what, sender, event, ctx) ?? pronoun ?? sender;
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
          // A pronoun we could not resolve: the sender is a guess.
          ...base(sentence, pronoun === null ? 0.4 : due && /\d/.test(due.phrase) ? 0.65 : 0.6),
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

function isCancelledMeeting(event: SourceEvent): boolean {
  return event.kind === "meeting" && (event.meta as { cancelled?: unknown } | undefined)?.cancelled === true;
}

function inThread(f: Fact, tag: string | undefined, threadIds: Set<string>): boolean {
  if (tag && f.tags?.includes(tag)) return true;
  return f.provenance.some((p) => threadIds.has(p.eventId));
}

function speakerProvenance(event: SourceEvent, speaker: EntityRef): Provenance {
  return { eventId: event.id, speaker };
}

interface SentenceMatch {
  sentence: Sentence;
  score: number;
}

/** Name tokens of everyone on the event: "Priya" says who, not what. */
function nameTokens(event: SourceEvent, ctx: ExtractContext): Set<string> {
  const names = [...event.participants.map((p) => nameOf(p, ctx.participants)), ...ctx.participants.map((e) => e.name)];
  return new Set(names.filter((n) => !n.includes("@")).flatMap((n) => [...tokens(n)]));
}

/**
 * The sentence that best names `what`. With a `gate`, only sentences matching
 * it are considered (a delivery sentence must be the one naming the
 * deliverable), and the subject line may stand in for the name: "Attached is
 * the pilot proposal" under "YAGNI pilot proposal for Acme Robotics".
 */
function bestSentence(
  what: string,
  sentences: Sentence[],
  drop: ReadonlySet<string>,
  gate?: { re: RegExp; title?: string | undefined },
): SentenceMatch | undefined {
  const target = contentWords(plain(what), drop);
  let best: SentenceMatch | undefined;
  for (const sentence of sentences) {
    const s = plain(sentence.text);
    if (gate && !gate.re.test(s)) continue;
    let score = bestOverlap(target, s, drop);
    if (gate?.title) score = Math.max(score, bestOverlap(target, plain(gate.title), drop));
    if (!best || score > best.score) best = { sentence, score };
  }
  return best;
}

/**
 * Close asks and commitments this event resolves.
 *
 * In the thread, a reply from the asked party answers an ask and a delivery
 * phrase from the owing party fulfils a promise: the thread says what it is
 * about. Across threads (a proposal sent as a fresh mail) the event must also
 * name the thing: the delivery sentence has to share content words with the
 * promise (COMMITMENT_OVERLAP), the reply with the question (ASK_OVERLAP), and
 * the person owed or the asker must be on the event. The party owed can close
 * it too, by acknowledging receipt ("thanks for sending the order form").
 *
 * Candidates come from `ctx.knownFacts` plus direct store queries, because
 * knownFacts is capped and a busy sender can push open items out of it.
 */
export async function closures(event: SourceEvent, ctx: ExtractContext, store: Store | undefined): Promise<NewFact[]> {
  if (isCancelledMeeting(event)) return [];
  const sender = senderOf(event);
  const senderRef = sender ? refOf(sender, ctx.participants) : undefined;
  if (!sender || !senderRef) return [];
  const me = senderRef.entityId;
  const tag = threadTag(event);
  const threadIds = new Set(ctx.thread.map((e) => e.id));
  const candidates = new Map<string, Fact>();
  for (const f of ctx.knownFacts) candidates.set(f.id, f);
  if (store) {
    const q = { tenantId: ctx.tenantId, validAt: event.occurredAt };
    const queries: FactQuery[] = [
      { ...q, type: "ask", objectId: me },
      { ...q, type: "commitment", subjectId: me },
      { ...q, type: "commitment", objectId: me },
    ];
    // Same-thread first so a busy tenant's cross-thread backlog cannot crowd them out.
    if (tag) {
      for (const query of queries.slice(0, 2)) for (const f of await store.queryFacts({ ...query, tags: [tag] })) candidates.set(f.id, f);
    }
    for (const query of queries) for (const f of await store.queryFacts(query)) candidates.set(f.id, f);
  }

  const text = plain(event.content.text);
  const sentences = splitSentences(event.content.text);
  const others = new Set(event.participants.flatMap((p) => (p.entityId && p.entityId !== me ? [p.entityId] : [])));
  const drop = nameTokens(event, ctx);
  const eventDay = event.occurredAt.slice(0, 10);
  const eventAt = new Date(event.occurredAt).toISOString();
  const out: NewFact[] = [];
  for (const f of candidates.values()) {
    if (f.origin.kind === "human" || f.retractedAt !== undefined) continue;
    if (f.validFrom > eventAt) continue;
    if (f.provenance.some((p) => p.eventId === event.id)) continue;
    const same = inThread(f, tag, threadIds);

    const carry = (match?: Sentence) => {
      const by: Provenance = speakerProvenance(event, senderRef);
      if (match) {
        by.quote = event.content.text.slice(match.start, match.end);
        by.span = { start: match.start, end: match.end };
      }
      return {
        type: f.type,
        subject: f.subject,
        ...(f.object ? { object: f.object } : {}),
        predicate: f.predicate,
        validFrom: event.occurredAt,
        provenance: [...f.provenance, by],
        origin: ruleOrigin(),
        supersedes: f.id,
        ...(f.tags ? { tags: f.tags } : {}),
      };
    };

    if (f.type === "ask") {
      const v = f.value as Partial<AskValue> | null;
      const askedOf = v?.askedOf?.entityId ?? f.object?.entityId;
      if (v?.answered !== false || askedOf !== me) continue;
      let match: Sentence | undefined;
      if (!same) {
        const askedBy = v.askedBy?.entityId ?? f.subject.entityId;
        if (!others.has(askedBy) || typeof v.what !== "string") continue;
        const best = bestSentence(v.what, sentences, drop);
        if (!best || best.score < ASK_OVERLAP) continue;
        match = best.sentence;
      }
      out.push({
        ...carry(match),
        value: { ...v, answered: true, answeredBy: event.id },
        statement: `${f.statement} (answered by ${senderRef.name} on ${eventDay})`,
        confidence: Math.max(f.confidence, 0.6),
      });
    } else if (f.type === "commitment") {
      const v = f.value as Partial<CommitmentValue> | null;
      if (v?.status !== "open") continue;
      const owedBy = v.owedBy?.entityId ?? f.subject.entityId;
      const owedTo = v.owedTo?.entityId ?? f.object?.entityId;
      const what = typeof v.what === "string" ? v.what : f.statement;
      const fulfilled = (match?: Sentence): NewFact => ({
        ...carry(match),
        value: { ...v, status: "fulfilled", resolvedBy: event.id },
        statement: `${f.statement} (fulfilled ${eventDay})`,
        confidence: Math.max(f.confidence, 0.6),
      });

      if (owedBy === me && same) {
        if (FULFILLED.test(text)) {
          out.push(fulfilled(sentences.find((x) => FULFILLED.test(plain(x.text)))));
        } else if (v.dueAt !== undefined && v.dueAt < eventDay && BROKEN.test(text)) {
          out.push({
            ...carry(),
            value: { ...v, status: "broken", resolvedBy: event.id },
            statement: `${f.statement} (broken: missed ${v.dueAt})`,
            confidence: Math.max(f.confidence, 0.6),
          });
        }
      } else if (owedBy === me) {
        if (owedTo === undefined || !others.has(owedTo)) continue;
        const best = bestSentence(what, sentences, drop, { re: FULFILLED, title: event.content.title });
        if (best && best.score >= COMMITMENT_OVERLAP) out.push(fulfilled(best.sentence));
      } else if (owedTo === me) {
        const best = bestSentence(what, sentences, drop, { re: RECEIVED });
        if (best && best.score >= COMMITMENT_OVERLAP) out.push(fulfilled(best.sentence));
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
