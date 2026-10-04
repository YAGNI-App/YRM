import { describe, expect, it } from "bun:test";
import { SqliteStore, type NewFact } from "@yrm/core";
import { scoreFacts, type GroundTruth } from "../src/eval.ts";

async function seeded() {
  const store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  const person = (name: string, address: string) =>
    store.createEntity({ kind: "person", name, identifiers: [{ type: "email", value: address, confidence: 1, source: "test" }], status: "proposed" });
  const priya = await person("Priya Raman", "priya@acme.example");
  const priyaNew = await person("Priya Raman", "priya@northwind.example");
  const tom = await person("Tom Fischer", "tom@acme.example");
  const marcus = await person("Marcus Bell", "marcus@acme.example");
  const acme = await store.createEntity({
    kind: "organization",
    name: "Acme",
    identifiers: [{ type: "domain", value: "acme.example", confidence: 1, source: "test" }],
    status: "proposed",
  });
  const { event } = await store.appendEvent({
    source: "test",
    kind: "message",
    externalId: "<m1>",
    occurredAt: "2026-06-02T00:00:00Z",
    participants: [],
    content: { text: "" },
    meta: {},
  });
  const record = (f: Omit<NewFact, "provenance" | "confidence" | "origin" | "statement">) =>
    store.recordFact({ statement: "s", confidence: 0.6, origin: { kind: "rule", by: "test" }, provenance: [{ eventId: event.id }], ...f });
  return { store, priya, priyaNew, tom, marcus, acme, record };
}

const GT: GroundTruth = {
  people: [
    { key: "priya", addresses: ["priya@acme.example", "priya@northwind.example"] },
    { key: "tom", addresses: ["tom@acme.example"] },
    { key: "marcus", addresses: ["marcus@acme.example"] },
  ],
  organizations: [{ domain: "acme.example" }],
  facts: [
    {
      id: "w1",
      type: "relationship",
      predicate: "works_at",
      subject: "priya",
      object: "acme.example",
      statement: "Priya worked at Acme.",
      validFrom: "2026-06-01",
      validTo: "2026-08-14",
    },
  ],
};

describe("scoreFacts", () => {
  it("finds a fact that has correctly ended by looking while it was true", async () => {
    const { store, priya, acme, record } = await seeded();
    const f = await record({ type: "relationship", predicate: "works_at", subject: { entityId: priya.id }, object: { entityId: acme.id }, value: {}, validFrom: "2026-06-02T00:00:00Z" });
    await store.endFactValidity(f.id, "2026-08-14T00:00:00Z", "test");
    const card = await scoreFacts(store, GT);
    expect(card.overall).toMatchObject({ recalled: 1, matched: 1, spurious: 0 });
  });

  it("scores same-person suggestions against people, not facts", async () => {
    const { store, priya, priyaNew, tom, marcus, record } = await seeded();
    const suggest = (a: string, b: string) =>
      record({ type: "signal", predicate: "possibly_same_person", subject: { entityId: a }, object: { entityId: b }, value: {}, validFrom: "2026-06-02T00:00:00Z" });
    await suggest(priyaNew.id, priya.id);
    await suggest(tom.id, marcus.id);
    const card = await scoreFacts(store, GT);
    expect(card.byType["signal"]).toMatchObject({ matched: 1, spurious: 1 });
    expect(card.spurious.map((s) => s.subject)).toEqual(["Tom Fischer"]);
  });
});
