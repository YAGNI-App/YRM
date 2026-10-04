import { newId, type Entity, type Fact, type Store, type ViewDefinition } from "@yrm/core";
import { VIEWS, VIEWS_VERSION, predicateOf } from "./definitions.ts";
import { checkValue, currentValue, entityLookup, sameValue, setStatus, statementFor } from "./values.ts";

export type HumanSetResult = { ok: true; fact: Fact; unchanged: boolean } | { ok: false; reason: string };

/**
 * A person sets a view value. Every fact needs an event behind it, so this
 * appends a note event saying who set what (the log stays the source of
 * truth), then records a human-origin fact that supersedes the current value.
 * The note names the entity in `meta`, not as a participant, so it does not
 * count as contact with them.
 */
export async function setByHuman(
  store: Store,
  tenantId: string,
  def: ViewDefinition,
  entity: Entity,
  raw: string,
  by: string,
): Promise<HumanSetResult> {
  const checked = await checkValue(def, parseLiteral(def, raw), entityLookup(store, tenantId));
  if (!checked.ok) return { ok: false, reason: checked.reason };
  const current = await currentValue(store, tenantId, entity.id, def.name);
  if (current && current.origin.kind === "human" && sameValue(current.value, checked.value)) {
    return { ok: true, fact: current, unchanged: true };
  }
  const at = new Date().toISOString();
  const statement = statementFor(def, entity, checked.value);
  const { event } = await store.appendEvent({
    tenantId,
    source: VIEWS,
    kind: "note",
    externalId: `view-set:${newId()}`,
    occurredAt: at,
    participants: [{ role: "author", name: by, self: true }],
    content: { title: `Set ${def.name} for ${entity.name}`, text: `${by} set ${statement}` },
    meta: { view: def.name, entityId: entity.id },
  });
  const fact = await store.recordFact({
    tenantId,
    type: "attribute",
    subject: { entityId: entity.id, name: entity.name },
    ...(checked.object ? { object: checked.object } : {}),
    predicate: predicateOf(def.name),
    value: checked.value,
    statement,
    validFrom: at,
    provenance: [{ eventId: event.id, quote: statement, span: { start: by.length + 5, end: by.length + 5 + statement.length } }],
    confidence: 1,
    origin: { kind: "human", by, version: VIEWS_VERSION },
    tags: [`view:${def.name}`],
    ...(current ? { supersedes: current.id } : {}),
  });
  await setStatus(store, entity.id, def.name, { state: "recorded", reason: `set by ${by}` });
  return { ok: true, fact, unchanged: false };
}

/** `view set ... 3` on a number view means 3, `true` on a boolean view means true; json views parse JSON. */
function parseLiteral(def: ViewDefinition, raw: string): unknown {
  if (def.valueType !== "json") return raw;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}
