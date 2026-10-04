import type { NewEntity, NewFact, NewSourceEvent } from "../contracts/index.ts";
import { newId } from "../ids.ts";

/**
 * Small builders for valid inputs, for tests across packages. Every call gets
 * fresh unique external ids and addresses so fixtures never collide by accident.
 */

export function makeEvent(overrides: Partial<NewSourceEvent> = {}): NewSourceEvent {
  const id = newId().toLowerCase();
  return {
    source: "mail",
    kind: "message",
    externalId: `<${id}@example.test>`,
    occurredAt: "2026-01-15T09:00:00.000Z",
    participants: [
      { role: "from", address: `alice-${id}@example.test`, name: "Alice Example" },
      { role: "to", address: "me@example.test", name: "Me", self: true },
    ],
    content: { text: "Can you send the pricing by Friday?", title: "Pricing" },
    meta: {},
    ...overrides,
  };
}

export function makeFact<V = { what: string }>(overrides: Partial<NewFact<V>> = {}): NewFact<V> {
  const base: NewFact<{ what: string }> = {
    type: "attribute",
    subject: { entityId: "entity-subject", name: "Alice Example" },
    predicate: "title",
    value: { what: "VP Sales" },
    statement: "Alice is VP Sales.",
    validFrom: "2026-01-01T00:00:00.000Z",
    provenance: [{ eventId: "event-fixture", quote: "VP Sales" }],
    confidence: 0.8,
    origin: { kind: "model", by: "extract", model: "test-model", version: "1" },
  };
  return { ...(base as unknown as NewFact<V>), ...overrides };
}

export function makeEntity(overrides: Partial<NewEntity> = {}): NewEntity {
  const id = newId().toLowerCase();
  return {
    kind: "person",
    name: "Alice Example",
    identifiers: [{ type: "email", value: `alice-${id}@example.test`, confidence: 1, source: "mail" }],
    status: "proposed",
    ...overrides,
  };
}
