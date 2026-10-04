import { afterEach, describe, expect, it } from "bun:test";
import { RouterError, silentLogger, StoreError, type Host, type ModelRouter, type ViewDefinition } from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import {
  BUILTIN_RULES,
  MODEL_CONFIDENCE_CAP,
  readSettings,
  setByHuman,
  validateDefinition,
  ViewDefinitionError,
  ViewEngine,
  findView,
  type ViewValueOut,
} from "../src/index.ts";
import { bootHost, ROUTES, viewFacts } from "./helpers.ts";

const RULES = new Set(BUILTIN_RULES.map((b) => b.def.name));

const ECONOMIC_BUYER = {
  name: "economic_buyer",
  appliesTo: "organization",
  valueType: "entity",
  populatedBy: "model",
  description: "The person at this organization who controls the budget for our deal; usually the one who approves pricing or signs.",
};
const DEAL_STAGE = {
  name: "deal_stage",
  appliesTo: "organization",
  valueType: "enum",
  enumValues: ["discovery", "evaluation", "security_review", "pilot", "closed_won", "closed_lost", "stalled"],
  populatedBy: "model",
  description: "Where our commercial conversation with this organization stands.",
};
const SETTINGS = { definitions: [ECONOMIC_BUYER, DEAL_STAGE] };

let host: Host | undefined;
afterEach(async () => {
  await host?.close();
  host = undefined;
});

function engineFor(h: Host, models: ModelRouter, settings: Record<string, unknown> = SETTINGS): ViewEngine {
  return new ViewEngine({
    store: h.store,
    models,
    tenantId: "local",
    tenant: h.config.tenant,
    settings: readSettings(settings),
    rules: new Map(BUILTIN_RULES.map((b) => [b.def.name, b.rule])),
    log: silentLogger,
  });
}

async function def(h: Host, name: string): Promise<ViewDefinition> {
  const d = await findView(h.store, "local", name);
  if (!d) throw new Error(`view ${name} not defined`);
  return d;
}

async function runView(h: Host, args: string[], flags: Record<string, string | boolean> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const code = await h.registry.commands.get("view")!.run({
    tenantId: "local",
    args,
    flags,
    store: h.store,
    models: h.models,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    log: silentLogger,
  });
  return { code: code ?? 0, stdout: out.join("\n"), stderr: err.join("\n") };
}

describe("definitions", () => {
  it("accepts a good definition and normalizes it", () => {
    const d = validateDefinition({ ...DEAL_STAGE, description: "  Where   it stands.  " }, RULES);
    expect(d.description).toBe("Where it stands.");
    expect(d.enumValues).toHaveLength(7);
  });

  it("rejects bad names, types, enums, kinds and unknown rules", () => {
    const bad = (over: Record<string, unknown>) => () => validateDefinition({ ...ECONOMIC_BUYER, ...over }, RULES);
    expect(bad({ name: "Economic Buyer" })).toThrow(ViewDefinitionError);
    expect(bad({ valueType: "currency" })).toThrow(/valueType must be one of/);
    expect(bad({ valueType: "enum" })).toThrow(/at least two values/);
    expect(bad({ valueType: "enum", enumValues: ["only"] })).toThrow(/at least two values/);
    expect(bad({ enumValues: ["a", "b"] })).toThrow(/only apply to --type enum/);
    expect(bad({ appliesTo: "" })).toThrow(/needs appliesTo/);
    expect(bad({ description: "short" })).toThrow(/needs a description/);
    expect(bad({ populatedBy: "rule" })).toThrow(/no extension registers a rule/);
    expect(bad({ populatedBy: "magic" })).toThrow(/populatedBy/);
  });

  it("applies built-in and config definitions at host start, idempotently", async () => {
    ({ host } = await bootHost(new FakeRouter([], ROUTES), SETTINGS));
    const names = (await host.store.listViews("local")).map((v) => v.name);
    expect(names).toEqual(["deal_stage", "economic_buyer", "last_contact", "open_items"]);
    await host.stop();
    await host.start();
    expect((await host.store.listViews("local")).map((v) => v.name)).toEqual(names);
  });

  it("refuses duplicates without --force and keeps a dropped view dropped across restarts", async () => {
    ({ host } = await bootHost(new FakeRouter([], ROUTES), SETTINGS));
    const dup = await runView(host, ["define", "deal_stage", "where", "it", "stands"], { for: "organization", type: "string" });
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("already exists");
    const forced = await runView(host, ["define", "deal_stage", "where the deal stands now"], { for: "organization", type: "string", force: true });
    expect(forced.code).toBe(0);
    expect((await def(host, "deal_stage")).valueType).toBe("string");

    expect((await runView(host, ["drop", "last_contact"])).code).toBe(0);
    await host.stop();
    await host.start();
    expect(await findView(host.store, "local", "last_contact")).toBeUndefined();
    expect((await runView(host, ["list"])).stdout).not.toContain("last_contact");
  });
});

