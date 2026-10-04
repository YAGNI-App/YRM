import { silentLogger, type Entity, type ExtractContext, type Fact, type Participant, type SourceEvent } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";

/** Hand-built events and contexts for unit tests; no store, no host. */

export const JACK = { entityId: "e-jack", name: "Jack Collins", address: "jack@yagni.example" };
export const MARCUS = { entityId: "e-marcus", name: "Marcus Bell", address: "marcus@acme.example" };
export const ELENA = { entityId: "e-elena", name: "Elena Vasquez", address: "elena@acme.example" };
export const DANA = { entityId: "e-dana", name: "Dana Okafor", address: "dana@yagni.example" };

type Person = typeof JACK;
const SELF = new Set([JACK.entityId, DANA.entityId]);

function participant(p: Person, role: string): Participant {
  return { role, address: p.address, name: p.name, entityId: p.entityId, ...(SELF.has(p.entityId) ? { self: true } : {}) };
}

let seq = 0;

export function message(
  from: Person,
  to: Person[],
  text: string,
  opts: { cc?: Person[]; at?: string; thread?: string; id?: string } = {},
): SourceEvent {
  seq++;
  return {
    id: opts.id ?? `ev-${seq}`,
    tenantId: "local",
    source: "mail",
    kind: "message",
    externalId: `<m${seq}@test>`,
    occurredAt: opts.at ?? "2026-08-27T14:15:00.000Z",
    ingestedAt: "2026-10-01T00:00:00.000Z",
    participants: [
      participant(from, "from"),
      ...to.map((p) => participant(p, "to")),
      ...(opts.cc ?? []).map((p) => participant(p, "cc")),
    ],
    content: { text, title: "Security review" },
    threadKey: opts.thread ?? "t1",
    meta: {},
  };
}

export function entity(p: Person): Entity {
  return {
    id: p.entityId,
    tenantId: "local",
    kind: "person",
    name: p.name,
    identifiers: [{ type: "email", value: p.address, confidence: 1, source: "test" }],
    status: "proposed",
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
  };
}

export function context(event: SourceEvent, overrides: Partial<ExtractContext> = {}): ExtractContext {
  const people = [JACK, MARCUS, ELENA, DANA].filter((p) => event.participants.some((x) => x.entityId === p.entityId));
  return {
    tenantId: "local",
    thread: [],
    participants: people.map(entity),
    knownFacts: [],
    models: new FakeRouter(),
    log: silentLogger,
    signal: new AbortController().signal,
    ...overrides,
  };
}

/** A stored fact as the host would hand it back in `knownFacts`. */
export function stored(partial: Partial<Fact> & Pick<Fact, "type" | "subject" | "value">): Fact {
  return {
    id: `f-${++seq}`,
    tenantId: "local",
    predicate: partial.type,
    statement: "known fact",
    validFrom: "2026-08-20T00:00:00.000Z",
    recordedAt: "2026-08-20T00:00:00.000Z",
    provenance: [{ eventId: "ev-earlier" }],
    confidence: 0.6,
    origin: { kind: "rule", by: "extract", version: "1" },
    tags: ["thread:t1"],
    ...partial,
  };
}
