import { existsSync, readdirSync, statSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, extname, isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import type { ExtensionFactory, ExtensionManifest } from "../contracts/index.ts";
import { ExtensionError, messageOf } from "./errors.ts";
import { createExtensionAPI, type ExtensionApiDeps } from "./extension-api.ts";

export type ExtensionOrigin = "explicit" | "project" | "home";

export interface LoadedExtension {
  manifest: ExtensionManifest;
  /** Absolute file path, or the bare package specifier for packages. */
  path: string;
  origin: ExtensionOrigin;
}

export interface LoadOptions {
  /** Module specifiers or paths, loaded first and in order. Relative paths resolve against `projectRoot`. */
  specifiers?: string[];
  projectRoot: string;
  /** Defaults to the OS home directory. Pass `null` to skip `~/.yrm/extensions`. */
  homeDir?: string | null;
  /** Names or specifiers to skip. Defaults to `config.disable`. */
  disable?: string[];
  /** Names already loaded in this host; duplicates throw. */
  loaded?: Set<string>;
}

interface Candidate {
  specifier: string;
  /** What `import()` receives. */
  target: string;
  /** Shown to `yrm doctor`. */
  path: string;
  derivedName: string;
  origin: ExtensionOrigin;
}

/**
 * Load extensions in the documented order: explicit list, then the project's
 * `.yrm/extensions/*.ts`, then `~/.yrm/extensions/*.ts`. Each module's factory
 * runs before the next module is imported, so later extensions see earlier
 * registrations and their hooks run after earlier ones.
 */
export async function loadExtensions(deps: ExtensionApiDeps, opts: LoadOptions): Promise<LoadedExtension[]> {
  const disabled = new Set(opts.disable ?? deps.config.disable ?? []);
  const seen = opts.loaded ?? new Set<string>();
  const home = opts.homeDir === undefined ? homedir() : opts.homeDir;

  const candidates: Candidate[] = [
    ...(opts.specifiers ?? []).map((s) => explicitCandidate(s, opts.projectRoot)),
    ...dirCandidates(join(opts.projectRoot, ".yrm", "extensions"), "project"),
    ...(home ? dirCandidates(join(home, ".yrm", "extensions"), "home") : []),
  ];

  const out: LoadedExtension[] = [];
  for (const c of candidates) {
    // Check before import so a disabled extension's module side effects never run.
    if (disabled.has(c.derivedName) || disabled.has(c.specifier)) {
      deps.log.info("extension disabled", { name: c.derivedName, path: c.path });
      continue;
    }
    const mod = await importModule(c);
    const manifest = manifestOf(mod, c);
    if (disabled.has(manifest.name)) {
      deps.log.info("extension disabled", { name: manifest.name, path: c.path });
      continue;
    }
    if (seen.has(manifest.name)) {
      throw new ExtensionError(`extension "${manifest.name}" is loaded twice (second copy at ${c.path})`, manifest.name);
    }
    await applyExtension(deps, factoryOf(mod, c), manifest, seen);
    deps.log.debug("extension loaded", { name: manifest.name, path: c.path, origin: c.origin });
    out.push({ manifest, path: c.path, origin: c.origin });
  }
  return out;
}

/**
 * Run one factory against a fresh ExtensionAPI. Used by the loader and by
 * hosts that register in-process extensions (built-ins, embedding, tests).
 */
export async function applyExtension(
  deps: ExtensionApiDeps,
  factory: ExtensionFactory,
  manifest: ExtensionManifest,
  loaded: Set<string> = new Set(),
): Promise<void> {
  if (loaded.has(manifest.name)) {
    throw new ExtensionError(`extension "${manifest.name}" is loaded twice`, manifest.name);
  }
  loaded.add(manifest.name);
  try {
    await factory(createExtensionAPI(manifest, deps));
  } catch (err) {
    if (err instanceof ExtensionError) throw err;
    throw new ExtensionError(`extension "${manifest.name}" failed to initialize: ${messageOf(err)}`, manifest.name, {
      cause: err,
    });
  }
}

function isPathLike(spec: string): boolean {
  return spec.startsWith(".") || spec.startsWith("/") || isAbsolute(spec) || spec.startsWith("file:");
}

function explicitCandidate(specifier: string, projectRoot: string): Candidate {
  if (isPathLike(specifier)) {
    const abs = specifier.startsWith("file:") ? new URL(specifier).pathname : resolve(projectRoot, specifier);
    return { specifier, target: pathToFileURL(abs).href, path: abs, derivedName: nameFromPath(abs), origin: "explicit" };
  }
  // Bare package: resolve from the project so its own node_modules wins.
  let target = specifier;
  try {
    target = Bun.resolveSync(specifier, projectRoot);
  } catch {
    // Fall through to a plain import(), which reports a clearer error if it is truly missing.
  }
  return { specifier, target, path: specifier, derivedName: nameFromPackage(specifier), origin: "explicit" };
}

function dirCandidates(dir: string, origin: ExtensionOrigin): Candidate[] {
  if (!existsSync(dir) || !statSync(dir).isDirectory()) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".ts") && !f.endsWith(".d.ts") && !f.endsWith(".test.ts"))
    .sort()
    .map((f) => {
      const abs = join(dir, f);
      return { specifier: abs, target: pathToFileURL(abs).href, path: abs, derivedName: nameFromPath(abs), origin };
    });
}

/** `my-ranker.ts` -> `my-ranker`; `.../foo/index.ts` -> `foo`. */
function nameFromPath(path: string): string {
  const base = basename(path, extname(path));
  return base === "index" ? basename(dirname(path)) : base;
}

/** `@yrm/ext-mail` -> `ext-mail`; `@yrm/ext-mail/sub` -> `ext-mail`. */
function nameFromPackage(spec: string): string {
  const parts = spec.split("/");
  const pkg = spec.startsWith("@") ? parts[1] : parts[0];
  return pkg ?? spec;
}

async function importModule(c: Candidate): Promise<Record<string, unknown>> {
  try {
    return (await import(c.target)) as Record<string, unknown>;
  } catch (err) {
    throw new ExtensionError(`cannot import extension "${c.specifier}": ${messageOf(err)}`, c.derivedName, {
      cause: err,
    });
  }
}

function manifestOf(mod: Record<string, unknown>, c: Candidate): ExtensionManifest {
  const m = mod["manifest"];
  if (m === undefined) return { name: c.derivedName };
  if (typeof m !== "object" || m === null || typeof (m as { name?: unknown }).name !== "string") {
    throw new ExtensionError(`extension at ${c.path} exports a "manifest" without a string "name"`, c.derivedName);
  }
  return m as ExtensionManifest;
}

function factoryOf(mod: Record<string, unknown>, c: Candidate): ExtensionFactory {
  const f = mod["default"];
  if (typeof f !== "function") {
    throw new ExtensionError(
      `extension at ${c.path} must default-export a factory function (export default function (yrm) { ... }); got ${f === undefined ? "no default export" : typeof f}`,
      c.derivedName,
    );
  }
  return f as ExtensionFactory;
}
