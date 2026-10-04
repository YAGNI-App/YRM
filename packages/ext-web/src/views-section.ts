import { entityHref, eventHref, type View } from "./components.ts";
import type { EntityPage, FactView } from "./data.ts";
import { html, type Html } from "./html.ts";

/**
 * Views (ADR 0010) on the entity page. A view value is an ordinary attribute
 * fact with predicate `view.<name>`, so this reads them from the facts the
 * page already loaded and needs nothing from @yrm/ext-views. It follows the
 * time machine like the timeline does: only facts current at the chosen moment.
 */
const PREFIX = "view.";
const README = "https://github.com/YAGNI-App/YRM/tree/main/packages/ext-views#readme";

/** One value per view name: human first, then highest confidence, then latest recorded. */
export function currentViewFacts(facts: FactView[]): Array<[string, FactView]> {
  const best = new Map<string, FactView>();
  const rank = (f: FactView): number => (f.origin.kind === "human" ? 1 : 0);
  for (const f of facts) {
    if (!f.predicate.startsWith(PREFIX) || f.state !== "current") continue;
    const name = f.predicate.slice(PREFIX.length);
    const cur = best.get(name);
    if (
      !cur ||
      rank(f) > rank(cur) ||
      (rank(f) === rank(cur) && (f.confidence > cur.confidence || (f.confidence === cur.confidence && f.recordedAt > cur.recordedAt)))
    ) {
      best.set(name, f);
    }
  }
  return [...best.entries()].sort(([a], [b]) => a.localeCompare(b));
}

function display(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (typeof value === "object" && !Array.isArray(value)) {
    const v = value as Record<string, unknown>;
    if (typeof v["name"] === "string") return v["name"];
  }
  return typeof value === "string" ? value : JSON.stringify(value);
}

function valueCell(f: FactView): Html {
  // Entity-typed views carry the entity as the fact's object; link it.
  if (f.object) return html`<a href="${entityHref(f.object.entityId)}">${f.object.name ?? display(f.value)}</a>`;
  return html`${display(f.value)}`;
}

function originGlyph(f: FactView): Html {
  const detail = [f.origin.by, f.origin.model].filter(Boolean).join(" · ");
  return html`<span class="${`origin o-${f.origin.kind}`}" title="${`${f.origin.kind} origin: ${detail}`}"><span class="glyph" aria-hidden="true"></span>${f.origin.kind}</span>`;
}

function evidenceCell(f: FactView): Html {
  const first = f.provenance[0];
  if (!first) return html``;
  const label = first.event?.title ?? "source";
  const more = f.provenance.length > 1 ? html` <span class="muted">+${f.provenance.length - 1}</span>` : "";
  return html`<a href="${eventHref(first.eventId)}" title="${first.quote ?? ""}">${label}</a>${more}`;
}

export function viewsSection(_v: View, page: EntityPage): Html {
  const rows = currentViewFacts(page.facts);
  if (rows.length === 0) {
    return html`<section class="views"><h2>Views</h2><p class="muted small">No view values for this ${page.entity.kind} yet. Views are fields you describe in English and YRM fills from facts; see <a href="${README}">how to define one</a>.</p></section>`;
  }
  return html`<section class="views">
  <h2>Views</h2>
  <table class="views-table small">
    <thead><tr><th scope="col">View</th><th scope="col">Value</th><th scope="col">Confidence</th><th scope="col">Origin</th><th scope="col">Evidence</th></tr></thead>
    <tbody>${rows.map(
      ([name, f]) =>
        html`<tr><td class="mono">${name}</td><td>${valueCell(f)}</td><td>${f.confidence.toFixed(2)}</td><td>${originGlyph(f)}</td><td>${evidenceCell(f)}</td></tr>`,
    )}</tbody>
  </table>
</section>`;
}
