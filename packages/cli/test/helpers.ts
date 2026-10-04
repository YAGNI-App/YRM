import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runCli, type RunCliOptions } from "../src/cli.ts";

export interface Captured {
  code: number;
  out: string[];
  err: string[];
  stdout: string;
  stderr: string;
}

/** A fetch that always fails like a closed port, instantly. */
export const refusedFetch = async (): Promise<Response> => {
  throw Object.assign(new Error("Unable to connect"), { code: "ConnectionRefused" });
};

export async function cli(argv: string[], opts: RunCliOptions & { cwd: string }): Promise<Captured> {
  const out: string[] = [];
  const err: string[] = [];
  const code = await runCli(argv, {
    homeDir: null,
    builtins: [],
    color: false,
    env: {},
    fetch: refusedFetch,
    stdout: (l) => out.push(l),
    stderr: (l) => err.push(l),
    ...opts,
  });
  return { code, out, err, stdout: out.join("\n"), stderr: err.join("\n") };
}

export function tempDir(prefix = "yrm-cli-"): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

/** A minimal plain-object config (no @yrm/core import, so it loads from any directory). */
export function writeConfig(dir: string, extra = "", extraProviders = ""): void {
  writeFileSync(
    join(dir, "yrm.config.ts"),
    `export default {
  tenant: { id: "local", name: "Jack", selfAddresses: ["jack@yagni.example"], timezone: "UTC" },
  storage: { driver: "sqlite", path: ".yrm/local/yrm.sqlite" },
  models: { routes: {
    triage: [{ provider: "openai-compatible", model: "qwen3:8b" }],
    synthesize: [{ provider: "anthropic", model: "claude-opus-5" }],
  } },
  providers: { "openai-compatible": { baseUrl: "http://127.0.0.1:9/v1" }, ${extraProviders} },
  ${extra}
};
`,
  );
}

export function writeExtension(dir: string, name: string, source: string): void {
  const extDir = join(dir, ".yrm", "extensions");
  mkdirSync(extDir, { recursive: true });
  writeFileSync(join(extDir, `${name}.ts`), source);
}
