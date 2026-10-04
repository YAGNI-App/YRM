import { createHost, silentLogger, SqliteStore, type Entity, type Fact, type Host, type ModelRouter, type SourceEvent, type Store, type YrmConfig } from "@yrm/core";
import views, { manifest } from "../src/index.ts";

export const ROUTES = { extract: [{ provider: "fake", model: "fake-small" }] };

export function config(settings: Record<string, unknown> = {}): YrmConfig {
  return {
    tenant: { id: "local", name: "YAGNI", selfAddresses: ["jack@yagni.example"], selfDomains: ["yagni.example"], timezone: "UTC" },
    storage: { driver: "sqlite", path: ":memory:" },
    models: { routes: {} },
    settings: { views: settings },
  };
}

export interface Seed {
  acme: Entity;
  marcus: Entity;
  elena: Entity;
  yagni: Entity;
  pricing: SourceEvent;
  security: SourceEvent;
  ask: Fact;
  commitment: Fact;
  role: Fact;
}

/** Acme: Marcus approves pricing (Aug 20), Elena runs the security review (Sep 22). */
export async function seed(store: Store): Promise<Seed> {
  const acme = await store.createEntity({
    kind: "organization",
    name: "Acme Robotics",
    identifiers: [{ type: "domain", value: "acme-robotics.example", confidence: 1, source: "test" }],
    status: "proposed",
  });
  const yagni = await store.createEntity({
    kind: "organization",
    name: "YAGNI",
    identifiers: [{ type: "domain", value: "yagni.example", confidence: 1, source: "test" }],
    status: "confirmed",
  });
  const person = (name: string, email: string) =>
    store.createEntity({
      kind: "person",
      name,
      identifiers: [{ type: "email", value: email, confidence: 1, source: "test" }],
      status: "proposed",
      summary: { parentId: acme.id },
    });
  const marcus = await person("Marcus Bell", "marcus@acme-robotics.example");
  const elena = await person("Elena Vasquez", "elena@acme-robotics.example");
  const jack = { role: "to", address: "jack@yagni.example", name: "Jack Collins", self: true };

  const { event: pricing } = await store.appendEvent({
    source: "mail",
    kind: "message",
    externalId: "<pricing@acme>",
    occurredAt: "2026-08-20T15:00:00.000Z",
    threadKey: "pricing",
    participants: [{ role: "from", address: "marcus@acme-robotics.example", name: "Marcus Bell", entityId: marcus.id }, jack],
    content: { title: "Pricing", text: "I approve the pricing on our side. Can you send the order form by Friday?" },
    meta: {},
  });
  const { event: security } = await store.appendEvent({
    source: "mail",
    kind: "message",
    externalId: "<security@acme>",
    occurredAt: "2026-09-22T10:00:00.000Z",
    threadKey: "security",
    participants: [{ role: "from", address: "elena@acme-robotics.example", name: "Elena Vasquez", entityId: elena.id }, jack],
    content: { title: "Security review", text: "We need the SOC 2 Type II report before the pilot can start." },
    meta: {},
  });
  const origin = { kind: "rule" as const, by: "extract", version: "1" };
  const ask = await store.recordFact({
    type: "ask",
    subject: { entityId: marcus.id, name: marcus.name },
    predicate: "asked",
    value: { what: "send the order form", answered: false },
    statement: "Marcus asked Jack to send the order form by Friday.",
    validFrom: pricing.occurredAt,
    provenance: [{ eventId: pricing.id }],
    confidence: 0.6,
    origin,
  });
  const role = await store.recordFact({
    type: "role",
    subject: { entityId: marcus.id, name: marcus.name },
    predicate: "approves_pricing",
    value: { role: "approver", scope: "pricing" },
    statement: "Marcus Bell approves pricing at Acme Robotics.",
    validFrom: pricing.occurredAt,
    provenance: [{ eventId: pricing.id, quote: "I approve the pricing" }],
    confidence: 0.7,
    origin,
  });
  const commitment = await store.recordFact({
    type: "commitment",
    subject: { entityId: elena.id, name: elena.name },
    predicate: "committed_to",
    value: { what: "start the pilot after the report", status: "open" },
    statement: "Elena will start the pilot once the SOC 2 report arrives.",
    validFrom: security.occurredAt,
    provenance: [{ eventId: security.id }],
    confidence: 0.6,
    origin,
  });
  return { acme, marcus, elena, yagni, pricing, security, ask, commitment, role };
}

export async function bootHost(models: ModelRouter, settings: Record<string, unknown> = {}): Promise<{ host: Host; store: SqliteStore; s: Seed }> {
  const store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  const s = await seed(store);
  const host = createHost(config(settings), { store, models, log: silentLogger });
  await host.use(views, manifest);
  await host.start();
  return { host, store, s };
}

export async function viewFacts(store: Store, entityId: string, name: string, includeRetracted = false): Promise<Fact[]> {
  return store.queryFacts({ tenantId: "local", subjectId: entityId, predicate: `view.${name}`, includeRetracted });
}
