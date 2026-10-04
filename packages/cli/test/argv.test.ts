import { describe, expect, test } from "bun:test";
import { flagList, parseArgv } from "../src/argv.ts";

describe("parseArgv", () => {
  test("positionals and flag forms", () => {
    const p = parseArgv(["facts", "priya", "--at=2026-06-03", "--as-of", "2026-09-01", "--all"]);
    expect(p.positionals).toEqual(["facts", "priya"]);
    expect(p.flags).toEqual({ at: "2026-06-03", "as-of": "2026-09-01", all: true });
  });

  test("boolean flags never swallow the next positional", () => {
    const p = parseArgv(["who", "--facts", "marcus"]);
    expect(p.positionals).toEqual(["who", "marcus"]);
    expect(p.flags["facts"]).toBe(true);
  });

  test("a value flag does not consume another flag", () => {
    const p = parseArgv(["today", "--date", "--json"]);
    expect(p.flags).toEqual({ date: true, json: true });
  });

  test("--no-x sets false", () => {
    expect(parseArgv(["import", "a", "--no-extract"]).flags).toEqual({ extract: false });
  });

  test("repeated flags keep every value, last wins in flags", () => {
    const p = parseArgv(["init", "--self", "a@x.example", "--self=b@x.example,c@x.example"]);
    expect(p.flags["self"]).toBe("b@x.example,c@x.example");
    expect(flagList(p, "self")).toEqual(["a@x.example", "b@x.example", "c@x.example"]);
  });

  test("-- ends flag parsing and -h is help", () => {
    const p = parseArgv(["-h", "who", "--", "--weird-name"]);
    expect(p.flags["help"]).toBe(true);
    expect(p.positionals).toEqual(["who", "--weird-name"]);
  });

  test("empty argv", () => {
    expect(parseArgv([])).toEqual({ positionals: [], flags: {}, multi: {} });
  });
});