describe("rule views", () => {
  it("computes last_contact and open_items from seeded facts and events", async () => {
    let s;
    ({ host, s } = await bootHost(new FakeRouter([], ROUTES)));
    const engine = engineFor(host, host.models);
    const last = await engine.compute(await def(host, "last_contact"), s.acme);
    expect(last.state).toBe("recorded");
    expect(last.value).toBe("2026-09-22");
    expect(last.fact?.provenance).toEqual([{ eventId: s.security.id }]);
    expect(last.fact?.origin).toEqual({ kind: "rule", by: "views", version: "1" });

    const acmeOpen = await engine.compute(await def(host, "open_items"), s.acme);
    expect(acmeOpen.value).toBe(2);
    const marcusOpen = await engine.compute(await def(host, "open_items"), s.marcus);
    expect(marcusOpen.value).toBe(1);
    expect(marcusOpen.fact?.provenance.map((p) => p.eventId)).toEqual([s.pricing.id]);

    // Unchanged values are not recorded again.
    const again = await engine.compute(await def(host, "last_contact"), s.acme);
    expect(again.state).toBe("unchanged");
    expect(await viewFacts(host.store, s.acme.id, "last_contact", true)).toHaveLength(1);
  });

  it("skips the tenant's own organization", async () => {
    let s;
    ({ host, s } = await bootHost(new FakeRouter([], ROUTES)));
    const engine = engineFor(host, host.models);
    expect((await engine.compute(await def(host, "last_contact"), s.yagni)).state).toBe("skipped");
    expect((await engine.targets(await def(host, "last_contact"))).map((e) => e.name)).not.toContain("YAGNI");
  });
});

