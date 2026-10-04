import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { findConfigFile, loadConfig, normalizeConfig, systemTimezone } from "./config.ts";
import { ConfigError } from "./errors.ts";

let root: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yrm-config-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
});

describe("loadConfig", () => {
  it("finds yrm.config.ts in a parent directory and fills defaults", async () => {
    writeFileSync(
      join(root, "yrm.config.ts"),
      `export default { tenant: { selfAddresses: ["Jack@Example.com"], selfDomains: ["Example.com"] }, extensions: ["./x.ts"] };\n`,
    );
    const nested = join(root, "a", "b");
    mkdirSync(nested, { recursive: true });

    const { config, file, root: found } = await loadConfig(nested);
    expect(file).toBe(join(root, "yrm.config.ts"));
    expect(found).toBe(root);
    expect(config.tenant.id).toBe("local");
    expect(config.tenant.selfAddresses).toEqual(["jack@example.com"]);
    expect(config.tenant.selfDomains).toEqual(["example.com"]);
    expect(config.tenant.timezone).toBe(systemTimezone());
    expect(config.storage).toEqual({ driver: "sqlite", path: join(root, ".yrm/local/yrm.sqlite") });
    expect(config.models.routes).toEqual({} as typeof config.models.routes);
    expect(config.extensions).toEqual(["./x.ts"]);
  });

  it("reads yrm.config.json", async () => {
    writeFileSync(join(root, "yrm.config.json"), JSON.stringify({ tenant: { id: "acme", selfAddresses: [], timezone: "UTC" } }));
    const { config } = await loadConfig(root);
    expect(config.tenant.id).toBe("acme");
    expect(config.tenant.timezone).toBe("UTC");
  });

  it("throws ConfigError when tenant is missing", async () => {
    writeFileSync(join(root, "yrm.config.ts"), `export default { storage: { driver: "sqlite" } };\n`);
    const err = await loadConfig(root).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ConfigError);
    expect((err as Error).message).toContain('missing required "tenant"');
    expect((err as Error).message).toContain("yrm.config.ts");
  });

  it("throws ConfigError when no config exists", async () => {
    expect(findConfigFile(root)).toBeNull();
    await expect(loadConfig(root)).rejects.toBeInstanceOf(ConfigError);
  });
});

describe("normalizeConfig", () => {
  it("validates field types with readable messages", () => {
    expect(() => normalizeConfig({ tenant: { selfAddresses: "me@x.com" } })).toThrow('"tenant.selfAddresses" must be an array of strings');
    expect(() => normalizeConfig({ tenant: {}, models: { routes: { triage: [{ provider: "x" }] } } })).toThrow(
      '"models.routes.triage[0]" needs string "provider" and "model"',
    );
    expect(() => normalizeConfig({ tenant: {}, storage: { driver: "postgres" } })).toThrow('"storage.url" is required');
    expect(() => normalizeConfig("nope")).toThrow(ConfigError);
  });

  it("keeps an explicit absolute sqlite path", () => {
    const c = normalizeConfig({ tenant: {}, storage: { driver: "sqlite", path: "/var/yrm.db" } }, { root: "/proj" });
    expect(c.storage.path).toBe("/var/yrm.db");
  });

  it("reads models.cooldownMs and rejects a negative one", () => {
    expect(normalizeConfig({ tenant: {}, models: { routes: {}, cooldownMs: 5000 } }).models.cooldownMs).toBe(5000);
    expect(normalizeConfig({ tenant: {}, models: { routes: {} } }).models.cooldownMs).toBeUndefined();
    expect(() => normalizeConfig({ tenant: {}, models: { routes: {}, cooldownMs: -1 } })).toThrow('"models.cooldownMs" must be a non-negative number');
  });
});
