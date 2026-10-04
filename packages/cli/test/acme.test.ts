import { Database } from "bun:sqlite";
import { afterAll, beforeAll, describe, expect, it } from "bun:test";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { BUILTINS } from "../src/builtins.ts";
import { cli, tempDir, type Captured } from "./helpers.ts";

/**
 * The documented demo: `yrm import fixtures/acme` with the fixture's own
 * yrm.config.ts. The config is copied to a temp dir so the store lands there,
 * with the import stripped (plain object loads from anywhere) and the local
 * model pointed at a closed port so nothing depends on Ollama running.
 */
const FIXTURE = resolve(import.meta.dir, "../../../fixtures/acme");

function fixtureConfig(): string {
  return readFileSync(join(FIXTURE, "yrm.config.ts"), "utf-8")
    .replace(/^import \{ defineConfig \} from "@yrm\/core";$/m, "")
    .replace("export default defineConfig({", "export default ({")
    .replace("http://localhost:11434/v1", "http://127.0.0.1:9/v1");
}

let dir = "";
let cleanup = () => {};
let imported: Captured;
let db: Database;

beforeAll(async () => {
  ({ dir, cleanup } = tempDir("yrm-acme-"));
  writeFileSync(join(dir, "yrm.config.ts"), fixtureConfig());
  imported = await cli(["import", FIXTURE], { cwd: dir, builtins: BUILTINS });
  db = new Database(join(dir, ".yrm", "local", "yrm.sqlite"), { readonly: true });
}, 60_000);

afterAll(() => {
  db?.close();
  cleanup();
});

const count = (sql: string): number => (db.query(sql).get() as { n: number }).n;
const summaryNumber = (label: string): number => {
  const m = imported.stdout.match(new RegExp(`^${label}\\s+(\\d+)`, "m"));
  if (!m) throw new Error(`no "${label}" line in:\n${imported.stdout}`);
  return Number(m[1]);
};

describe("yrm import fixtures/acme", () => {
  it("imports the corpus and reports what mail dropped", () => {
    expect(imported.code).toBe(0);
    expect(summaryNumber("events created")).toBe(40);
    expect(count("SELECT count(*) AS n FROM events")).toBe(40);
    // ground-truth.json lists 7 noise messages.
    expect(summaryNumber("dropped")).toBe(7);
    expect(imported.stdout).toMatch(/^mail\s+\S+\s+33\s+0\s+7\s+0$/m);
  });

  it("proposes 10 people and 3 organizations, with no Mailhub", () => {
    expect(summaryNumber("entities proposed")).toBe(13);
    expect(count("SELECT count(*) AS n FROM entities WHERE kind = 'person'")).toBe(10);
    const orgs = db.query("SELECT name FROM entities WHERE kind = 'organization' ORDER BY name").all() as Array<{ name: string }>;
    expect(orgs.map((o) => o.name)).toEqual(["Acme Robotics", "Northwind", "YAGNI"]);
  });

  it("does not say Tom Fischer works at Mailhub", () => {
    const rows = db
      .query("SELECT statement FROM facts WHERE predicate = 'works_at' AND subject_name = 'Tom Fischer'")
      .all() as Array<{ statement: string }>;
    expect(rows.map((r) => r.statement)).toEqual(["Tom Fischer works at Acme Robotics."]);
  });

  it("counts every fact recorded, matching the store", () => {
    // Valid-time closures are the store's own bookkeeping when a later fact supersedes an earlier one.
    const closures = count("SELECT count(*) AS n FROM fact_audit WHERE action = 'valid_time_closed'");
    // View values (ADR 0010) are recorded after the pipeline, when the host stops; they are not pipeline facts.
    const views = count("SELECT count(*) AS n FROM facts WHERE predicate LIKE 'view.%'");
    expect(summaryNumber("facts recorded")).toBe(count("SELECT count(*) AS n FROM facts") - closures - views);
    expect(summaryNumber("facts recorded")).toBeGreaterThan(20);
  });

  it("warns about the unreachable local model once, not per event", () => {
    const modelWarnings = imported.err.filter((l) => l.includes("call failed"));
    expect(modelWarnings.length).toBeLessThanOrEqual(2);
  });

  it("lists everyone with `who`, people under their organization", async () => {
    const r = await cli(["who"], { cwd: dir, builtins: BUILTINS });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^organizations \(3\)$/m);
    expect(r.stdout).toMatch(/^ {2}Acme Robotics .*\n(?: {4}.*\n)* {4}Marcus Bell /m);
    expect(r.stdout).toMatch(/^people with no current organization \(1\)\n {2}Tom Fischer .*tfischer@mailhub\.example/m);
  });

  it("filters `facts` matches with --kind", async () => {
    const ambiguous = await cli(["facts", "Tom Fischer"], { cwd: dir, builtins: BUILTINS });
    expect(ambiguous.code).toBe(1);
    expect(ambiguous.stderr).toContain("pass an id or --kind");
    const org = await cli(["facts", "Acme Robotics", "--kind", "organization"], { cwd: dir, builtins: BUILTINS });
    expect(org.code).toBe(0);
    expect(org.stdout).toMatch(/^Acme Robotics {2}organization/m);
    const none = await cli(["facts", "Acme Robotics", "--kind", "person"], { cwd: dir, builtins: BUILTINS });
    expect(none.code).toBe(1);
    expect(none.stderr).toContain('no person matches "Acme Robotics"');
  });

  it("ranks 2026-10-03 with Marcus's unanswered ask and Jack's overdue Type II first", async () => {
    const r = await cli(["today", "--date", "2026-10-03"], { cwd: dir, builtins: BUILTINS });
    expect(r.code).toBe(0);
    const actions = r.out.filter((l) => /^\s*\d+\. /.test(l));
    expect(actions[0]).toContain("Reply to Marcus Bell");
    expect(actions[1]).toContain("Deliver to Elena Vasquez");
    expect(actions[1]).toContain("Type II");
    expect(r.stdout).toContain("Re-engage Acme Robotics");

    const then = await cli(["today", "--date", "2026-10-03", "--as-of", "2026-10-03"], { cwd: dir, builtins: BUILTINS });
    expect(then.stdout).toContain("Nothing needs you today.");
  });

  it("fills rule views on import and says why model views are empty", async () => {
    const r = await cli(["view", "show", "Acme Robotics", "--kind", "organization"], { cwd: dir, builtins: BUILTINS });
    expect(r.code).toBe(0);
    expect(r.stdout).toMatch(/^ {2}last_contact +2026-09-22 +0\.95 +rule:views/m);
    expect(r.stdout).toMatch(/^ {2}open_items +\d+ /m);
    for (const name of ["economic_buyer", "deal_stage", "champion", "risk_summary"]) {
      expect(r.stdout).toMatch(new RegExp(`^ {2}${name} +- +not computed: extract tier unavailable`, "m"));
    }
    const who = await cli(["who", "Acme Robotics"], { cwd: dir, builtins: BUILTINS });
    expect(who.stdout).toContain("last_contact=2026-09-22");
  });
});
