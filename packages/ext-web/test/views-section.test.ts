import { describe, expect, it } from "bun:test";
import type { View } from "../src/components.ts";
import type { EntityPage, FactView } from "../src/data.ts";
import { currentViewFacts, viewsSection } from "../src/views-section.ts";

function fact(over: Partial<FactView>): FactView {
  return {
    id: "f1",
    type: "attribute",
    predicate: "view.deal_stage",
    statement: "deal_stage for Acme: pilot.",
    subject: { entityId: "acme", name: "Acme" },
    object: null,
    value: "pilot",
    validFrom: "2026-09-22T00:00:00.000Z",
    validTo: null,
    recordedAt: "2026-10-01T00:00:00.000Z",
    retractedAt: null,
    knownAt: "2026-10-01T00:00:00.000Z",
    knownUntil: null,
    confidence: 0.8,
    origin: { kind: "model", by: "views", model: "qwen3:8b", version: "1" },
    supersedes: null,
    supersededBy: null,
    tags: [],
    provenance: [{ eventId: "ev1", quote: "before the pilot", event: { title: "Security <review>" } } as FactView["provenance"][number]],
    state: "current",
    laterRetractedAt: null,
    ...over,
  };
}

const page = (facts: FactView[]) => ({ entity: { kind: "organization" }, facts }) as unknown as EntityPage;
const v = {} as View;

describe("views section", () => {
  it("shows one current value per view, human first, with origin and evidence", () => {
    const facts = [
      fact({ id: "m", value: "evaluation", confidence: 0.9 }),
      fact({ id: "h", value: "pilot", confidence: 1, origin: { kind: "human", by: "user:jack" } }),
      fact({ id: "old", predicate: "view.champion", state: "retracted" }),
      fact({ id: "buyer", predicate: "view.economic_buyer", value: { entityId: "marcus", name: "Marcus <Bell>" }, object: { entityId: "marcus", name: "Marcus <Bell>" } }),
      fact({ id: "title", predicate: "title" }),
    ];
    expect(currentViewFacts(facts).map(([n, f]) => `${n}:${f.id}`)).toEqual(["deal_stage:h", "economic_buyer:buyer"]);
    const out = viewsSection(v, page(facts)).toString();
    expect(out).toContain('<td class="mono">deal_stage</td><td>pilot</td><td>1.00</td>');
    expect(out).toContain('class="origin o-human"');
    expect(out).toContain('<a href="/entity/marcus">Marcus &lt;Bell&gt;</a>');
    expect(out).toContain('<a href="/event/ev1" title="before the pilot">Security &lt;review&gt;</a>');
    expect(out).not.toContain("champion");
  });

  it("links the README when there are no values", () => {
    const out = viewsSection(v, page([fact({ predicate: "title" })])).toString();
    expect(out).toContain("No view values for this organization yet");
    expect(out).toContain("packages/ext-views#readme");
  });
});
