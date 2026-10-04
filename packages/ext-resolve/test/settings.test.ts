import { describe, expect, it } from "bun:test";
import { createConfigReader, type YrmConfig } from "@yrm/core";
import { readSettings } from "../src/settings.ts";

const base: YrmConfig = {
  tenant: { id: "local", name: "Jack", selfAddresses: ["jack@yagni.example"], selfDomains: ["Yagni.example"] },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} },
};

describe("resolve settings", () => {
  it("falls back to tenant.selfDomains", () => {
    const s = readSettings(createConfigReader(base, "resolve"));
    expect(s.selfDomains).toEqual(["yagni.example"]);
    // tenant.name is the person, not the company.
    expect(s.selfOrgName).toBeUndefined();
  });

  it("lets settings.resolve override, including with an empty list", () => {
    const withSettings = (resolve: Record<string, unknown>) => readSettings(createConfigReader({ ...base, settings: { resolve } }, "resolve"));
    expect(withSettings({ selfDomains: ["other.example"], selfOrgName: "YAGNI" })).toMatchObject({
      selfDomains: ["other.example"],
      selfOrgName: "YAGNI",
    });
    expect(withSettings({ selfDomains: [] }).selfDomains).toEqual([]);
  });
});