describe("model views", () => {
  it("records an entity view by id with capped confidence, provenance and a located quote", async () => {
    let s;
    const router = new FakeRouter([], ROUTES);
    ({ host, s } = await bootHost(router, SETTINGS));
    router.push({ json: { value: s.marcus.id, confidence: 0.97, evidence: [s.pricing.id], quote: "I approve the pricing" }, model: "fake-small" });
    const o = await engineFor(host, router).compute(await def(host, "economic_buyer"), s.acme);
    expect(o.state).toBe("recorded");
    expect(router.calls[0]?.tier).toBe("extract");
    const prompt = router.calls[0]!.req.messages[0]!.content;
    expect(prompt).toContain(`- [${s.role.id}]`);
    expect(prompt).toContain(`${s.marcus.id} | Marcus Bell`);
    expect(prompt).toContain("I approve the pricing on our side.");
    expect(router.calls[0]!.req.schema).toBeDefined();

    const f = o.fact!;
    expect(f.type).toBe("attribute");
    expect(f.predicate).toBe("view.economic_buyer");
    expect(f.value).toEqual({ entityId: s.marcus.id, name: "Marcus Bell" });
    expect(f.object?.entityId).toBe(s.marcus.id);
    expect(f.confidence).toBe(MODEL_CONFIDENCE_CAP);
    expect(f.origin).toEqual({ kind: "model", by: "views", version: "1", model: "fake-small" });
    expect(f.provenance).toEqual([{ eventId: s.pricing.id, quote: "I approve the pricing", span: { start: 0, end: 21 } }]);
    expect(f.validFrom).toBe(s.pricing.occurredAt);
  });

  it("resolves an entity named instead of identified, and maps cited fact ids to their events", async () => {
    let s;
    const router = new FakeRouter([], ROUTES);
    ({ host, s } = await bootHost(router, SETTINGS));
    router.push({ json: { value: "Marcus Bell", confidence: 0.7, evidence: [`[${s.role.id}]`], quote: "" } });
    const o = await engineFor(host, router).compute(await def(host, "economic_buyer"), s.acme);
    expect(o.state).toBe("recorded");
    expect(o.fact?.value).toEqual({ entityId: s.marcus.id, name: "Marcus Bell" });
    expect(o.fact?.provenance).toEqual([{ eventId: s.pricing.id }]);
  });

  it("rejects an enum value not in the definition, an unknown entity and uncited answers", async () => {
    let s;
    const router = new FakeRouter([], ROUTES);
    ({ host, s } = await bootHost(router, SETTINGS));
    const engine = engineFor(host, router);
    router.push({ json: { value: "negotiation", confidence: 0.8, evidence: [s.security.id] } });
    const badEnum = await engine.compute(await def(host, "deal_stage"), s.acme);
    expect(badEnum.state).toBe("rejected");
    expect(badEnum.reason).toContain('"negotiation" is not one of');

    router.push({ json: { value: "Zed Nobody", confidence: 0.8, evidence: [s.pricing.id] } });
    expect((await engine.compute(await def(host, "economic_buyer"), s.acme)).reason).toContain("does not match a known entity");

    router.push({ json: { value: "pilot", confidence: 0.8, evidence: ["ev-made-up"] } });
    expect((await engine.compute(await def(host, "deal_stage"), s.acme)).reason).toContain("cited no evidence");

    router.push({ json: { value: null, confidence: 0, evidence: [] } });
    expect((await engine.compute(await def(host, "deal_stage"), s.acme)).state).toBe("no_value");
    expect(await viewFacts(host.store, s.acme.id, "deal_stage", true)).toHaveLength(0);

    // Enum matching is case-insensitive and stores the defined spelling.
    router.push({ json: { value: "Security_Review", confidence: 0.8, evidence: [s.security.id] } });
    expect((await engine.compute(await def(host, "deal_stage"), s.acme)).fact?.value).toBe("security_review");
  });

  it("does not re-record an unchanged value, and supersedes a changed one", async () => {
    let s;
    const router = new FakeRouter([], ROUTES);
    ({ host, s } = await bootHost(router, SETTINGS));
    const engine = engineFor(host, router);
    const stage = await def(host, "deal_stage");
    router.push(
      { json: { value: "evaluation", confidence: 0.6, evidence: [s.pricing.id] } },
      { json: { value: "evaluation", confidence: 0.7, evidence: [s.pricing.id] } },
      { json: { value: "security_review", confidence: 0.8, evidence: [s.security.id] } },
    );
    const first = await engine.compute(stage, s.acme);
    expect((await engine.compute(stage, s.acme)).state).toBe("unchanged");
    expect(await viewFacts(host.store, s.acme.id, "deal_stage", true)).toHaveLength(1);
    const changed = await engine.compute(stage, s.acme);
    expect(changed.fact?.supersedes).toBe(first.fact!.id);
    const current = await viewFacts(host.store, s.acme.id, "deal_stage");
    expect(current.map((f) => f.value)).toEqual(["security_review"]);
  });

  it("never lets a model override a human-set value", async () => {
    let s;
    const router = new FakeRouter([], ROUTES);
    ({ host, s } = await bootHost(router, SETTINGS));
    const engine = engineFor(host, router);
    const stage = await def(host, "deal_stage");
    router.push({ json: { value: "evaluation", confidence: 0.6, evidence: [s.pricing.id] } });
    await engine.compute(stage, s.acme);

    const set = await setByHuman(host.store, "local", stage, s.acme, "Pilot", "user:jack");
    expect(set.ok).toBe(true);
    if (!set.ok) return;
    expect(set.fact.value).toBe("pilot");
    expect(set.fact.origin.kind).toBe("human");
    expect(set.fact.confidence).toBe(1);
    const note = await host.store.getEvent(set.fact.provenance[0]!.eventId);
    expect(note?.content.text).toContain("user:jack set deal_stage for Acme Robotics: pilot.");
    expect(note?.participants.some((p) => p.entityId === s.acme.id)).toBe(false);

    const held = await engine.compute(stage, s.acme);
    expect(held.state).toBe("held_by_human");
    expect(router.calls).toHaveLength(1);

    // The store is what enforces it: a model fact may not supersede the human one,
    // and a competing model fact is kept below 0.5.
    const modelFact = {
      type: "attribute",
      subject: { entityId: s.acme.id, name: "Acme Robotics" },
      predicate: "view.deal_stage",
      value: "evaluation",
      statement: "deal_stage for Acme Robotics: evaluation.",
      validFrom: s.security.occurredAt,
      provenance: [{ eventId: s.security.id }],
      confidence: 0.9,
      origin: { kind: "model" as const, by: "views", version: "1" },
    };
    await expect(host.store.recordFact({ ...modelFact, supersedes: set.fact.id })).rejects.toThrow(StoreError);
    expect((await host.store.recordFact(modelFact)).confidence).toBeLessThan(0.5);
    const out = await runView(host, ["show", "Acme Robotics"], { kind: "organization" });
    expect(out.stdout).toMatch(/deal_stage +pilot +1\.00 +human:user:jack/);
  });

  it("keeps event text within maxEventTokens and never uses the synthesize tier", async () => {
    let s;
    const router = new FakeRouter([], ROUTES);
    ({ host, s } = await bootHost(router, { ...SETTINGS, maxEventTokens: 50 }));
    router.push({ json: { value: null, confidence: 0, evidence: [] } });
    await engineFor(host, router, { ...SETTINGS, maxEventTokens: 50 }).compute(await def(host, "economic_buyer"), s.acme);
    const prompt = router.calls[0]!.req.messages[0]!.content;
    expect(prompt).toContain("SOC 2 Type II"); // the newest event fits
    expect(prompt).not.toContain("I approve the pricing on our side."); // the older one does not
    expect(router.calls.every((c) => c.tier === "extract")).toBe(true);
  });

  it("reports model views as not computed with no route, and still runs rule views", async () => {
    let s;
    const router = new FakeRouter([], {});
    ({ host, s } = await bootHost(router, SETTINGS));
    const engine = engineFor(host, router);
    const o = await engine.compute(await def(host, "economic_buyer"), s.acme);
    expect(o.state).toBe("unavailable");
    expect(o.reason).toBe("no extract route configured");
    expect((await engine.compute(await def(host, "last_contact"), s.acme)).state).toBe("recorded");
    expect(router.calls).toHaveLength(0);
    const out = await runView(host, ["show", "Acme Robotics"], { kind: "organization" });
    expect(out.stdout).toMatch(/economic_buyer +- +not computed: no extract route configured/);
  });

  it("stops calling after the router fails once in a run", async () => {
    let s;
    const router = new FakeRouter([new RouterError("ALL_ROUTES_FAILED", "extract", "down")], ROUTES);
    ({ host, s } = await bootHost(router, SETTINGS));
    const engine = engineFor(host, router);
    const outcomes = await engine.backfill(await def(host, "economic_buyer"));
    expect(outcomes.map((o) => o.state)).toEqual(["unavailable"]);
    expect((await engine.compute(await def(host, "deal_stage"), s.acme)).reason).toBe("extract tier unavailable (ALL_ROUTES_FAILED)");
    expect(router.calls).toHaveLength(1);
  });
});

