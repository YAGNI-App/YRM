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
    expect(summaryNumber("facts recorded")).toBe(count("SELECT count(*) AS n FROM facts") - closures);
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

    // Imported after Oct 3, but every message was received by then (ADR 0008).
    const then = await cli(["today", "--date", "2026-10-03", "--as-of", "2026-10-03"], { cwd: dir, builtins: BUILTINS });
    expect(then.out.filter((l) => /^\s*\d+\. /.test(l))).toEqual(actions);
  });

  it("today --as-of a past day hides what was not yet known", async () => {
    const r = await cli(["today", "--date", "2026-10-03", "--as-of", "2026-08-20"], { cwd: dir, builtins: BUILTINS });
    expect(r.code).toBe(0);
    // Marcus asked on Sept 2 and the Type II promise was made on Aug 26.
    expect(r.stdout).not.toContain("Reply to Marcus Bell");
    expect(r.stdout).not.toContain("Deliver to Elena Vasquez");
    expect(r.stdout).toMatch(/^\s*\d+\. /m);
  });
});

describe("the time machine on imported history (ADR 0008)", () => {
  const priya = (): string =>
    (
      db
        .query("SELECT entity_id AS id FROM entity_identifiers WHERE value = 'priya.raman@acme-robotics.example'")
        .get() as { id: string }
    ).id;
  const facts = (...flags: string[]) => cli(["facts", priya(), ...flags], { cwd: dir, builtins: BUILTINS });
  const JOB_CHANGE = "Priya Raman is changing jobs";

  it("records when facts were known, not when they were imported", () => {
    const row = db
      .query(
        "SELECT known_at, recorded_at FROM facts WHERE predicate = 'job_change' AND subject_name = 'Priya Raman' AND value_json LIKE '%Northwind%'",
      )
      .get() as { known_at: string; recorded_at: string };
    // Sent Aug 14, held by Acme's DLP gateway, received Sept 3.
    expect(row.known_at.slice(0, 10)).toBe("2026-09-03");
    expect(row.recorded_at > row.known_at).toBe(true);
  });

  it("on Aug 20 we knew Priya at Acme and nothing of her job change", async () => {
    const r = await facts("--at", "2026-08-20", "--as-of", "2026-08-20");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain("Priya Raman works at Acme Robotics.");
    expect(r.stdout).not.toContain(JOB_CHANGE);
    expect(r.stdout).toMatch(/^statement .* known /m);
  });

  it("by Sept 4 we knew she had left in August", async () => {
    expect((await facts("--as-of", "2026-09-04")).stdout).toContain(JOB_CHANGE);
    const back = await facts("--at", "2026-08-20", "--as-of", "2026-09-05");
    expect(back.stdout).toMatch(new RegExp(`${JOB_CHANGE}.*2026-08-1[45]\\.\\.\\s+2026-09-03`));
  });
});
