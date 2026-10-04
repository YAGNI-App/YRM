import { afterEach, beforeEach, describe, expect, it } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { YrmConfig } from "../contracts/index.ts";
import { FakeRouter } from "../testing/fake-router.ts";
import { MemoryStore } from "../testing/memory-store.ts";
import { ExtensionError } from "./errors.ts";
import { createHost } from "./index.ts";
import { silentLogger } from "./logger.ts";

const config = (extra: Partial<YrmConfig> = {}): YrmConfig => ({
  tenant: { id: "local", selfAddresses: [] },
  storage: { driver: "sqlite", path: ":memory:" },
  models: { routes: {} as YrmConfig["models"]["routes"] },
  ...extra,
});

/** A self-contained extension module: no imports, so it loads from any temp dir. */
const extensionSource = (command: string, manifestName?: string) => `
${manifestName ? `export const manifest = { name: ${JSON.stringify(manifestName)}, version: "1.0.0" };` : ""}
export default function (yrm) {
  yrm.registerCommand({ name: ${JSON.stringify(command)}, description: "test", run: async () => 0 });
  yrm.events.emit("loaded", { name: yrm.manifest.name, setting: yrm.config.get("greeting") ?? null });
}
`;

let root: string;
let home: string;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "yrm-loader-"));
  home = mkdtempSync(join(tmpdir(), "yrm-home-"));
});

afterEach(() => {
  rmSync(root, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

function write(path: string, content: string): string {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, content);
  return path;
}

describe("loader", () => {
  it("loads explicit, project and home extensions in that order", async () => {
    write(join(root, "ext", "explicit.ts"), extensionSource("from-explicit", "explicit-ext"));
    write(join(root, ".yrm", "extensions", "proj.ts"), extensionSource("from-project"));
    write(join(home, ".yrm", "extensions", "homey.ts"), extensionSource("from-home"));

    const host = createHost(config({ settings: { proj: { greeting: "hi" } } }), {
      store: new MemoryStore(),
      models: new FakeRouter(),
      log: silentLogger,
      projectRoot: root,
    });
    const seen: unknown[] = [];
    host.events.on("loaded", (p) => seen.push(p));

    const loaded = await host.loadExtensions(["./ext/explicit.ts"], { homeDir: home });
    expect(loaded.map((l) => [l.manifest.name, l.origin])).toEqual([
      ["explicit-ext", "explicit"],
      ["proj", "project"],
      ["homey", "home"],
    ]);
    expect(loaded[0]!.manifest.version).toBe("1.0.0");
    expect(loaded[1]!.path).toBe(join(root, ".yrm", "extensions", "proj.ts"));
    expect(host.registry.commands.list().map((c) => c.name)).toEqual(["from-explicit", "from-project", "from-home"]);
    expect(host.registry.commands.owner("from-project")).toBe("proj");
    expect(seen).toEqual([
      { name: "explicit-ext", setting: null },
      { name: "proj", setting: "hi" },
      { name: "homey", setting: null },
    ]);
    expect(host.extensions).toHaveLength(3);
  });

  it("loads an explicit absolute path", async () => {
    const path = write(join(root, "abs.ts"), extensionSource("abs-cmd"));
    const host = createHost(config(), { store: new MemoryStore(), models: new FakeRouter(), log: silentLogger, projectRoot: root });
    const loaded = await host.loadExtensions([path], { homeDir: null });
    expect(loaded).toEqual([{ manifest: { name: "abs" }, path, origin: "explicit" }]);
    expect(host.registry.commands.has("abs-cmd")).toBe(true);
  });

  it("respects config.disable by derived name or manifest name", async () => {
    write(join(root, ".yrm", "extensions", "off.ts"), extensionSource("off-cmd"));
    write(join(root, ".yrm", "extensions", "renamed.ts"), extensionSource("renamed-cmd", "named-off"));
    write(join(root, ".yrm", "extensions", "on.ts"), extensionSource("on-cmd"));
    const host = createHost(config({ disable: ["off", "named-off"] }), {
      store: new MemoryStore(),
      models: new FakeRouter(),
      log: silentLogger,
      projectRoot: root,
    });
    const loaded = await host.loadExtensions([], { homeDir: null });
    expect(loaded.map((l) => l.manifest.name)).toEqual(["on"]);
    expect(host.registry.commands.list().map((c) => c.name)).toEqual(["on-cmd"]);
  });

  it("gives a clear error when the default export is missing", async () => {
    write(join(root, "nodefault.ts"), `export const manifest = { name: "nodefault" };\nexport function setup() {}\n`);
    const host = createHost(config(), { store: new MemoryStore(), models: new FakeRouter(), log: silentLogger, projectRoot: root });
    const err = await host.loadExtensions(["./nodefault.ts"], { homeDir: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionError);
    expect((err as Error).message).toContain("must default-export a factory function");
    expect((err as Error).message).toContain("nodefault.ts");
  });

  it("rejects duplicate registrations across extensions", async () => {
    write(join(root, ".yrm", "extensions", "a.ts"), extensionSource("same"));
    write(join(root, ".yrm", "extensions", "b.ts"), extensionSource("same"));
    const host = createHost(config(), { store: new MemoryStore(), models: new FakeRouter(), log: silentLogger, projectRoot: root });
    const err = await host.loadExtensions([], { homeDir: null }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ExtensionError);
    expect((err as Error).message).toContain('duplicate command "same"');
  });
});
