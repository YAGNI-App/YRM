import { afterEach, describe, expect, test } from "bun:test";
import { HOST_READY_TOPIC, silentLogger } from "@yrm/core";
import { bootstrap, type Booted } from "../src/bootstrap.ts";
import { tempDir, writeConfig } from "./helpers.ts";

let cleanup = () => {};
let boot: Booted | undefined;

afterEach(async () => {
  await boot?.host.close();
  boot = undefined;
  cleanup();
});

describe("host binding after bootstrap", () => {
  test("ext-mcp's host-backed tools work without any extra wiring", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeConfig(t.dir);
    boot = await bootstrap({ cwd: t.dir, log: silentLogger, homeDir: null, builtins: ["@yrm/ext-mcp"] });
    const { host } = boot;

    const today = host.registry.tools.get("yrm_today");
    expect(today).toBeDefined();
    const ctx = { tenantId: host.config.tenant.id, store: host.store, models: host.models, log: silentLogger };
    // Throws MCP_HOST_NOT_BOUND if host.start() did not announce the host.
    const out = (await today!.run({ date: "2026-10-03" }, ctx)) as { date?: string };
    expect(out.date).toBe("2026-10-03");
  });

  test("host.start() emits host:ready with the host, once", async () => {
    const t = tempDir();
    cleanup = t.cleanup;
    writeConfig(t.dir);
    const seen: unknown[] = [];
    boot = await bootstrap({
      cwd: t.dir,
      log: silentLogger,
      homeDir: null,
      builtins: ["@test/listener"],
      importModule: async () => ({
        manifest: { name: "listener" },
        default: (yrm: { events: { on(topic: string, h: (p: unknown) => void): void } }) => {
          yrm.events.on(HOST_READY_TOPIC, (p) => seen.push(p));
        },
      }),
    });
    await boot.host.start();
    expect(seen).toEqual([boot.host]);
  });
});
