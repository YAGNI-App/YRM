import { afterEach, describe, expect, test } from "bun:test";
import { estimateMonthly, probeEndpoint, redactUrl } from "../src/commands/doctor.ts";
import { cli, tempDir, writeConfig } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("yrm doctor", () => {
  test("runs with no keys and an unreachable endpoint, exit 0", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeConfig(dir);
    const r = await cli(["doctor"], { cwd: dir });
    expect(r.stderr).toBe("");
    expect(r.code).toBe(0);
    expect(r.stdout).toContain(`config   ${dir}`);
    expect(r.stdout).toMatch(/provider-anthropic\s+built-in/);
    expect(r.stdout).toMatch(/providers\s+2 \(anthropic, openai-compatible\)/);
    expect(r.stdout).toMatch(/triage\s+openai-compatible\/qwen3:8b/);
    expect(r.stdout).toMatch(/extract\s+\(no route\)/);
    expect(r.stdout).toContain("http://127.0.0.1:9/v1 unreachable (connection refused), local");
    expect(r.stdout).toContain("no key (ANTHROPIC_API_KEY not set)");
    expect(r.stdout).toContain("month to date  $0.00");
    expect(r.stdout).toMatch(/synthesize\s+anthropic\/claude-opus-5\s+\$2\.33/);
  });

  test("reports a present key and a real closed port without hanging", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeConfig(dir);
    const started = Date.now();
    const r = await cli(["doctor"], { cwd: dir, env: { ANTHROPIC_API_KEY: "sk-test" }, fetch: (u, i) => fetch(u, i) });
    expect(r.code).toBe(0);
    expect(Date.now() - started).toBeLessThan(5000);
    expect(r.stdout).toContain("key present (ANTHROPIC_API_KEY)");
    expect(r.stdout).toContain("http://127.0.0.1:9/v1 unreachable");
  });
});

describe("probeEndpoint", () => {
  test("times out a fetch that never answers", async () => {
    const hang = () => new Promise<Response>(() => {});
    const r = await probeEndpoint("http://10.255.255.1/v1", hang, 50);
    expect(r).toEqual({ ok: false, detail: "unreachable (no answer in 0.05s)" });
  });

  test("ok on 200 and calls /models", async () => {
    let seen = "";
    const r = await probeEndpoint("http://localhost:11434/v1/", async (url) => {
      seen = url;
      return new Response("{}", { status: 200 });
    });
    expect(seen).toBe("http://localhost:11434/v1/models");
    expect(r.ok).toBe(true);
  });
});

describe("estimateMonthly", () => {
  test("prices known models, zeroes local ones and flags unknown pricing", () => {
    const est = estimateMonthly(
      {
        triage: [{ provider: "ollama", model: "qwen3:8b" }],
        extract: [{ provider: "openrouter", model: "some/model" }],
        synthesize: [{ provider: "anthropic", model: "claude-opus-5" }],
      },
      (p) => p === "ollama",
    );
    expect(est.map((e) => [e.tier, e.usd === null ? null : Number(e.usd.toFixed(2)), e.note])).toEqual([
      ["triage", 0, "local"],
      ["extract", null, "unknown pricing"],
      // 30 * (8000 * $5 + 1500 * $25) / 1M
      ["synthesize", 2.33, "30 calls"],
    ]);
  });

  test("route pricing overrides the table", () => {
    const [triage] = estimateMonthly({ triage: [{ provider: "x", model: "m", pricing: { input: 1, output: 1 } }] }, () => false);
    // 1200 calls * 1650 tokens * $1/M
    expect(triage?.usd).toBeCloseTo(1.98, 5);
  });
});

describe("redactUrl", () => {
  test("hides a Postgres password and leaves other values alone", () => {
    expect(redactUrl("postgres://yrm:s3cret@db.example.test:5432/yrm")).toBe("postgres://yrm:***@db.example.test:5432/yrm");
    expect(redactUrl("postgres://yrm@db.example.test/yrm")).toBe("postgres://yrm@db.example.test/yrm");
    expect(redactUrl("/var/yrm.db")).toBe("/var/yrm.db");
  });
});
