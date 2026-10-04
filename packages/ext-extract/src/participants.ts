import type { Entity, EntityRef, Participant, SourceEvent } from "@yrm/core";

/** Roles that mark who authored an event. */
const SENDER_ROLES = new Set(["from", "organizer", "author"]);

export function senderOf(event: SourceEvent): Participant | undefined {
  return event.participants.find((p) => SENDER_ROLES.has(p.role));
}

/** Display name: what the source showed, else the entity's name, else the address. */
export function nameOf(p: Participant, entities: Entity[] = []): string {
  if (p.name) return p.name;
  const e = p.entityId ? entities.find((x) => x.id === p.entityId) : undefined;
  return e?.name ?? p.address ?? "someone";
}

export function refOf(p: Participant, entities: Entity[] = []): EntityRef | undefined {
  if (!p.entityId) return undefined;
  return { entityId: p.entityId, name: nameOf(p, entities) };
}

/** Distinct participants by entity id, first occurrence wins. */
export function distinctByEntity(participants: Participant[]): Participant[] {
  const seen = new Set<string>();
  const out: Participant[] = [];
  for (const p of participants) {
    if (!p.entityId || seen.has(p.entityId)) continue;
    seen.add(p.entityId);
    out.push(p);
  }
  return out;
}

export function threadTag(event: SourceEvent): string | undefined {
  return event.threadKey ? `thread:${event.threadKey}` : undefined;
}
