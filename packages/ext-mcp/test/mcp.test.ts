import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import {
  createHost,
  silentLogger,
  SqliteStore,
  StoreError,
  type Command,
  type CommandContext,
  type Entity,
  type Fact,
  type Host,
  type SourceEvent,
  type YrmConfig,
} from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { createMcpExtension, createServerForHost, manifest } from "../src/index.ts";

const T = (iso: string): Date => new Date(iso);
let clock = T("2026-06-01T00:00:00.000Z");

const config: YrmConfig = {
  tenant: { id: "local", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} },
};

const READ_TOOLS = [
  "yrm_search_entities",
  "yrm_get_entity",
  "yrm_facts",
  "yrm_events",
  "yrm_thread",
  "yrm_today",
  "yrm_context",
  "yrm_open_items",
];
const WRITE_TOOLS = [
  "yrm_record_fact",
  "yrm_record_note",
  "yrm_confirm_entity",
  "yrm_reject_entity",
  "yrm_merge_entities",
  "yrm_dismiss",
];

interface Seed {
  acme: Entity;
  marcus: Entity;
  intro: SourceEvent;
  scoping: SourceEvent;
  oldTitle: Fact;
  newTitle: Fact;
  orderForm: Fact;
}

let host: Host;
let store: SqliteStore;
let client: Client;
let seed: Seed;

interface CallResult {
  isError: boolean;
  data: Record<string, unknown>;
  text: string;
}

async function call(name: string, args: Record<string, unknown> = {}): Promise<CallResult> {
  const res = await client.callTool({ name, arguments: args });
  const content = res.content as Array<{ type: string; text?: string }>;
  const text = content[0]?.text ?? "";
  let data: Record<string, unknown> = {};
  try {
    data = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // SDK-level validation errors are plain text.
  }
  return { isError: res.isError === true, data, text };
}

type FactJson = {
  id: string;
  statement: string;
  origin: { kind: string; by: string; version?: string };
  confidence: number;
  validFrom: string;
  validTo: string | null;
  recordedAt: string;
  retractedAt: string | null;
  provenance: Array<{ eventId: string; speaker: string | null; quote: string | null; event: { title: string | null; date: string | null } | null }>;
};

async function seedStore(s: SqliteStore): Promise<Seed> {
  const acme = await s.createEntity({
    kind: "organization",
    name: "Acme Robotics",
    identifiers: [{ type: "domain", value: "acme-robotics.example", confidence: 1, source: "resolve" }],
    status: "confirmed",
  });
  const marcus = await s.createEntity({
    kind: "person",
    name: "Marcus Bell",
    identifiers: [{ type: "email", value: "marcus.bell@acme-robotics.example", confidence: 1, source: "resolve" }],
    status: "proposed",
    summary: { parentId: acme.id },
  });
  const participants = [
    { role: "from", address: "marcus.bell@acme-robotics.example", name: "Marcus Bell", entityId: marcus.id },
    { role: "to", address: "jack@yagni.example", name: "Jack Collins", self: true },
  ];
  const { event: intro } = await s.appendEvent({
    source: "mail",
    kind: "message",
    externalId: "<intro@acme>",
    occurredAt: "2026-06-02T15:00:00.000Z",
    threadKey: "thread-intro",
    participants,
    content: { title: "Intro: Marcus, meet Jack", text: "I run operations here as VP Operations. ".repeat(60) },
    meta: {},
  });
  const { event: scoping } = await s.appendEvent({
    source: "mail",
    kind: "message",
    externalId: "<scoping@acme>",
    occurredAt: "2026-07-09T16:00:00.000Z",
    threadKey: "thread-intro",
    participants,
    content: { title: "Re: Pilot scope", text: "Now SVP Operations. Order form back from procurement by July 17." },
    meta: {},
  });

  const speaker = { entityId: marcus.id, name: "Marcus Bell" };
  clock = T("2026-06-03T00:00:00.000Z");
  const oldTitle = await s.recordFact({
    type: "attribute",
    subject: { entityId: marcus.id, name: "Marcus Bell" },
    predicate: "title",
    value: { title: "VP Operations" },
    statement: "Marcus Bell is VP Operations at Acme Robotics.",
    validFrom: intro.occurredAt,
    provenance: [{ eventId: intro.id, speaker, quote: "VP Operations" }],
    confidence: 0.8,
    origin: { kind: "model", by: "extract", model: "fake", version: "1" },
  });
  clock = T("2026-07-10T00:00:00.000Z");
  const newTitle = await s.recordFact({
    type: "attribute",
    subject: { entityId: marcus.id, name: "Marcus Bell" },
    predicate: "title",
    value: { title: "SVP Operations" },
    statement: "Marcus Bell is SVP Operations at Acme Robotics.",
    validFrom: scoping.occurredAt,
    provenance: [{ eventId: scoping.id, speaker, quote: "Now SVP Operations." }],
    confidence: 0.8,
    origin: { kind: "model", by: "extract", model: "fake", version: "1" },
    supersedes: oldTitle.id,
  });
  const orderForm = await s.recordFact({
    type: "commitment",
    subject: { entityId: marcus.id, name: "Marcus Bell" },
    predicate: "committed_to",
    value: { what: "Order form back from procurement", dueAt: "2026-07-17T00:00:00.000Z", status: "open" },
    statement: "Marcus promised the order form back from procurement by July 17.",
    validFrom: scoping.occurredAt,
    provenance: [{ eventId: scoping.id, speaker, quote: "Order form back from procurement by July 17." }],
    confidence: 0.9,
    origin: { kind: "model", by: "extract", model: "fake", version: "1" },
  });
  clock = T("2026-10-03T12:00:00.000Z");
  return { acme, marcus, intro, scoping, oldTitle, newTitle, orderForm };
}

