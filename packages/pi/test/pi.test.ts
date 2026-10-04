import { afterEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CONFIG_FILES as CORE_CONFIG_FILES,
  createHost,
  estimateTokens,
  silentLogger,
  SqliteStore,
  type Entity,
  type Host,
  type YrmConfig,
} from "@yrm/core";
import { createMcpExtension, manifest as mcpManifest } from "@yrm/ext-mcp";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import { makeEvent } from "../../core/src/testing/fixtures.ts";
import { AUTO_CONTEXT_SECTION, matchEntities, renderAutoContext } from "../src/auto-context.ts";
import { splitArgs } from "../src/commands.ts";
import { PI_PRINCIPAL } from "../src/host.ts";
import { CONFIG_FILES, createYrmPiExtension, MCP_SERVER_NAME, type YrmPiMode } from "../src/index.ts";
import { normalizeSubject } from "../src/tools.ts";
import type {
  PiBeforeAgentStartEvent,
  PiBeforeAgentStartResult,
  PiCommandOptions,
  PiContext,
  PiCustomMessage,
  PiExtensionAPI,
  PiMcpServerConfig,
  PiToolDefinition,
  PiToolResult,
} from "../src/pi-types.ts";

// ---- fakes ------------------------------------------------------------------------

type Handler = (event: never, ctx: PiContext) => unknown;

class FakePi implements PiExtensionAPI {
  tools = new Map<string, PiToolDefinition>();
  commands = new Map<string, PiCommandOptions>();
  handlers = new Map<string, Handler[]>();
  messages: PiCustomMessage[] = [];
  mcp = new Map<string, PiMcpServerConfig>();
  registerMcpServer?: (name: string, config: PiMcpServerConfig) => void;

  constructor(opts: { mcp?: boolean } = {}) {
    if (opts.mcp !== false) this.registerMcpServer = (name, config) => void this.mcp.set(name, config);
  }

  on(event: string, handler: Handler): () => void {
    const list = this.handlers.get(event) ?? [];
    list.push(handler);
    this.handlers.set(event, list);
    return () => {};
  }
  registerTool(tool: PiToolDefinition): void {
    this.tools.set(tool.name, tool);
  }
  registerCommand(name: string, options: PiCommandOptions): void {
    this.commands.set(name, options);
  }
  sendMessage(message: PiCustomMessage): void {
    this.messages.push(message);
  }

  async emit(event: string, payload: unknown, ctx: PiContext = fakeCtx()): Promise<unknown[]> {
    const out: unknown[] = [];
    for (const h of this.handlers.get(event) ?? []) out.push(await h(payload as never, ctx));
    return out;
  }

  async call(name: string, params: unknown, ctx: PiContext = fakeCtx()): Promise<PiToolResult> {
    const tool = this.tools.get(name);
    if (!tool) throw new Error(`no tool ${name}`);
    return tool.execute("call-1", params, undefined, undefined, ctx);
  }
}

function fakeCtx(opts: { hasUI?: boolean; confirm?: boolean } = {}): PiContext & { notes: string[]; asked: string[] } {
  const notes: string[] = [];
  const asked: string[] = [];
  return {
    cwd: "/tmp",
    hasUI: opts.hasUI ?? false,
    notes,
    asked,
    ui: {
      notify: (m) => void notes.push(m),
      confirm: async (title, message) => {
        asked.push(`${title}\n${message}`);
        return opts.confirm ?? true;
      },
    },
  };
}

// ---- seeded host --------------------------------------------------------------------

const RAW_SENTENCE = "PRIVATE-BODY: the raw email body must never be injected";

interface Seeded {
  host: Host;
  store: SqliteStore;
  marcus: Entity;
  acme: Entity;
  priya: Entity;
  eventId: string;
  threadKey: string;
}