describe("serving views", () => {
  it("adds a Views section to context bundles and answers yrm_views", async () => {
    let s;
    ({ host, s } = await bootHost(new FakeRouter([], {}), SETTINGS));
    await engineFor(host, host.models).compute(await def(host, "last_contact"), s.acme);
    const bundle = await host.buildContext({ entityIds: [s.acme.id], budget: 5000 });
    const section = bundle.sections.find((x) => x.title === "Views");
    expect(section?.text).toContain("Acme Robotics · last_contact: 2026-09-22 (rule, confidence 0.95");

    const tool = host.registry.tools.get("yrm_views")!;
    expect(tool.readOnly).toBe(true);
    const res = (await tool.run({ entityId: s.acme.id }, { tenantId: "local", store: host.store, models: host.models, log: silentLogger })) as {
      views: ViewValueOut[];
    };
    const byName = new Map(res.views.map((v) => [v.name, v]));
    expect(byName.get("last_contact")?.display).toBe("2026-09-22");
    expect(byName.get("last_contact")?.provenance).toEqual([{ eventId: s.security.id, quote: null }]);
    expect(byName.get("economic_buyer")?.status).toBe("not computed: no extract route configured");
  });

  it("recomputes rule views for touched entities once, when the host stops", async () => {
    let s;
    ({ host, s } = await bootHost(new FakeRouter([], {}), SETTINGS));
    const ctx = { tenantId: "local", store: host.store, models: host.models, log: silentLogger };
    await host.hooks.emit("fact:recorded", ctx, s.ask);
    await host.hooks.emit("fact:recorded", ctx, s.role);
    expect(await viewFacts(host.store, s.marcus.id, "last_contact")).toHaveLength(0);
    await host.stop();
    expect((await viewFacts(host.store, s.marcus.id, "last_contact")).map((f) => f.value)).toEqual(["2026-08-20"]);
    // The organization is recomputed with its people.
    expect((await viewFacts(host.store, s.acme.id, "open_items")).map((f) => f.value)).toEqual([2]);
  });

  it("drop keeps facts, which stay visible as attributes", async () => {
    let s;
    ({ host, s } = await bootHost(new FakeRouter([], {}), SETTINGS));
    await engineFor(host, host.models).compute(await def(host, "last_contact"), s.acme);
    const out = await runView(host, ["drop", "last_contact"]);
    expect(out.stdout).toContain("1 fact kept");
    expect(await viewFacts(host.store, s.acme.id, "last_contact")).toHaveLength(1);
    const show = await runView(host, ["show", "Acme Robotics"], { kind: "organization" });
    expect(show.stdout).toMatch(/last_contact \(no definition\) +2026-09-22/);
  });
});