beforeAll(async () => {
  store = new SqliteStore({ path: ":memory:", clock: () => clock });
  await store.migrate();
  host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  seed = await seedStore(store);

  await host.use(createMcpExtension({ host }), manifest);
  // A second extension: a fake ranker, and a tool that records model facts, to
  // prove the server exposes every registered tool and surfaces store errors.
  await host.use(
    (yrm) => {
      yrm.registerRanker({
        name: "fake-ranker",
        async rank(_ctx, candidates) {
          return [
            ...candidates,
            {
              key: "unanswered:marcus",
              action: "Answer Marcus's exit-terms question",
              reason: "Marcus asked on Sep 2 and nobody replied.",
              score: 0.9,
              about: [{ entityId: seed.marcus.id, name: "Marcus Bell" }],
              evidence: { factIds: [seed.orderForm.id], eventIds: [seed.scoping.id] },
              by: "fake-ranker",
            },
            {
              key: "silence:acme",
              action: "Check in with Acme",
              reason: "No mail for 31 days.",
              score: 0.5,
              about: [{ entityId: seed.acme.id, name: "Acme Robotics" }],
              evidence: { factIds: [], eventIds: [] },
              by: "fake-ranker",
            },
          ];
        },
      });
      yrm.registerTool({
        name: "test_model_fact",
        description: "Test-only: record a model-origin fact.",
        inputSchema: {
          type: "object",
          properties: { supersedes: { type: "string" }, eventId: { type: "string" } },
          required: ["supersedes", "eventId"],
        },
        readOnly: false,
        async run(raw, ctx) {
          const input = raw as { supersedes: string; eventId: string };
          return ctx.store.recordFact({
            type: "attribute",
            subject: { entityId: seed.marcus.id },
            predicate: "title",
            value: { title: "VP Operations" },
            statement: "Marcus Bell is VP Operations.",
            validFrom: "2026-10-01T00:00:00.000Z",
            provenance: [{ eventId: input.eventId }],
            confidence: 0.7,
            origin: { kind: "model", by: "extract", model: "fake", version: "2" },
            supersedes: input.supersedes,
          });
        },
      });
    },
    { name: "test-fixtures" },
  );

  const server = createServerForHost(host);
  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  client = new Client({ name: "test-agent", version: "1.0.0" });
  await client.connect(clientTransport);
});

afterAll(async () => {
  await client.close();
  await host.close();
});

