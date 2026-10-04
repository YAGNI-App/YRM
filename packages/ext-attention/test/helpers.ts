import { createHost, silentLogger, SqliteStore } from "@yrm/core";
import type { Entity, EntityRef, Fact, Host, Logger, NewFact, Participant, QueueItem, Route, YrmConfig } from "@yrm/core";
// Test doubles live in core but are not part of its public surface.
import { FakeRouter, type ScriptedResponse } from "../../core/src/testing/fake-router.ts";
import attention, { manifest } from "../src/index.ts";

export { FakeRouter };

export const TODAY = "2026-10-03";
export const TENANT = "local";

export interface Harness {
  host: Host;
  store: SqliteStore;
  router: FakeRouter;
  me: Entity;
  /** Move the store's clock; recordedAt and retractedAt follow it. */
  setClock(iso: string): void;
  person(name: string, email: string, parentId?: string): Promise<Entity>;
  org(name: string, domain: string, status?: Entity["status"]): Promise<Entity>;
  event(opts: EventOpts): Promise<string>;
  fact<V>(f: Partial<NewFact<V>> & Pick<NewFact<V>, "type" | "subject" | "value">): Promise<Fact<V>>;
  rank(today?: string): Promise<QueueItem[]>;
}

export interface EventOpts {
  at: string;
  title?: string;
  text?: string;
  kind?: string;
  from?: Entity;
  to?: Entity[];
  attendees?: Entity[];
  meta?: Record<string, unknown>;
}

export const ref = (e: Entity): EntityRef => ({ entityId: e.id, name: e.name });

export async function harness(
  opts: { settings?: Record<string, unknown>; routes?: Record<string, Route[]>; responses?: ScriptedResponse[]; log?: Logger } = {},
): Promise<Harness> {
  let now = new Date("2026-10-01T12:00:00Z");
  const store = new SqliteStore({ path: ":memory:", clock: () => now });
  await store.migrate();
  const router = new FakeRouter(opts.responses ?? [], opts.routes ?? {});
  const config: YrmConfig = {
    tenant: { id: TENANT, selfAddresses: ["me@yagni.example"], timezone: "UTC" },
    storage: { driver: "sqlite", path: ":memory:" },
    models: { routes: {} },
    settings: { attention: { selfAddresses: ["me@yagni.example"], selfDomains: ["yagni.example"], timezone: "UTC", ...opts.settings } },
  };
  const host = createHost(config, { store, models: router, log: opts.log ?? silentLogger });
  await host.use(attention, manifest);

  const person = (name: string, email: string, parentId?: string): Promise<Entity> =>
    store.createEntity({
      tenantId: TENANT,
      kind: "person",
      name,
      status: "confirmed",
      identifiers: [{ type: "email", value: email, confidence: 1, source: "test" }],
      ...(parentId ? { summary: { parentId } } : {}),
    });
  const org = (name: string, domain: string, status: Entity["status"] = "confirmed"): Promise<Entity> =>
    store.createEntity({
      tenantId: TENANT,
      kind: "organization",
      name,
      status,
      identifiers: [{ type: "domain", value: domain, confidence: 1, source: "test" }],
    });
  const me = await person("Me Myself", "me@yagni.example");

  let seq = 0;
  const event = async (o: EventOpts): Promise<string> => {
    const p = (e: Entity, role: string): Participant => ({
      role,
      address: e.identifiers[0]!.value,
      name: e.name,
      entityId: e.id,
      ...(e.id === me.id ? { self: true } : {}),
    });
    const participants = [
      ...(o.from ? [p(o.from, "from")] : []),
      ...(o.to ?? []).map((e) => p(e, "to")),
      ...(o.attendees ?? []).map((e) => p(e, "attendee")),
    ];
    const { event: ev } = await store.appendEvent({
      tenantId: TENANT,
      source: o.kind === "meeting" ? "calendar" : "mail",
      kind: o.kind ?? "message",
      externalId: `ext-${++seq}`,
      occurredAt: o.at,
      participants,
      content: { text: o.text ?? "body", ...(o.title ? { title: o.title } : {}) },
      meta: o.meta ?? {},
    });
    return ev.id;
  };

  const fact = async <V>(f: Partial<NewFact<V>> & Pick<NewFact<V>, "type" | "subject" | "value">): Promise<Fact<V>> => {
    const provenance = f.provenance ?? [{ eventId: await event({ at: f.validFrom ?? "2026-09-01T10:00:00Z", title: "Evidence" }) }];
    return store.recordFact<V>({
      tenantId: TENANT,
      predicate: f.type,
      statement: `A ${f.type} fact.`,
      validFrom: "2026-09-01T10:00:00Z",
      confidence: 0.9,
      origin: { kind: "model", by: "extract", version: "1" },
      ...f,
      provenance,
    });
  };

  return {
    host,
    store,
    router,
    me,
    setClock: (iso) => {
      now = new Date(iso);
    },
    person,
    org,
    event,
    fact,
    rank: (today = TODAY) => host.rank(today),
  };
}

export const byRule = (items: QueueItem[], rule: string): QueueItem[] => items.filter((i) => i.by === `attention/${rule}`);
