import { describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { join } from "node:path";
import { BUILTINS, BUNDLED } from "../src/builtins.ts";
import { isCompiled } from "../src/compiled.ts";

describe("bundled extensions", () => {
  test("every default builtin is statically importable", () => {
    for (const spec of BUILTINS) expect(Object.keys(BUNDLED)).toContain(spec);
  });

  test("every packages/ext-* is in the static map, so the compiled binary ships it", () => {
    const exts = readdirSync(join(import.meta.dir, "..", ".."))
      .filter((d) => d.startsWith("ext-"))
      .map((d) => `@yrm/${d}`);
    expect(Object.keys(BUNDLED).sort()).toEqual(exts.sort());
  });

  test("each entry imports a module with a default factory and a manifest", async () => {
    for (const [spec, load] of Object.entries(BUNDLED)) {
      const mod = (await load()) as Record<string, unknown>;
      expect(typeof mod["default"], spec).toBe("function");
      expect(typeof (mod["manifest"] as { name?: unknown } | undefined)?.name, spec).toBe("string");
    }
  });
});

describe("isCompiled", () => {
  test("recognizes Bun's embedded filesystem", () => {
    expect(isCompiled("file:///$bunfs/root/yrm")).toBe(true);
    expect(isCompiled("file:///B:/~BUN/root/yrm.exe")).toBe(true);
    expect(isCompiled(import.meta.url)).toBe(false);
  });
});
