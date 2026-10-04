import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cli, tempDir, writeConfig, writeExtension } from "./helpers.ts";

/**
 * A stand-in for ext-mail + ext-resolve + ext-extract + ext-attention + ext-mcp,
 * loaded from the project's .yrm/extensions so the CLI picks it up like any
 * other extension.
 */
const FAKE = `
export const manifest = { name: "fake" };
const msg = (id, at, from, name, text) => ({
  source: "mail", kind: "message", externalId: id, occurredAt: at,
  participants: [{ role: "from", address: from, name }, { role: "to", address: "jack@yagni.example" }],
  content: { text }, meta: {},
});
export default function (yrm) {
  yrm.registerSource({
    name: "mail", kinds: ["message"],
    async sync() {},
    async importPath(path, ctx) {
      await ctx.emit([
        msg("m1", "2026-06-02T10:00:00.000Z", "priya.raman@acme.example", "Priya Raman", "I will send the pick data by June 23."),
        msg("m2", "2026-06-20T10:00:00.000Z", "tfischer@mailhub.example", "Tom Fischer", "I will install the agent by August 14."),
        msg("m1", "2026-06-02T10:00:00.000Z", "priya.raman@acme.example", "Priya Raman", "I will send the pick data by June 23."),
      ]);
    },
  });
  yrm.registerResolver({
    name: "by-address", priority: 0,
    async resolve(event, ctx) {
      const out = [];
      for (const [index, p] of event.participants.entries()) {
        if (!p.address || p.self) continue;
        let [e] = await ctx.store.findEntities({ tenantId: ctx.tenantId, identifier: { type: "email", value: p.address } });
        if (!e) e = await ctx.store.createEntity({ tenantId: ctx.tenantId, kind: "person", name: p.name ?? p.address,
          identifiers: [{ type: "email", value: p.address, confidence: 1, source: "fake" }], status: "proposed" });
        out.push({ index, entityId: e.id });
      }
      return out;
    },
  });
  yrm.registerExtractor({
    name: "fake-extract", version: "1",
    async extract(event) {
      const from = event.participants.find((p) => p.role === "from");
      if (!from || !from.entityId) return [];
      return [{ type: "commitment", subject: { entityId: from.entityId, name: from.name }, predicate: "committed_to",
        value: { what: event.content.text, status: "open" }, statement: from.name + " committed: " + event.content.text,
        validFrom: event.occurredAt, provenance: [{ eventId: event.id }], confidence: 0.7, origin: { kind: "rule", by: "fake-extract" } }];
    },
  });
  yrm.registerRanker({
    name: "fake-rank",
    async rank(ctx, candidates) {
      const facts = await ctx.store.queryFacts({ tenantId: ctx.tenantId, type: "commitment" });
      return [...candidates, ...facts.map((f) => ({ key: f.id, action: "Follow up: " + f.statement, reason: "open commitment",
        score: 0.6, about: [{ entityId: f.subject.entityId, name: f.subject.name }],
        evidence: { factIds: [f.id], eventIds: f.provenance.map((p) => p.eventId) }, by: "fake-rank" }))];
    },
  });
  yrm.registerCommand({
    name: "serve", description: "fake MCP server",
    async run(ctx) { ctx.stdout("serving" + (ctx.flags.mcp ? " --mcp" : "")); return 7; },
  });
}
`;

let dir = "";
let cleanup = () => {};
let mailDir = "";

beforeEach(() => {
  ({ dir, cleanup } = tempDir());
  writeConfig(dir);
  writeExtension(dir, "fake", FAKE);
  mailDir = join(dir, "inbox");
  mkdirSync(mailDir);
  writeFileSync(join(mailDir, "a.eml"), "");
});
afterEach(() => cleanup());

const ULID = /[0-9A-HJKMNP-TV-Z]{26}/;

