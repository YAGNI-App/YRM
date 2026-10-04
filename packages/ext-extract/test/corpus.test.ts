import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  createHost,
  silentLogger,
  SqliteStore,
  type AskValue,
  type CommitmentValue,
  type ExtensionAPI,
  type Fact,
  type Host,
  type NewSourceEvent,
  type Participant,
  type YrmConfig,
} from "@yrm/core";
import { FakeRouter } from "../../core/src/testing/fake-router.ts";
import extract, { formatScorecard, manifest, scoreFacts, type GroundTruth, type Scorecard } from "../src/index.ts";

/**
 * End to end over the Acme corpus with no model routes: what a user gets on
 * day one with no API keys. `@yrm/ext-mail` is built in parallel, so a minimal
 * RFC 5322 reader and a header resolver live here.
 */

const CORPUS = join(import.meta.dir, "../../../fixtures/acme");
const gt = JSON.parse(readFileSync(join(CORPUS, "ground-truth.json"), "utf8")) as GroundTruth & {
  tenant: { selfAddresses: string[]; selfDomains: string[] };
  noise: string[];
};

function parseAddresses(value: string | undefined, role: string): Participant[] {
  if (!value) return [];
  return (value.match(/(?:"[^"]*"|[^,])+/g) ?? []).flatMap((part) => {
    const m = /^\s*"?([^"<]*?)"?\s*<([^>]+)>\s*$/.exec(part) ?? /^\s*()([^\s<>]+@[^\s<>]+)\s*$/.exec(part);
    if (!m) return [];
    const name = m[1]?.trim();
    return [{ role, address: m[2]!.toLowerCase(), ...(name ? { name } : {}) }];
  });
}

function parseEml(raw: string): NewSourceEvent {
  const text = raw.replace(/\r\n/g, "\n");
  const split = text.indexOf("\n\n");
  const headers = new Map<string, string>();
  for (const line of text.slice(0, split).replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  // New text only: stop at the attribution line or the signature, drop quoted lines.
  const kept: string[] = [];
  for (const line of text.slice(split + 2).split("\n")) {
    if (/^On .+ wrote:$/.test(line) || /^-- ?$/.test(line)) break;
    if (!line.startsWith(">")) kept.push(line);
  }
  const messageId = headers.get("message-id")!;
  const refs = (headers.get("references") ?? headers.get("in-reply-to") ?? "").match(/<[^>]+>/g) ?? [];
  return {
    source: "mail",
    kind: "message",
    externalId: messageId,
    occurredAt: new Date(headers.get("date")!).toISOString(),
    participants: [
      ...parseAddresses(headers.get("from"), "from"),
      ...parseAddresses(headers.get("to"), "to"),
      ...parseAddresses(headers.get("cc"), "cc"),
    ],
    content: { text: kept.join("\n").trim(), ...(headers.has("subject") ? { title: headers.get("subject")! } : {}) },
    threadKey: refs[0] ?? messageId,
    meta: {},
  };
}

function corpusFixture(yrm: ExtensionAPI): void {
  const noise = new Set(gt.noise);
  const events = readdirSync(join(CORPUS, "mail"))
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => parseEml(readFileSync(join(CORPUS, "mail", f), "utf8")))
    .filter((e) => !noise.has(e.externalId));
  yrm.registerSource({ name: "acme-mail", kinds: ["message"], sync: async (ctx) => void (await ctx.emit(events)) });
  // One person per address, like the header resolver will do before merges.
  yrm.registerResolver({
    name: "address",
    priority: 0,
    async resolve(event, ctx) {
      const out: Array<{ index: number; entityId: string }> = [];
      for (const [index, p] of event.participants.entries()) {
        if (!p.address) continue;
        const [found] = await ctx.store.findEntities({ identifier: { type: "email", value: p.address } });
        const entity =
          found ??
          (await ctx.store.createEntity({
            kind: "person",
            name: p.name ?? p.address,
            identifiers: [{ type: "email", value: p.address, confidence: 1, source: "test" }],
            status: "proposed",
          }));
        out.push({ index, entityId: entity.id });
      }
      return out;
    },
  });
}

