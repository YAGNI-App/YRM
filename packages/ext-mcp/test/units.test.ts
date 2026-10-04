import { describe, expect, it } from "bun:test";
import {
  createHost,
  estimateTokens,
  silentLogger,
  SqliteStore,
  type ContextBundle,
  type Tool,
  type ToolContext,
  type YrmConfig,
} from "@yrm/core";
import { z } from "zod";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import mcpExtension, {
  buildContextAdditions,
  HOST_READY_TOPIC,
  jsonSchemaToZod,
  manifest,
  exposedTools,
} from "../src/index.ts";

const config: YrmConfig = {
  tenant: { id: "local", selfAddresses: [], timezone: "UTC" },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} },
};

async function freshHost() {
  const store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  const host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  return { host, store };
}

function ctxFor(store: SqliteStore, principal?: string): ToolContext {
  const ctx: ToolContext = { tenantId: "local", store, models: new FakeRouter(), log: silentLogger };
  if (principal !== undefined) ctx.principal = principal;
  return ctx;
}

describe("jsonSchemaToZod", () => {
  const schema = jsonSchemaToZod({
    type: "object",
    properties: {
      query: { type: "string", description: "what to find" },
      limit: { type: "integer" },
      ok: { type: "boolean" },
      ids: { type: "array", items: { type: "string" } },
      status: { type: "string", enum: ["open", "closed"] },
      anything: { description: "free-form" },
      maybe: { type: ["string", "null"] },
    },
    required: ["query"],
  });

  it("accepts valid input and keeps optional fields optional", () => {
    expect(schema.parse({ query: "x" })).toEqual({ query: "x" });
    const full = { query: "x", limit: 3, ok: true, ids: ["a"], status: "open", anything: { a: 1 }, maybe: null };
    expect(schema.parse(full)).toEqual(full);
  });

  it("rejects wrong types, missing required fields and bad enums", () => {
    expect(schema.safeParse({}).success).toBe(false);
    expect(schema.safeParse({ query: 1 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", limit: 1.5 }).success).toBe(false);
    expect(schema.safeParse({ query: "x", status: "maybe" }).success).toBe(false);
  });

  it("keeps descriptions for the JSON Schema clients see", () => {
    const json = z.toJSONSchema(schema) as { properties: Record<string, { description?: string }> };
    expect(json.properties["query"]?.description).toBe("what to find");
  });

  it("falls back to z.any() for unsupported constructs", () => {
    const s = jsonSchemaToZod({ oneOf: [{ type: "string" }, { type: "number" }] });
    expect(s.safeParse({ whatever: true }).success).toBe(true);
  });
});

describe("exposure", () => {
  it("keeps codemode tools out of MCP", () => {
    const t = (name: string, exposure?: Tool["exposure"]): Tool => ({
      name,
      description: name,
      inputSchema: { type: "object" },
      readOnly: true,
      ...(exposure ? { exposure } : {}),
      run: async () => null,
    });
    expect(exposedTools([t("a"), t("b", "deferred"), t("c", "codemode")]).map((x) => x.name)).toEqual(["a", "b"]);
  });
});

describe("host binding", () => {
  it("store-only tools work without a host; host-backed tools explain how to bind it", async () => {
    const { host, store } = await freshHost();
    await host.use(mcpExtension, manifest);
    const search = host.registry.tools.get("yrm_search_entities")!;
    expect(await search.run({ query: "nobody" }, ctxFor(store))).toEqual({ count: 0, entities: [] });
    const today = host.registry.tools.get("yrm_today")!;
    await expect(today.run({}, ctxFor(store))).rejects.toThrow(HOST_READY_TOPIC);

    host.events.emit(HOST_READY_TOPIC, host);
    const out = (await today.run({ date: "2026-10-03" }, ctxFor(store))) as { items: unknown[] };
    expect(out.items).toEqual([]);
    await host.close();
  });

  it("honours unattendedWrites from settings", async () => {
    const store = new SqliteStore({ path: ":memory:" });
    await store.migrate();
    const host = createHost(
      { ...config, settings: { mcp: { unattendedWrites: true } } },
      { store, models: new FakeRouter(), log: silentLogger },
    );
    await host.use(mcpExtension, manifest);
    const e = await store.createEntity({ kind: "person", name: "Tom", identifiers: [], status: "proposed" });
    const reject = host.registry.tools.get("yrm_reject_entity")!;
    const out = (await reject.run({ id: e.id }, ctxFor(store, "user:jack"))) as { entity: { status: string }; by: string };
    expect(out.entity.status).toBe("rejected");
    expect(out.by).toBe("user:jack");
    await host.close();
  });
});

describe("merge", () => {
  it("merges two entities and follows the merge on reads", async () => {
    const { host, store } = await freshHost();
    await host.use(mcpExtension, manifest);
    const work = await store.createEntity({
      kind: "person",
      name: "Tom Fischer",
      identifiers: [{ type: "email", value: "tom.fischer@acme-robotics.example", confidence: 1, source: "resolve" }],
      status: "confirmed",
    });
    const personal = await store.createEntity({
      kind: "person",
      name: "Tom F",
      identifiers: [{ type: "email", value: "tfischer@mailhub.example", confidence: 1, source: "resolve" }],
      status: "proposed",
    });
    const merge = host.registry.tools.get("yrm_merge_entities")!;
    await expect(merge.run({ from: personal.id, into: work.id }, ctxFor(store))).rejects.toThrow("confirm");
    await merge.run({ from: personal.id, into: work.id, confirm: true }, ctxFor(store));
    const get = host.registry.tools.get("yrm_get_entity")!;
    const view = (await get.run({ id: personal.id }, ctxFor(store))) as {
      entity: { id: string; identifiers: Array<{ value: string }> };
      mergedFrom: string;
    };
    expect(view.entity.id).toBe(work.id);
    expect(view.mergedFrom).toBe(personal.id);
    expect(view.entity.identifiers.map((i) => i.value)).toContain("tfischer@mailhub.example");
    await host.close();
  });
});

describe("context:build additions", () => {
  it("stays under 300 tokens however many open items there are", async () => {
    const { host, store } = await freshHost();
    const marcus = await store.createEntity({ kind: "person", name: "Marcus", identifiers: [], status: "confirmed" });
    const { event } = await store.appendEvent({
      source: "mail",
      kind: "message",
      externalId: "x",
      occurredAt: "2026-09-02T00:00:00.000Z",
      participants: [],
      content: { text: "..." },
      meta: {},
    });
    for (let i = 0; i < 40; i++) {
      await store.recordFact({
        type: "ask",
        subject: { entityId: marcus.id },
        predicate: "asked",
        value: { what: `question ${i}`, answered: false },
        statement: `Marcus asked question number ${i} about exit terms and the CFO's approval process.`,
        validFrom: "2026-09-02T00:00:00.000Z",
        provenance: [{ eventId: event.id }],
        confidence: 0.9,
        origin: { kind: "model", by: "extract" },
      });
    }
    const draft: ContextBundle = { sections: [{ title: "Marcus (person)", text: "Name: Marcus" }], tokens: 6 };
    const out = await buildContextAdditions(
      { tenantId: "local", store, models: new FakeRouter(), log: silentLogger },
      { entityIds: [marcus.id], budget: 5000 },
      draft,
    );
    const added = out!.sections.filter((s) => s.title !== "Marcus (person)");
    const tokens = added.reduce((n, s) => n + estimateTokens(s.title) + estimateTokens(s.text), 0);
    expect(tokens).toBeLessThanOrEqual(300);
    const open = added.find((s) => s.title === "Open items")!;
    expect(open.text).toContain("more; call yrm_open_items");
    expect(open.text).toContain(`event ${event.id}`);
    await host.close();
  });
});
