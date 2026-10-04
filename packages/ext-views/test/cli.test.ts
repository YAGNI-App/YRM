import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SqliteStore } from "@yrm/core";
import { cli as run, tempDir } from "../../cli/test/helpers.ts";
import { seed, type Seed } from "./helpers.ts";

/**
 * `yrm view ...` through the real CLI: config file, bootstrap, extension
 * loading, sqlite on disk. The extract route points at a closed port, as in
 * the Acme demo with no local model running.
 */
let dir = "";
let cleanup = () => {};
let s: Seed;
const cli = (argv: string[]) => run(argv, { cwd: dir, builtins: ["@yrm/ext-views"] });

beforeAll(async () => {
  ({ dir, cleanup } = tempDir("yrm-views-"));
  writeFileSync(
    join(dir, "yrm.config.ts"),
    `export default {
  tenant: { id: "local", selfAddresses: ["jack@yagni.example"], selfDomains: ["yagni.example"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ".yrm/local/yrm.sqlite" },
  models: { routes: { extract: [{ provider: "openai-compatible", model: "qwen3:8b" }] } },
  providers: { "openai-compatible": { baseUrl: "http://127.0.0.1:9/v1" } },
  settings: { views: { definitions: [
    { name: "deal_stage", appliesTo: "organization", valueType: "enum", populatedBy: "model",
      enumValues: ["discovery", "evaluation", "pilot"], description: "Where our commercial conversation with this organization stands." },
  ] } },
};
`,
  );
  mkdirSync(join(dir, ".yrm", "local"), { recursive: true });
  const store = new SqliteStore({ path: join(dir, ".yrm", "local", "yrm.sqlite") });
  await store.migrate();
  s = await seed(store);
  await store.close();
}, 30_000);

afterAll(() => cleanup());

describe("yrm view", () => {
  it("lists built-in and config views", async () => {
    const r = await cli(["view", "list"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^deal_stage +organization +enum\(discovery\|evaluation\|pilot\) +model/m);
    expect(r.stdout).toMatch(/^last_contact +person,organization +date +rule/m);
  });

  it("defines a view, refuses a duplicate, validates input", async () => {
    const ok = await cli(["view", "define", "economic_buyer", "--for", "organization", "--type", "entity", "the person who controls the budget for our deal"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("defined economic_buyer: entity on organization, by model");
    const dup = await cli(["view", "define", "economic_buyer", "--for", "organization", "--type", "entity", "the person who controls the budget"]);
    expect(dup.code).toBe(1);
    expect(dup.stderr).toContain("pass --force");
    const kind = await cli(["view", "define", "x_y", "--for", "planet", "--type", "string", "a field about planets"]);
    expect(kind.stderr).toContain("--for must be person, organization, deal");
    const issueSpelling = await cli(["view", "define", "budget_owner", "--applies-to", "person", "--type", "boolean", "--description", "whether this person owns a budget"]);
    expect(issueSpelling.code).toBe(0);
  });

  it("estimates a backfill without calling a model", async () => {
    const r = await cli(["view", "backfill", "--dry-run", "deal_stage"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^Acme Robotics +would_compute +~\d+ input tokens/m);
    expect(r.stdout).toMatch(/1 model calls, ~\d+ input \+ up to 300 output tokens, est \$0 \(openai-compatible\/qwen3:8b, no price configured\)/);
    expect(r.stdout).not.toContain("YAGNI");
  });

  it("backfills rule views and degrades model views when the model is unreachable", async () => {
    const rule = await cli(["view", "backfill", "last_contact"]);
    expect(rule.code).toBe(0);
    expect(rule.stdout).toMatch(/^Acme Robotics +recorded +2026-09-22/m);
    expect(rule.stdout).toMatch(/^Marcus Bell +recorded +2026-08-20/m);
    const model = await cli(["view", "backfill", "deal_stage"]);
    expect(model.code).toBe(0);
    expect(model.stdout).toMatch(/^Acme Robotics +unavailable +extract tier unavailable/m);
    const show = await cli(["view", "show", "Acme Robotics"]);
    expect(show.stdout).toMatch(/last_contact +2026-09-22 +0\.95 +rule:views +\S+/);
    expect(show.stdout).toMatch(/deal_stage +- +not computed: extract tier unavailable/);
  });

  it("sets a value by hand and shows it in who", async () => {
    const bad = await cli(["view", "set", "Acme Robotics", "deal_stage", "won"]);
    expect(bad.code).toBe(1);
    expect(bad.stderr).toContain('"won" is not one of discovery, evaluation, pilot');
    const ok = await cli(["view", "set", "Acme Robotics", "deal_stage", "pilot"]);
    expect(ok.code).toBe(0);
    expect(ok.stdout).toContain("deal_stage for Acme Robotics: pilot. Recorded as user:jack@yagni.example");
    const buyer = await cli(["view", "set", "Acme Robotics", "economic_buyer", "marcus@acme-robotics.example"]);
    expect(buyer.stdout).toContain("economic_buyer for Acme Robotics: Marcus Bell.");
    const show = await cli(["view", "show", s.acme.id]);
    expect(show.stdout).toMatch(/deal_stage +pilot +1\.00 +human:user:jack@yagni\.example/);
    const who = await cli(["who", "Acme Robotics"]);
    expect(who.stdout).toContain("deal_stage=pilot");
    expect(who.stdout).toContain("economic_buyer=Marcus Bell");
  });

  it("drops a definition and keeps its facts", async () => {
    const r = await cli(["view", "drop", "deal_stage"]);
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("dropped deal_stage; 1 fact kept");
    const show = await cli(["view", "show", "Acme Robotics"]);
    expect(show.stdout).toMatch(/deal_stage \(no definition\) +pilot/);
    expect((await cli(["view", "list"])).stdout).not.toMatch(/^deal_stage/m);
  });
});
