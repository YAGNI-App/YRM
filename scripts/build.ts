#!/usr/bin/env bun
// Compile the yrm CLI into a single executable per target (ADR 0011).
//
//   bun run scripts/build.ts                          # this machine -> dist/yrm-<target>
//   bun run scripts/build.ts --target bun-linux-x64   # cross-compile one target
//   bun run scripts/build.ts --all                    # every release target
//   bun run scripts/build.ts --outfile dist/yrm       # explicit output path (single target)
//
// Bun downloads the runtime for a foreign target on first use, so
// cross-compiling needs network once per target and nothing else.
import { mkdirSync, rmSync, statSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseArgs } from "node:util";
import root from "../package.json" with { type: "json" };

export const RELEASE_TARGETS = [
  "bun-linux-x64",
  "bun-linux-arm64",
  "bun-darwin-arm64",
  "bun-darwin-x64",
  "bun-windows-x64",
] as const satisfies readonly Bun.Build.CompileTarget[];

const REPO = resolve(import.meta.dir, "..");
const ENTRY = join(REPO, "packages/cli/src/main.ts");

export function hostTarget(): Bun.Build.CompileTarget {
  const os = process.platform === "win32" ? "windows" : process.platform;
  if (os !== "linux" && os !== "darwin" && os !== "windows") throw new Error(`no Bun compile target for platform ${process.platform}`);
  const arch = process.arch === "arm64" ? "arm64" : process.arch === "x64" ? "x64" : null;
  if (!arch) throw new Error(`no Bun compile target for arch ${process.arch}`);
  return `bun-${os}-${arch}`;
}

export function outfileFor(target: string): string {
  return join(REPO, "dist", `yrm-${target}${target.includes("windows") ? ".exe" : ""}`);
}

export async function compile(target: Bun.Build.CompileTarget, outfile: string): Promise<string> {
  mkdirSync(dirname(outfile), { recursive: true });
  const result = await Bun.build({
    entrypoints: [ENTRY],
    compile: {
      target,
      outfile,
      // Users keep API keys in .env next to yrm.config.ts, as with `bun run`.
      autoloadDotenv: true,
      // The binary is the runtime; a bunfig.toml in the user's project must not change it.
      autoloadBunfig: false,
    },
    // Identifiers stay unminified so error and class names read the same as from source.
    minify: { whitespace: true, syntax: true, identifiers: false },
    // Compiled executables embed the map, so stack traces point at the TypeScript source.
    sourcemap: "linked",
  });
  if (!result.success) {
    for (const log of result.logs) console.error(log);
    throw new Error(`build failed for ${target}`);
  }
  // The map is already inside the executable; the copy beside it is not a release asset.
  for (const map of [`${outfile}.map`, `${outfile.replace(/\.exe$/, "")}.map`]) rmSync(map, { force: true });
  return outfile;
}

if (import.meta.main) {
  const { values } = parseArgs({
    args: Bun.argv.slice(2),
    options: {
      target: { type: "string", multiple: true },
      all: { type: "boolean", default: false },
      outfile: { type: "string" },
    },
  });
  const targets = (values.all ? [...RELEASE_TARGETS] : (values.target ?? [hostTarget()])) as Bun.Build.CompileTarget[];
  if (values.outfile && targets.length !== 1) throw new Error("--outfile takes exactly one target");

  console.log(`yrm ${root.version}`);
  for (const target of targets) {
    const started = performance.now();
    const out = await compile(target, values.outfile ? resolve(values.outfile) : outfileFor(target));
    const mb = (statSync(out).size / 1024 / 1024).toFixed(1);
    console.log(`  ${target.padEnd(20)} ${out.replace(`${REPO}/`, "")}  ${mb} MB  ${Math.round(performance.now() - started)}ms`);
  }
}