async function seededHost(settings: YrmConfig["settings"] = {}): Promise<Seeded> {
  const config: YrmConfig = {
    tenant: { id: "local", selfAddresses: ["me@example.test"], timezone: "UTC" },
    storage: { driver: "sqlite", path: ":memory:" },
    models: { routes: {} },
    settings,
  };
  const store = new SqliteStore({ path: ":memory:" });
  await store.migrate();
  const host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
  await host.use(createMcpExtension({ host }), mcpManifest);

  const acme = await store.createEntity({
    kind: "organization",
    name: "Acme Robotics",
    identifiers: [{ type: "domain", value: "acme-robotics.example", confidence: 1, source: "mail" }],
    status: "confirmed",
  });
  const marcus = await store.createEntity({
    kind: "person",
    name: "Marcus Lee",
    identifiers: [{ type: "email", value: "marcus@acme-robotics.example", confidence: 1, source: "mail" }],
    status: "confirmed",
    summary: { parentId: acme.id },
  });
  const priya = await store.createEntity({
    kind: "person",
    name: "Priya Shah",
    identifiers: [{ type: "email", value: "priya@northwind.example", confidence: 1, source: "mail" }],
    status: "proposed",
  });
  const threadKey = "thread-pricing";
  const { event } = await store.appendEvent({
    ...makeEvent({ content: { title: "Pricing for Q4", text: RAW_SENTENCE } }),
    tenantId: "local",
    threadKey,
    participants: [
      { role: "from", address: "marcus@acme-robotics.example", name: "Marcus Lee", entityId: marcus.id },
      { role: "to", address: "me@example.test", name: "Me", self: true },
    ],
  });
  const fact = (statement: string, predicate: string, type = "attribute") =>
    store.recordFact({
      tenantId: "local",
      type,
      predicate,
      subject: { entityId: marcus.id, name: marcus.name },
      value: { what: statement },
      statement,
      validFrom: "2026-09-01T00:00:00.000Z",
      provenance: [{ eventId: event.id, quote: "pricing" }],
      confidence: 0.9,
      origin: { kind: "model", by: "extract", version: "1" },
    });
  await fact("Marcus Lee is Head of Procurement at Acme Robotics.", "title");
  await fact("Marcus asked for Q4 pricing by Friday.", "asked_for", "ask");
  return { host, store, marcus, acme, priya, eventId: event.id, threadKey };
}

const hosts: Host[] = [];
afterEach(async () => {
  for (const h of hosts.splice(0)) await h.close();
});

async function loadInProcess(settings: YrmConfig["settings"] = {}): Promise<{ pi: FakePi; s: Seeded; mode: YrmPiMode | null }> {
  const s = await seededHost(settings);
  hosts.push(s.host);
  const pi = new FakePi();
  let mode: YrmPiMode | null = null;
  await createYrmPiExtension({ bun: true, boot: async () => s.host, onMode: (m) => (mode = m) })(pi);
  return { pi, s, mode };
}

function text(r: PiToolResult): string {
  return r.content.map((c) => c.text).join("\n");
}

function promptEvent(prompt: string): PiBeforeAgentStartEvent & { systemPromptOptions: { sections: Record<string, string> } } {
  return { type: "before_agent_start", prompt, systemPromptOptions: { sections: {} } };
}

// ---- tests ----------------------------------------------------------------------------

