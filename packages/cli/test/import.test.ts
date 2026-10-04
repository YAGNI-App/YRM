import { afterEach, describe, expect, test } from "bun:test";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { planImport } from "../src/commands/import.ts";
import { cli, tempDir, writeConfig } from "./helpers.ts";

const ACME = resolve(import.meta.dir, "../../../fixtures/acme");
const cleanups: Array<() => void> = [];
afterEach(() => {
  while (cleanups.length) cleanups.pop()!();
});

describe("planImport", () => {
  test("a corpus directory with mail/, calendar/ and notes/ maps each subdir", () => {
    expect(planImport(ACME)).toEqual([
      { source: "mail", path: join(ACME, "mail") },
      { source: "calendar", path: join(ACME, "calendar") },
      { source: "notes", path: join(ACME, "notes") },
    ]);
  });

  test("single files map by extension", () => {
    expect(planImport(join(ACME, "mail/001-intro-priya-marcus.eml"))).toEqual([
      { source: "mail", path: join(ACME, "mail/001-intro-priya-marcus.eml") },
    ]);
    expect(planImport("calendar/acme.ics", ACME)).toEqual([{ source: "calendar", path: join(ACME, "calendar/acme.ics") }]);
    expect(planImport(join(ACME, "notes/2026-06-16-discovery-call.md"))[0]?.source).toBe("notes");
  });

  test("a directory of files maps by the extensions it contains", () => {
    expect(planImport(join(ACME, "mail"))).toEqual([{ source: "mail", path: join(ACME, "mail") }]);
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFileSync(join(dir, "a.mbox"), "");
    writeFileSync(join(dir, "b.ics"), "");
    writeFileSync(join(dir, "c.txt"), "");
    expect(planImport(dir).map((s) => s.source)).toEqual(["mail", "calendar"]);
  });

  test("unknown and missing paths throw", () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeFileSync(join(dir, "x.txt"), "");
    expect(() => planImport(join(dir, "x.txt"))).toThrow(/don't know how to import/);
    expect(() => planImport(dir)).toThrow(/nothing to import/);
    expect(() => planImport(join(dir, "nope"))).toThrow(/no such file/);
  });
});

describe("yrm import without source extensions", () => {
  test("names the package to install and exits non-zero", async () => {
    const { dir, cleanup } = tempDir();
    cleanups.push(cleanup);
    writeConfig(dir);
    const r = await cli(["import", ACME], { cwd: dir });
    expect(r.code).toBe(1);
    expect(r.stderr).toContain("install @yrm/ext-mail");
    expect(r.stderr).toContain("install @yrm/ext-calendar");
    expect(r.stderr).toContain("install @yrm/ext-notes");
  });
});