describe("tool listing", () => {
  it("lists every registered tool with a description and read-only hint", async () => {
    const { tools } = await client.listTools();
    const names = tools.map((t) => t.name);
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS, "test_model_fact"]) expect(names).toContain(name);
    for (const t of tools) expect((t.description ?? "").length).toBeGreaterThan(20);
    const byName = new Map(tools.map((t) => [t.name, t]));
    expect(byName.get("yrm_facts")?.annotations?.readOnlyHint).toBe(true);
    expect(byName.get("yrm_record_fact")?.annotations?.readOnlyHint).toBe(false);
    expect(byName.get("yrm_facts")?.description).toContain("validAt");
    const factsSchema = byName.get("yrm_facts")?.inputSchema as { properties?: Record<string, { description?: string }> };
    expect(factsSchema.properties?.["asOf"]?.description).toContain("Belief time");
  });

  it("registers the tools on the host for in-process agents too", () => {
    for (const name of [...READ_TOOLS, ...WRITE_TOOLS]) expect(host.registry.tools.has(name)).toBe(true);
    expect(host.registry.tools.get("yrm_events")?.exposure).toBe("deferred");
    expect(host.registry.sources.has("mcp")).toBe(true);
  });
});

describe("read tools", () => {
  it("searches by name and by identifier", async () => {
    const byName = await call("yrm_search_entities", { query: "marcus" });
    expect((byName.data["entities"] as Array<{ id: string }>).map((e) => e.id)).toEqual([seed.marcus.id]);
    const byDomain = await call("yrm_search_entities", { query: "ACME-robotics.example" });
    expect((byDomain.data["entities"] as Array<{ id: string }>).map((e) => e.id)).toEqual([seed.acme.id]);
  });

  it("returns an entity with its organization, current facts and recent events", async () => {
    const r = await call("yrm_get_entity", { id: seed.marcus.id });
    expect(r.isError).toBe(false);
    expect((r.data["organization"] as { name: string }).name).toBe("Acme Robotics");
    const facts = r.data["facts"] as FactJson[];
    expect(facts.map((f) => f.id).sort()).toEqual([seed.newTitle.id, seed.orderForm.id].sort());
    const events = r.data["recentEvents"] as Array<{ title: string }>;
    expect(events.map((e) => e.title)).toEqual(["Re: Pilot scope", "Intro: Marcus, meet Jack"]);
  });

  it("answers 'what we knew' with asOf and 'what is true' by default", async () => {
    const before = await call("yrm_facts", { entityId: seed.marcus.id, predicate: "title", asOf: "2026-07-01T00:00:00Z" });
    expect((before.data["facts"] as FactJson[]).map((f) => f.id)).toEqual([seed.oldTitle.id]);

    const now = await call("yrm_facts", { entityId: seed.marcus.id, predicate: "title" });
    expect((now.data["facts"] as FactJson[]).map((f) => f.id)).toEqual([seed.newTitle.id]);

    const history = await call("yrm_facts", { entityId: seed.marcus.id, predicate: "title", includeRetracted: true, validAt: "2026-06-10T00:00:00Z" });
    const old = (history.data["facts"] as FactJson[]).find((f) => f.id === seed.oldTitle.id);
    expect(old?.retractedAt).not.toBeNull();
  });

  it("returns provenance with event title and date plus both time ranges on every fact", async () => {
    const r = await call("yrm_facts", { entityId: seed.marcus.id, includeRetracted: true, validAt: "2026-07-20T00:00:00Z" });
    const facts = r.data["facts"] as FactJson[];
    expect(facts.length).toBeGreaterThan(0);
    for (const f of facts) {
      expect(f.provenance.length).toBeGreaterThan(0);
      for (const p of f.provenance) {
        expect(p.event?.title).toBeTruthy();
        expect(p.event?.date).toBeTruthy();
        expect(p.speaker).toBe("Marcus Bell");
      }
      expect(f).toHaveProperty("validTo");
      expect(f).toHaveProperty("retractedAt");
      expect(f.recordedAt).toBeTruthy();
      expect(typeof f.confidence).toBe("number");
      expect(f.origin.kind).toBe("model");
    }
  });

  it("returns events truncated with a note, and threads oldest first", async () => {
    const ev = await call("yrm_events", { entityId: seed.marcus.id });
    expect(String(ev.data["note"])).toContain("yrm_facts");
    const events = ev.data["events"] as Array<{ title: string; text: string; truncated: boolean }>;
    const intro = events.find((e) => e.title.startsWith("Intro"))!;
    expect(intro.text.length).toBe(1500);
    expect(intro.truncated).toBe(true);

    const th = await call("yrm_thread", { threadKey: "thread-intro" });
    expect((th.data["events"] as Array<{ title: string }>).map((e) => e.title)).toEqual([
      "Intro: Marcus, meet Jack",
      "Re: Pilot scope",
    ]);
  });

  it("groups open items with overdue commitments first", async () => {
    const r = await call("yrm_open_items", { orgId: seed.acme.id });
    const commitments = r.data["commitments"] as { overdue: FactJson[]; open: FactJson[] };
    expect(commitments.overdue.map((f) => f.id)).toEqual([seed.orderForm.id]);
    expect((r.data["counts"] as Record<string, number>)["commitmentsOverdue"]).toBe(1);
  });

  it("builds a context bundle with a reading guide and open items citing events", async () => {
    const r = await call("yrm_context", { entityIds: [seed.marcus.id], budget: 4000 });
    expect(r.isError).toBe(false);
    const sections = r.data["sections"] as Array<{ title: string; text: string }>;
    expect(sections[0]?.title).toBe("How to read this");
    const open = sections.find((s) => s.title === "Open items");
    expect(open?.text).toContain("overdue commitment");
    expect(open?.text).toContain(seed.scoping.id);
    expect(open?.text).toContain("due 2026-07-17");
    expect(sections.some((s) => s.title === "Open commitments and asks")).toBe(false);
  });

  it("shows today's queue with evidence and the brief headline", async () => {
    await store.kvSet("attention", "brief:2026-10-03", { headline: "Answer Marcus before anything else." });
    const r = await call("yrm_today", { date: "2026-10-03" });
    expect(r.data["headline"]).toBe("Answer Marcus before anything else.");
    const items = r.data["items"] as Array<{ key: string; evidence: { facts: FactJson[]; events: Array<{ title: string }> } }>;
    expect(items.map((i) => i.key)).toEqual(["unanswered:marcus", "silence:acme"]);
    expect(items[0]?.evidence.facts[0]?.provenance[0]?.event?.title).toBe("Re: Pilot scope");
    expect(items[0]?.evidence.events[0]?.title).toBe("Re: Pilot scope");
  });
});

