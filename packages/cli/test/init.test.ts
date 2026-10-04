import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { loadConfig } from "@yrm/core";
import { cli, tempDir } from "./helpers.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("yrm init", () => {
  test("writes a config loadConfig accepts, with the Acme tenant", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    const r = await cli(
      ["init", "--self", "jack@yagni.example", "--domain", "yagni.example", "--name", "Jack", "--timezone", "America/Denver"],
      { cwd: dir },
    );
    expect(r.code).toBe(0);
    expect(existsSync(join(dir, ".yrm", "local", ".gitkeep"))).toBe(true);

    const { config, root } = await loadConfig(dir);
    expect(config.tenant).toMatchObject({
      name: "Jack",
      selfAddresses: ["jack@yagni.example"],
      selfDomains: ["yagni.example"],
      timezone: "America/Denver",
    });
    expect(config.storage.path).toBe(join(root, ".yrm/local/yrm.sqlite"));
    expect(config.models.routes["triage"]).toEqual([{ provider: "openai-compatible", model: "qwen3:8b" }]);
    expect(config.models.routes["extract"]).toEqual([{ provider: "openai-compatible", model: "qwen3:8b" }]);
    expect(config.models.routes["synthesize"]).toEqual([{ provider: "anthropic", model: "claude-opus-5" }]);
    expect(config.providers?.["openai-compatible"]).toEqual({ baseUrl: "http://localhost:11434/v1" });
    expect(readFileSync(join(dir, "yrm.config.ts"), "utf8")).toContain("rule-based");
  });

  test("uses defineConfig when @yrm/core resolves from the project", async () => {
    // A directory inside the workspace, so @yrm/core resolves through node_modules.
    const base = join(import.meta.dir, "..", ".tmp");
    mkdirSync(base, { recursive: true });
    const dir = mkdtempSync(join(base, "init-"));
    cleanups.push(() => rmSync(base, { recursive: true, force: true }));
    expect((await cli(["init", "--self", "me@example.com"], { cwd: dir })).code).toBe(0);
    const text = readFileSync(join(dir, "yrm.config.ts"), "utf8");
    expect(text).toContain('import { defineConfig } from "@yrm/core";');
    expect((await loadConfig(dir)).config.tenant.selfAddresses).toEqual(["me@example.com"]);
  });

  test("refuses to overwrite without --force", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    expect((await cli(["init"], { cwd: dir })).code).toBe(0);
    const again = await cli(["init", "--name", "Other"], { cwd: dir });
    expect(again.code).toBe(1);
    expect(again.stderr).toContain("--force");
    const forced = await cli(["init", "--name", "Other", "--force"], { cwd: dir });
    expect(forced.code).toBe(0);
    expect((await loadConfig(dir)).config.tenant.name).toBe("Other");
  });

  test("the root example config is valid", async () => {
    const { normalizeConfig } = await import("@yrm/core");
    const mod = await import("../../../yrm.config.example.ts");
    expect(() => normalizeConfig(mod.default)).not.toThrow();
  });
});