describe("in-process mode (Bun)", () => {
  it("registers the five tools with their exposure levels, the /yrm command and the hooks", async () => {
    const { pi, mode } = await loadInProcess();
    expect(mode).toBe("in-process");
    const exposure = Object.fromEntries([...pi.tools.values()].map((t) => [t.name, t.exposure]));
    expect(exposure).toEqual({
      yrm_context: "direct",
      yrm_facts: "codemode",
      yrm_today: "direct",
      yrm_search_entities: "deferred",
      yrm_record_fact: "direct",
    });
    for (const t of pi.tools.values()) {
      expect(t.label.length).toBeGreaterThan(0);
      expect((t.parameters as { type?: string }).type).toBe("object");
    }
    expect(pi.tools.get("yrm_facts")!.outputSchema).toBeDefined();
    expect(pi.tools.get("yrm_record_fact")!.annotations?.readOnlyHint).toBe(false);
    expect([...pi.commands.keys()]).toEqual(["yrm"]);
    expect(pi.handlers.has("before_agent_start")).toBe(true);
    expect(pi.handlers.has("session_shutdown")).toBe(true);
    expect(pi.mcp.size).toBe(0);
  });

  it("yrm_context resolves names, addresses and thread subjects to a bundle", async () => {
    const { pi, s } = await loadInProcess();
    const byName = JSON.parse(text(await pi.call("yrm_context", { entities: ["marcus@acme-robotics.example", "Nobody Here"] })));
    expect(byName.resolved[0].entities.map((e: { id: string }) => e.id)).toEqual([s.marcus.id]);
    expect(byName.unresolved).toEqual(["Nobody Here"]);
    expect(JSON.stringify(byName.sections)).toContain("Head of Procurement");

    const byThread = JSON.parse(text(await pi.call("yrm_context", { thread: "Re: Pricing for Q4" })));
    expect(byThread.threadKey).toBe(s.threadKey);
    expect(JSON.stringify(byThread.sections)).toContain("Marcus Lee");

    await expect(pi.call("yrm_context", { entities: ["Nobody Here"] })).rejects.toThrow("nothing in YRM matches");
  });

  it("yrm_facts passes validAt and asOf through and returns structuredContent", async () => {
    const { pi, s } = await loadInProcess();
    const now = await pi.call("yrm_facts", { entity: "Marcus Lee" });
    const out = now.structuredContent as { entity: { id: string }; validAt: string; asOf: string; count: number };
    expect(out.entity.id).toBe(s.marcus.id);
    expect(out).toMatchObject({ validAt: "now", asOf: "now", count: 2 });

    const before = (await pi.call("yrm_facts", { entity: "Marcus Lee", validAt: "2026-08-01T00:00:00Z" })).structuredContent;
    expect(before).toMatchObject({ validAt: "2026-08-01T00:00:00.000Z", count: 0 });
    const known = (await pi.call("yrm_facts", { entity: "Marcus Lee", asOf: "2020-01-01T00:00:00Z" })).structuredContent;
    expect(known).toMatchObject({ asOf: "2020-01-01T00:00:00.000Z", count: 0 });

    await expect(pi.call("yrm_facts", { entity: "Nobody" })).rejects.toThrow("nothing in YRM matches");
  });

  it("yrm_today and yrm_search_entities front YRM's own tools", async () => {
    const { pi, s } = await loadInProcess();
    const today = JSON.parse(text(await pi.call("yrm_today", { date: "2026-10-04" })));
    expect(today).toMatchObject({ date: "2026-10-04", count: 0 });
    const found = JSON.parse(text(await pi.call("yrm_search_entities", { query: "acme-robotics.example" })));
    expect(found.entities.map((e: { id: string }) => e.id)).toContain(s.acme.id);
  });

  describe("yrm_record_fact", () => {
    const base = { type: "role", predicate: "approver", subject: "Marcus Lee", statement: "Marcus needs CFO sign-off.", value: { who: "CFO" } };

    it("refuses without an event or a note, before asking anyone", async () => {
      const { pi } = await loadInProcess();
      const ctx = fakeCtx({ hasUI: true });
      await expect(pi.call("yrm_record_fact", base, ctx)).rejects.toThrow("every fact must rest on an event");
      expect(ctx.asked).toEqual([]);
    });

    it("records a note first, then a human-origin fact citing it, as agent:pi", async () => {
      const { pi, s } = await loadInProcess();
      const ctx = fakeCtx({ hasUI: true, confirm: true });
      const out = JSON.parse(text(await pi.call("yrm_record_fact", { ...base, note: { title: "Call with Priya", text: "Marcus needs CFO sign-off." } }, ctx)));
      expect(ctx.asked[0]).toContain("Marcus needs CFO sign-off.");
      expect(out.recorded.provenance[0].eventId).toBe(out.note.eventId);
      expect(out.recorded.origin).toMatchObject({ kind: "human", by: PI_PRINCIPAL });
      expect(out.recorded.confidence).toBe(1);
      const note = await s.store.getEvent(out.note.eventId);
      expect(note?.kind).toBe("note");
    });

    it("cites an existing event; writes nothing when the user declines or no UI and no confirm", async () => {
      const { pi, s } = await loadInProcess();
      const facts = () => s.store.queryFacts({ tenantId: "local", entityId: s.marcus.id, predicate: "approver" });
      await expect(pi.call("yrm_record_fact", { ...base, eventId: s.eventId }, fakeCtx({ hasUI: true, confirm: false }))).rejects.toThrow("declined");
      await expect(pi.call("yrm_record_fact", { ...base, eventId: s.eventId }, fakeCtx({ hasUI: false }))).rejects.toThrow('"confirm": true');
      expect(await facts()).toHaveLength(0);
      await pi.call("yrm_record_fact", { ...base, eventId: s.eventId, confirm: true }, fakeCtx({ hasUI: false }));
      expect(await facts()).toHaveLength(1);
    });
  });

  describe("automatic context", () => {
    it("injects a section only when the prompt names a known entity", async () => {
      const { pi } = await loadInProcess();
      const quiet = promptEvent("refactor the date parser in src/util.ts");
      expect(await pi.emit("before_agent_start", quiet)).toEqual([undefined]);
      expect(quiet.systemPromptOptions.sections[AUTO_CONTEXT_SECTION]).toBeUndefined();

      const byEmail = promptEvent("draft a reply to marcus@acme-robotics.example about the pricing");
      await pi.emit("before_agent_start", byEmail);
      const section = byEmail.systemPromptOptions.sections[AUTO_CONTEXT_SECTION]!;
      expect(section).toContain("Head of Procurement");
      expect(section).toContain("Marcus asked for Q4 pricing by Friday.");
      expect(section).not.toContain("PRIVATE-BODY");
    });

    it("matches full names and unique capitalized first names, not lowercase words", async () => {
      const { s } = await loadInProcess();
      expect((await matchEntities(s.host, "What does Marcus want?")).map((e) => e.id)).toEqual([s.marcus.id]);
      expect((await matchEntities(s.host, "prep for acme robotics")).map((e) => e.id)).toEqual([s.acme.id]);
      expect(await matchEntities(s.host, "the marcus-config file")).toEqual([]);
    });

    it("drops a stale section when the next prompt names nobody", async () => {
      const { pi } = await loadInProcess();
      const ev = promptEvent("unrelated prompt");
      ev.systemPromptOptions.sections[AUTO_CONTEXT_SECTION] = "stale";
      await pi.emit("before_agent_start", ev);
      expect(ev.systemPromptOptions.sections[AUTO_CONTEXT_SECTION]).toBeUndefined();
    });

    it("respects the token budget", async () => {
      const { s } = await loadInProcess();
      for (let i = 0; i < 60; i++) {
        await s.store.recordFact({
          tenantId: "local",
          type: "signal",
          predicate: `signal_${i}`,
          subject: { entityId: s.marcus.id, name: s.marcus.name },
          value: { i },
          statement: `Marcus mentioned budget signal number ${i} with a fairly long explanatory sentence attached.`,
          validFrom: "2026-09-02T00:00:00.000Z",
          provenance: [{ eventId: s.eventId }],
          confidence: 0.7,
          origin: { kind: "model", by: "extract", version: "1" },
        });
      }
      const out = (await renderAutoContext(s.host, [s.marcus.id], 300))!;
      expect(estimateTokens(out)).toBeLessThanOrEqual(300);
      expect(out).toContain("more facts; call yrm_context");
      const full = (await renderAutoContext(s.host, [s.marcus.id]))!;
      expect(estimateTokens(full)).toBeLessThanOrEqual(1200);
    });

    it("is off when settings.pi.autoContext is false", async () => {
      const { pi } = await loadInProcess({ pi: { autoContext: false } });
      const ev = promptEvent("email marcus@acme-robotics.example");
      await pi.emit("before_agent_start", ev);
      expect(ev.systemPromptOptions.sections[AUTO_CONTEXT_SECTION]).toBeUndefined();
    });

    it("falls back to a hidden message when pi passes no prompt sections", async () => {
      const { pi } = await loadInProcess();
      const [res] = (await pi.emit("before_agent_start", { type: "before_agent_start", prompt: "ping Marcus Lee" })) as PiBeforeAgentStartResult[];
      expect(res?.message).toMatchObject({ customType: "yrm-context", display: false });
    });
  });

  describe("/yrm", () => {
    it("renders who, facts (with --at and --as-of) and today through ctx.ui or a message", async () => {
      const { pi, s } = await loadInProcess();
      const cmd = pi.commands.get("yrm")!;
      const ui = fakeCtx({ hasUI: true });
      await cmd.handler("who acme-robotics.example", ui);
      expect(ui.notes[0]).toContain("Acme Robotics");

      await cmd.handler('facts "Marcus Lee" --at 2026-08-01', ui);
      expect(ui.notes[1]).toContain("(no facts)");
      await cmd.handler("facts Marcus Lee", ui);
      expect(ui.notes[2]).toContain("Head of Procurement");

      await cmd.handler("today 2026-10-04", fakeCtx({ hasUI: false }));
      expect(pi.messages[0]).toMatchObject({ customType: "yrm", display: true });
      expect(pi.messages[0]!.content).toContain("Today, 2026-10-04");

      await cmd.handler("", ui);
      expect(ui.notes[3]).toContain("/yrm facts");
      expect(s.host).toBeDefined();
    });

    it("splits quoted arguments", () => {
      expect(splitArgs(`facts "Acme Robotics" --as-of 2026-09-01`)).toEqual(["facts", "Acme Robotics", "--as-of", "2026-09-01"]);
    });
  });

  it("closes the host when the session shuts down", async () => {
    const s = await seededHost();
    let closed = 0;
    const host = new Proxy(s.host, {
      get: (t, k) => (k === "close" ? async () => void closed++ : Reflect.get(t, k)),
    });
    const pi = new FakePi();
    await createYrmPiExtension({ bun: true, boot: async () => host })(pi);
    await pi.call("yrm_today", { date: "2026-10-04" });
    await pi.emit("session_shutdown", {});
    expect(closed).toBe(1);
    await s.host.close();
  });
});