describe("rule extractor on the Acme corpus", () => {
  let host: Host;
  let store: SqliteStore;
  let card: Scorecard;
  const eventIdOf = new Map<string, string>();
  const entityOf = new Map<string, string>();

  beforeAll(async () => {
    store = new SqliteStore({ path: ":memory:" });
    await store.migrate();
    const config: YrmConfig = {
      tenant: { id: "local", selfAddresses: gt.tenant.selfAddresses, selfDomains: gt.tenant.selfDomains, timezone: "UTC" },
      storage: { driver: "sqlite", path: ":memory:" },
      models: { routes: {} },
    };
    host = createHost(config, { store, models: new FakeRouter(), log: silentLogger });
    await host.use(corpusFixture, { name: "acme-fixture" });
    await host.use(extract, manifest);
    await host.run("acme-mail", { today: "2026-10-03" });
    for (const e of await store.listEvents({})) eventIdOf.set(e.externalId, e.id);
    for (const p of gt.people ?? []) {
      const [e] = await store.findEntities({ identifier: { value: p.addresses[0]! } });
      if (e) entityOf.set(p.key, e.id);
    }
    card = await scoreFacts(store, gt);
    console.log(["", ...formatScorecard(card)].join("\n"));
  });

  afterAll(async () => {
    await host.close();
  });

  it("recalls at least half of the ground-truth commitments and asks", () => {
    const c = card.byType["commitment"]!;
    const a = card.byType["ask"]!;
    const recall = (c.recalled + a.recalled) / (c.expected + a.expected);
    expect(recall).toBeGreaterThanOrEqual(0.5);
  });

  it("finds Marcus's September 2 exit question and leaves it unanswered", async () => {
    const eventId = eventIdOf.get("<202609021748.exitask@acme-robotics.example>")!;
    const asks = await store.queryFacts({ type: "ask", subjectId: entityOf.get("marcus")! });
    const exit = asks.filter((f: Fact) => f.provenance.some((p) => p.eventId === eventId));
    expect(exit.length).toBeGreaterThan(0);
    const value = exit[0]!.value as AskValue;
    expect(value.answered).toBe(false);
    expect(value.askedOf?.entityId).toBe(entityOf.get("jack")!);
    expect(exit[0]!.provenance[0]!.quote).toContain("exit the pilot order with no fee?");
  });

  it("finds Jack's commitment to deliver Type II by September 30, still open", async () => {
    const eventId = eventIdOf.get("<202608271015.secfollowups@yagni.example>")!;
    const commitments = await store.queryFacts({ type: "commitment", subjectId: entityOf.get("jack")! });
    const typeII = commitments.filter((f: Fact) => f.provenance.some((p) => p.eventId === eventId));
    expect(typeII.length).toBe(1);
    const value = typeII[0]!.value as CommitmentValue;
    expect(value.dueAt).toBe("2026-09-30");
    expect(value.status).toBe("open");
    expect(value.owedTo?.entityId).toBe(entityOf.get("elena")!);
  });

  it("closes asks that were answered in the thread", async () => {
    const eventId = eventIdOf.get("<202606030840.pricing-ask@acme-robotics.example>")!;
    const answeredBy = eventIdOf.get("<202606051530.overview@yagni.example>")!;
    const asks = await store.queryFacts({ type: "ask", subjectId: entityOf.get("marcus")! });
    const pricing = asks.filter((f: Fact) => f.provenance.some((p) => p.eventId === eventId));
    expect(pricing.length).toBeGreaterThan(0);
    for (const f of pricing) expect(f.value as AskValue).toMatchObject({ answered: true, answeredBy });
  });

  it("runs as the extract:eval command", async () => {
    const out: string[] = [];
    const command = host.registry.commands.get("extract:eval")!;
    const code = await command.run({
      tenantId: "local",
      args: [],
      flags: { corpus: CORPUS, json: true },
      store,
      models: host.models,
      stdout: (line) => out.push(line),
      stderr: () => {},
      log: silentLogger,
    });
    expect(code).toBe(0);
    const json = JSON.parse(out.join("\n")) as Scorecard;
    expect(json.overall).toEqual(card.overall);
  });

  it("closes every ground-truth commitment as the corpus does, including deliveries in new threads (#16)", () => {
    const wrong = card.closure.wrong.map((w) => w.id);
    // f02 (pick data), f03 (proposal) and f04 (order form) are delivered in fresh threads.
    for (const id of ["f01", "f02", "f03", "f04", "f05", "f06", "f07", "f08"]) expect(wrong).not.toContain(id);
    // f12 is answered by Jack's same-thread promise rather than the delivery; see README.
    expect(wrong).toEqual(["f12"]);
    expect(card.closure.correct).toBe(card.closure.expected - 1);
  });

  it("keeps commitments, decisions and objections precise", () => {
    for (const type of ["commitment", "decision", "objection"]) expect(card.byType[type]!.recall).toBe(1);
    expect(card.byType["commitment"]!.precision).toBe(1);
    const spurious = card.spurious.map((s) => s.quote);
    expect(spurious.some((q) => /pencil in Luis|make a call on scope|discovery call on June 16/.test(q))).toBe(false);
  });

  it("gives the order form to Rachel, whom Marcus's 'she' refers to, and closes it with her delivery", async () => {
    const [rachel] = await store.findEntities({ identifier: { value: "rachel.kim@acme-robotics.example" } });
    const [c] = await store.queryFacts({ type: "commitment", subjectId: rachel!.id });
    expect(c!.value as CommitmentValue).toMatchObject({
      status: "fulfilled",
      dueAt: "2026-07-17",
      resolvedBy: eventIdOf.get("<202607171548.orderform@acme-robotics.example>"),
    });
    expect(c!.provenance.at(-1)!.quote).toStartWith("Attached is the pilot order form");
  });

  it("marks Tom's missed install as broken and Dana's documents as fulfilled", async () => {
    const tom = await store.queryFacts({ type: "commitment", subjectId: entityOf.get("tom")! });
    expect(tom.map((f) => (f.value as CommitmentValue).status)).toContain("broken");
    const dana = await store.queryFacts({ type: "commitment", subjectId: entityOf.get("dana")! });
    const docs = dana.find((f) => (f.value as CommitmentValue).dueAt === "2026-09-04");
    expect(docs?.value as CommitmentValue).toMatchObject({ status: "fulfilled" });
  });
});