describe("write tools", () => {
  let humanFactId = "";

  it("refuses to write without confirm and writes nothing", async () => {
    const r = await call("yrm_record_fact", {
      type: "attribute",
      predicate: "title",
      subjectEntityId: seed.marcus.id,
      statement: "Marcus Bell is COO.",
      value: { title: "COO" },
      eventId: seed.scoping.id,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("CONFIRMATION_REQUIRED");
    expect(r.text).toContain("confirm");
    const facts = await store.queryFacts({ entityId: seed.marcus.id, predicate: "title" });
    expect(facts.map((f) => f.id)).toEqual([seed.newTitle.id]);
  });

  it("records a human-origin fact with confirm", async () => {
    const r = await call("yrm_record_fact", {
      type: "attribute",
      predicate: "title",
      subjectEntityId: seed.marcus.id,
      statement: "Marcus Bell is COO.",
      value: { title: "COO" },
      eventId: seed.scoping.id,
      supersedes: seed.newTitle.id,
      confirm: true,
    });
    expect(r.isError).toBe(false);
    const fact = (r.data["recorded"] as FactJson);
    expect(fact.origin).toEqual({ kind: "human", by: "agent:mcp/test-agent", version: "mcp/1" });
    expect(fact.confidence).toBe(1);
    expect(fact.provenance[0]?.event?.title).toBe("Re: Pilot scope");
    humanFactId = fact.id;
  });

  it("does not let a model fact supersede the human one, and surfaces the StoreError as a tool error", async () => {
    const r = await call("test_model_fact", { supersedes: humanFactId, eventId: seed.scoping.id });
    expect(r.isError).toBe(true);
    expect((r.data["error"] as { code: string }).code).toBe("HUMAN_OVERRIDE_PROTECTED");

    await expect(
      store.recordFact({
        type: "attribute",
        subject: { entityId: seed.marcus.id },
        predicate: "title",
        value: {},
        statement: "x",
        validFrom: "2026-10-01T00:00:00.000Z",
        provenance: [{ eventId: seed.scoping.id }],
        confidence: 0.5,
        origin: { kind: "model", by: "extract" },
        supersedes: humanFactId,
      }),
    ).rejects.toBeInstanceOf(StoreError);

    // The server is still up and the human fact still stands.
    const now = await call("yrm_facts", { entityId: seed.marcus.id, predicate: "title" });
    expect((now.data["facts"] as FactJson[]).map((f) => f.id)).toEqual([humanFactId]);
  });

  it("requires an existing event to cite", async () => {
    const r = await call("yrm_record_fact", {
      type: "attribute",
      predicate: "timezone",
      subjectEntityId: seed.marcus.id,
      statement: "Marcus is in Pacific time.",
      value: "America/Los_Angeles",
      eventId: "mcp:not-an-event",
      confirm: true,
    });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("no event");
  });

  it("records a note and then a fact citing it", async () => {
    const note = await call("yrm_record_note", {
      title: "Call with Priya",
      text: "Priya says Marcus now reports to the CFO on the pilot budget.",
      about: [seed.marcus.id],
      occurredAt: "2026-10-02T17:00:00Z",
      confirm: true,
    });
    expect(note.isError).toBe(false);
    const eventId = String(note.data["eventId"]);
    const event = await store.getEvent(eventId);
    expect(event?.source).toBe("mcp");
    expect(event?.kind).toBe("note");
    expect(event?.participants[0]).toMatchObject({ role: "author", name: "agent:mcp/test-agent" });
    expect(event?.participants[1]).toMatchObject({ role: "mentioned", entityId: seed.marcus.id });

    const fact = await call("yrm_record_fact", {
      type: "relationship",
      predicate: "reports_to_on_budget",
      subjectEntityId: seed.marcus.id,
      statement: "Marcus needs CFO sign-off on the pilot budget.",
      value: { approver: "CFO" },
      eventId,
      confirm: true,
    });
    expect(fact.isError).toBe(false);
    const recorded = fact.data["recorded"] as FactJson;
    expect(recorded.provenance[0]).toMatchObject({ eventId, event: { title: "Call with Priya" } });
    expect(recorded.validFrom).toBe("2026-10-02T17:00:00.000Z");
  });

  it("confirms an entity", async () => {
    const r = await call("yrm_confirm_entity", { id: seed.marcus.id, confirm: true });
    expect((r.data["entity"] as { status: string }).status).toBe("confirmed");
  });

  it("dismisses a queue item so yrm_today hides it, and brings it back after `until`", async () => {
    const refused = await call("yrm_dismiss", { key: "silence:acme" });
    expect(refused.isError).toBe(true);

    await call("yrm_dismiss", { key: "silence:acme", confirm: true });
    const after = await call("yrm_today", { date: "2026-10-03" });
    expect((after.data["items"] as Array<{ key: string }>).map((i) => i.key)).toEqual(["unanswered:marcus"]);

    await call("yrm_dismiss", { key: "silence:acme", until: "2000-01-01", confirm: true });
    const back = await call("yrm_today", { date: "2026-10-03" });
    expect((back.data["items"] as Array<{ key: string }>).map((i) => i.key)).toContain("silence:acme");
    expect(await store.kvGet("attention", "dismiss:silence:acme")).toBeNull();
  });
});

describe("resources", () => {
  it("lists and reads yrm:// resources", async () => {
    const { resources } = await client.listResources();
    const uris = resources.map((r) => r.uri);
    expect(uris).toContain("yrm://today");
    expect(uris).toContain("yrm://story");
    expect(uris).toContain(`yrm://entity/${seed.marcus.id}`);

    const { resourceTemplates } = await client.listResourceTemplates();
    expect(resourceTemplates.map((t) => t.uriTemplate)).toContain("yrm://entity/{id}");

    const entity = await client.readResource({ uri: `yrm://entity/${seed.marcus.id}` });
    const body = JSON.parse(String((entity.contents[0] as { text: string }).text)) as { entity: { name: string } };
    expect(body.entity.name).toBe("Marcus Bell");

    const story = await client.readResource({ uri: "yrm://story" });
    const md = String((story.contents[0] as { text: string }).text);
    expect(md).toContain("validAt");
    expect(md).toContain("provenance");

    const today = await client.readResource({ uri: "yrm://today" });
    expect(JSON.parse(String((today.contents[0] as { text: string }).text))).toHaveProperty("items");
  });
});

describe("serve command", () => {
  it("rejects --http as planned with exit code 2", async () => {
    const serve = host.registry.commands.get("serve") as Command;
    const err: string[] = [];
    const ctx: CommandContext = {
      tenantId: "local",
      args: [],
      flags: { http: "8080" },
      store,
      models: host.models,
      stdout: () => {
        throw new Error("serve must not write to stdout");
      },
      stderr: (line) => err.push(line),
      log: silentLogger,
    };
    expect(await serve.run(ctx)).toBe(2);
    expect(err.join("\n")).toContain("planned");
  });
});