describe("CLI against a project extension", () => {
  test("import resolves, extracts and summarizes; a second import is all duplicates", async () => {
    const r = await cli(["import", "inbox"], { cwd: dir });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/mail\s+.*inbox\s+2\s+1\s+0/);
    expect(r.stdout).toMatch(/events created\s+2/);
    expect(r.stdout).toMatch(/entities proposed\s+2/);
    expect(r.stdout).toMatch(/facts recorded\s+2/);

    const again = await cli(["import", "inbox"], { cwd: dir });
    expect(again.stdout).toMatch(/events created\s+0/);
    expect(again.stdout).toMatch(/duplicates\s+3/);
  });

  test("--no-extract imports events only", async () => {
    const r = await cli(["import", "inbox", "--no-extract"], { cwd: dir });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/facts recorded\s+skipped \(--no-extract\)/);
  });

  test("today, who, facts, confirm, merge", async () => {
    await cli(["import", "inbox"], { cwd: dir });

    const today = await cli(["today", "--date", "2026-10-03"], { cwd: dir });
    expect(today.code).toBe(0);
    expect(today.out[0]).toBe("Today, 2026-10-03 for Jack  (2 items)");
    expect(today.stdout).toContain("Follow up: Priya Raman committed: I will send the pick data by June 23.");
    expect(today.stdout).toContain("(facts: 1, events: 1)");

    const json = await cli(["today", "--date", "2026-10-03", "--json"], { cwd: dir });
    expect(JSON.parse(json.stdout)).toHaveLength(2);

    const who = await cli(["who", "priya"], { cwd: dir });
    expect(who.code).toBe(0);
    expect(who.stdout).toContain("Priya Raman  person  [proposed]");
    expect(who.stdout).toContain("email:priya.raman@acme.example");
    expect(who.stdout).toMatch(/events 1\s+·\s+first 2026-06-02/);
    const priyaId = who.stdout.match(ULID)![0];

    const byAddress = await cli(["who", "tfischer@mailhub.example", "--facts"], { cwd: dir });
    expect(byAddress.stdout).toContain("Tom Fischer");
    expect(byAddress.stdout).toContain("[commitment/committed_to]");
    const tomId = byAddress.stdout.match(ULID)![0];

    const facts = await cli(["facts", priyaId], { cwd: dir });
    expect(facts.code).toBe(0);
    expect(facts.stdout).toContain("Priya Raman committed: I will send the pick data by June 23.");
    expect(facts.stdout).toContain("rule:fake-extract@1");
    const before = await cli(["facts", "priya", "--as-of", "2026-01-01"], { cwd: dir });
    expect(before.stdout).toContain("(no facts)");
    expect(before.stdout).toContain("as known on 2026-01-01 23:59");

    const confirmed = await cli(["confirm", priyaId], { cwd: dir });
    expect(confirmed.code).toBe(0);
    expect(confirmed.stdout).toBe(`confirmed Priya Raman (${priyaId}) by user:jack`);
    expect((await cli(["who", priyaId], { cwd: dir })).stdout).toContain("[confirmed]");

    const merged = await cli(["merge", tomId, priyaId], { cwd: dir });
    expect(merged.code).toBe(0);
    const after = await cli(["who", "tfischer@mailhub.example"], { cwd: dir });
    expect(after.stdout).toContain("Priya Raman");
    expect(after.stdout).toContain("email:tfischer@mailhub.example");
  });

  test("an extension's serve command replaces the built-in and its exit code propagates", async () => {
    const r = await cli(["serve", "--mcp"], { cwd: dir });
    expect(r.out).toEqual(["serving --mcp"]);
    expect(r.code).toBe(7);
    const help = await cli([], { cwd: dir });
    expect(help.stdout).toMatch(/serve\s+fake MCP server/);
  });

  test("ambiguous facts query lists candidates", async () => {
    await cli(["import", "inbox"], { cwd: dir });
    const r = await cli(["facts", "r"], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain('"r" matches 2 entities');
  });
});