describe("outside a YRM project, and on Node", () => {
  let dir: string;
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  it("registers only /yrm with init guidance when there is no config", async () => {
    dir = mkdtempSync(join(tmpdir(), "yrm-pi-"));
    const pi = new FakePi();
    const modes: YrmPiMode[] = [];
    await createYrmPiExtension({ cwd: dir, bun: true, onMode: (m) => void modes.push(m) })(pi);
    expect(modes[0]).toBe("init");
    expect(pi.tools.size).toBe(0);
    expect(pi.handlers.size).toBe(0);
    const ctx = fakeCtx({ hasUI: true });
    await pi.commands.get("yrm")!.handler("today", ctx);
    expect(ctx.notes[0]).toContain("yrm init");
  });

  it("registers YRM's MCP server, and no in-process tools, when pi is not on Bun", async () => {
    dir = mkdtempSync(join(tmpdir(), "yrm-pi-"));
    writeFileSync(join(dir, "yrm.config.ts"), "export default {}\n");
    const nested = join(dir, "a", "b");
    mkdirSync(nested, { recursive: true });
    const pi = new FakePi();
    const modes: YrmPiMode[] = [];
    await createYrmPiExtension({ cwd: nested, bun: false, onMode: (m) => void modes.push(m) })(pi);
    expect(modes[0]).toBe("mcp");
    expect(pi.tools.size).toBe(0);
    expect(pi.handlers.has("before_agent_start")).toBe(false);
    const server = pi.mcp.get(MCP_SERVER_NAME)!;
    expect(server.command).toBe("bun");
    expect(server.args?.[0]).toBe("run");
    expect(server.args?.[1]).toMatch(/packages\/cli\/src\/main\.ts$/);
    expect(server.args?.[2]).toBe("serve");
    expect(server.cwd).toBe(dir);
    expect(server.toolExposure).toMatchObject({ yrm_facts: "codemode", yrm_context: "direct", yrm_today: "direct" });
  });

  it("prints .pi/mcp.json instructions when pi cannot register MCP servers", async () => {
    dir = mkdtempSync(join(tmpdir(), "yrm-pi-"));
    writeFileSync(join(dir, "yrm.config.ts"), "export default {}\n");
    const pi = new FakePi({ mcp: false });
    await createYrmPiExtension({ cwd: dir, bun: false, cliMain: null })(pi);
    expect(pi.tools.size).toBe(0);
    await pi.commands.get("yrm")!.handler("", fakeCtx({ hasUI: false }));
    const snippet = pi.messages[0]!.content;
    expect(snippet).toContain(".pi/mcp.json");
    expect(snippet).toContain('"command": "yrm"');
    const warn = fakeCtx({ hasUI: true });
    await pi.emit("session_start", {}, warn);
    expect(warn.notes[0]).toContain(".pi/mcp.json");
  });

  it("keeps the Node-safe config file list in step with core", () => {
    expect([...CONFIG_FILES]).toEqual([...CORE_CONFIG_FILES]);
  });
});

describe("helpers", () => {
  it("normalizes reply and forward prefixes", () => {
    expect(normalizeSubject("Re: Fwd: RE: Pricing for Q4")).toBe("pricing for q4");
  });
});
