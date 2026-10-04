import type { JsonSchema } from "@yrm/core";

/**
 * Prompts and output schemas for the model-backed extractors. The version
 * suffix is part of the name: change a prompt, add a new constant, bump the
 * extractor version, and leave the old one so past facts stay explainable.
 */

export const TRIAGE_SYSTEM_V1 = `You triage business messages for a relationship-tracking system.

Read one message and answer with JSON only:
- relevant: true if the message carries anything about the working relationship (plans, promises, requests, decisions, concerns, people changing roles or jobs). Pleasantries alone, receipts and automated notices are not relevant.
- has.commitment: someone promises to do something ("I'll send it by Friday", "she will have the form back by July 17").
- has.ask: someone asks someone else for something: a question that expects an answer, or a request for action.
- has.decision: a decision is made or communicated ("we're going with Option A", "the pilot is on hold").
- has.objection: pushback, a concern, a blocker or a risk someone raises.
- has.signal: something changed that may matter: a job change, someone leaving, a delay, a change in tone.
- summary: at most 20 words, plain, no names you are unsure of.

When unsure, prefer true for the has.* flags: a later step checks them.`;

export const TRIAGE_SCHEMA_V1: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["relevant", "has", "summary"],
  properties: {
    relevant: { type: "boolean" },
    has: {
      type: "object",
      additionalProperties: false,
      required: ["commitment", "ask", "decision", "objection", "signal"],
      properties: {
        commitment: { type: "boolean" },
        ask: { type: "boolean" },
        decision: { type: "boolean" },
        objection: { type: "boolean" },
        signal: { type: "boolean" },
      },
    },
    summary: { type: "string", description: "At most 20 words." },
  },
};

export const EXTRACT_SYSTEM_V1 = `You extract facts from one business message for a relationship-tracking system. Facts are what the system knows, each pinned to where it came from and when it was true.

Fact types (from the system's contract):
- commitment: "Someone promised to do something." value: { what, dueAt?, status: "open" | "fulfilled" | "broken" | "cancelled" }. The subject is who owes it ("Who owes it. Defaults to the fact subject."); the object is who it is owed to ("Who it is owed to. Defaults to the fact object.").
- ask: "Someone asked someone for something." value: { what, answered }. The subject is who asked; the object is who was asked. answered is "True once a reply addressing the ask has been seen."
- decision: "A decision was made or communicated." value: { what, rationale? }. The subject is who decided.
- objection: "Pushback, concern or blocker." value: { what, severity?: "low" | "medium" | "high", resolved }. The subject is who raised it.
- signal: "Something changed that may matter: job change, silence, sentiment shift." Use predicates like job_change, delay, sentiment_shift.
- role: "A role someone holds relative to something: decision maker, champion, owner." value: { role, scope? }. Use predicates like economic_buyer, champion, security_approver, holds_role.
- relationship: "A relationship between two entities: works_at, reports_to, competes_with."
- attribute: "A scalar attribute of an entity: title, timezone, deal stage, amount."

Time. Facts are bi-temporal. validFrom is when the fact became true in the world, not when we read about it. Leave validFrom out to mean the message's own date; set it only when the text says the fact became true at another time (for example "today is my last day" in a message held back for weeks is true on the message date, while "she joined last month" is true earlier).

Evidence. Every fact needs a quote: a verbatim, contiguous excerpt of the message text that supports it, copied character for character. Do not paraphrase, join fragments or fix typos inside a quote. A fact you cannot quote is a fact you must not emit.

Parties. subjectEntityId and objectEntityId must be entity ids from the participant list. Never invent ids. "I" is the sender; "you" is usually the first recipient. A person mentioned in the text who is not a participant cannot be a subject.

Known facts. You are shown facts already recorded about these participants, with their ids. If this message answers a known open ask, fulfils or breaks a known open commitment, or resolves a known objection, emit the updated fact (same type and subject, new value) and set supersedes to the old fact's id. Do not restate known facts that did not change.

Be selective. Extract what a person managing this relationship would want to remember: real promises with a deliverable, questions that expect an answer, decisions, concerns and changes. Skip pleasantries, scheduling chatter and promises like "I'll send an invite".

statement is one plain sentence a person can read, naming the parties. confidence is 0..1: how sure you are the fact is real and correctly attributed.`;

const ENTITY_ID = { type: "string", description: "An entity id from the participant list." };

export const EXTRACT_SCHEMA_V1: JsonSchema = {
  type: "object",
  additionalProperties: false,
  required: ["facts"],
  properties: {
    facts: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        required: ["type", "predicate", "subjectEntityId", "statement", "quote", "value", "confidence"],
        properties: {
          type: {
            type: "string",
            enum: ["commitment", "ask", "decision", "objection", "signal", "role", "relationship", "attribute"],
          },
          predicate: { type: "string", description: "snake_case verb, e.g. committed_to, asked, decided, objected, job_change." },
          subjectEntityId: ENTITY_ID,
          objectEntityId: ENTITY_ID,
          statement: { type: "string" },
          quote: { type: "string", description: "Verbatim excerpt of the message text." },
          value: {
            type: "object",
            additionalProperties: false,
            properties: {
              what: { type: "string" },
              dueAt: { type: "string", description: "ISO 8601 date." },
              status: { type: "string", enum: ["open", "fulfilled", "broken", "cancelled"] },
              answered: { type: "boolean" },
              severity: { type: "string", enum: ["low", "medium", "high"] },
              resolved: { type: "boolean" },
              rationale: { type: "string" },
              role: { type: "string" },
              scope: { type: "string" },
            },
          },
          validFrom: { type: "string", description: "ISO 8601. Omit to use the message date." },
          supersedes: { type: "string", description: "Id of a known fact this one replaces." },
          confidence: { type: "number" },
        },
      },
    },
  },
};

export const TRIAGE_CACHE_KEY = "extract/triage/v1";
export const EXTRACT_CACHE_KEY = "extract/extract/v1";
