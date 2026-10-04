// Node-safe: this module and everything it imports must load without Bun,
// because it is the path pi takes when it runs on Node.
import { existsSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import type { PiContext, PiExtensionAPI, PiMcpServerConfig } from "./pi-types.ts";

/** Mirrors `CONFIG_FILES` in `@yrm/core` (a test keeps them equal); core itself needs Bun to import. */
export const CONFIG_FILES = ["yrm.config.ts", "yrm.config.js", "yrm.config.json"] as const;

/** Walk from `cwd` up to the filesystem root looking for a YRM config, like `findConfigFile` in core. */
export function locateConfig(cwd: string): string | null {
  let dir = resolve(cwd);
  for (;;) {
    for (const name of CONFIG_FILES) {
      const candidate = join(dir, name);
      if (existsSync(candidate)) return candidate;
    }
    const parent = dirname(dir);
    if (parent === dir) return null;
    dir = parent;
  }
}

/** True when pi runs on Bun (pi's compiled binary, or `bun` launching pi). */
export function runningOnBun(): boolean {
  return typeof (globalThis as { Bun?: unknown }).Bun !== "undefined";
}

/**
 * Where `yrm serve` lives: `@yrm/cli`'s `main.ts`, next to the module its
 * exports point at. Resolving does not load it, so this works on Node.
 */
export function resolveCliMain(from: string = import.meta.url): string | null {
  try {
    const entry = createRequire(from).resolve("@yrm/cli");
    const main = join(dirname(entry), "main.ts");
    return existsSync(main) ? main : null;
  } catch {
    // Not installed next to this package: the caller falls back to `yrm` on PATH.
    return null;
  }
}

export const MCP_SERVER_NAME = "yrm";

/**
 * Exposure per YRM tool over MCP, mirroring the in-process mode: the everyday
 * reads are declared, `yrm_facts` goes through codemode so a script filters
 * results before they reach context (ADR 0007), the rest are found by search.
 */
export const MCP_TOOL_EXPOSURE: Readonly<Record<string, "codemode" | "deferred" | "direct">> = {
  yrm_context: "direct",
  yrm_today: "direct",
  yrm_record_fact: "direct",
  yrm_facts: "codemode",
};

export function mcpServerConfig(root: string, cliMain: string | null): PiMcpServerConfig {
  const launch = cliMain ? { command: "bun", args: ["run", cliMain, "serve"] } : { command: "yrm", args: ["serve"] };
  return {
    ...launch,
    cwd: root,
    description: "YRM: facts about people, companies and deals from mail, meetings and notes, each with provenance.",
    exposure: "deferred",
    toolExposure: { ...MCP_TOOL_EXPOSURE },
  };
}

/** The `.pi/mcp.json` entry, for pi runtimes without `registerMcpServer`. */
export function mcpJsonSnippet(config: PiMcpServerConfig): string {
  const { command, args, cwd, toolExposure } = config;
  return JSON.stringify({ mcpServers: { [MCP_SERVER_NAME]: { command, args, cwd, exposure: "deferred", toolExposure } } }, null, 2);
}

export function initGuidance(cwd: string): string {
  return [
    `YRM: no yrm.config.ts found in ${cwd} or any parent directory.`,
    "Create one in your project root, then run /reload:",
    "  bunx yrm init            (or: bun run <path to YRM>/packages/cli/src/main.ts init)",
    "  bunx yrm import <mbox|ics|notes dir>",
  ].join("\n");
}

/** Show text to the user: a notification when pi has a UI, otherwise a transcript message. */
export function show(pi: PiExtensionAPI, ctx: PiContext, text: string): void {
  if (ctx.hasUI) ctx.ui.notify(text, "info");
  else pi.sendMessage({ customType: "yrm", content: text, display: true });
}

/** No config: only a `/yrm` command that explains how to create one. */
export function registerInitOnly(pi: PiExtensionAPI, cwd: string): void {
  pi.registerCommand("yrm", {
    description: "YRM is not set up here: show how to create yrm.config.ts",
    handler: async (_args, ctx) => show(pi, ctx, initGuidance(ctx.cwd || cwd)),
  });
}

export interface McpModeResult {
  registered: boolean;
  config: PiMcpServerConfig;
}

/**
 * Node mode: YRM's store needs `bun:sqlite`, so it cannot load inside a Node
 * pi. Run `yrm serve` as a child process under Bun and hand it to pi as an
 * MCP server; without `registerMcpServer`, tell the user what to put in
 * `.pi/mcp.json`.
 */
export function registerMcpMode(pi: PiExtensionAPI, configFile: string, cliMain: string | null): McpModeResult {
  const config = mcpServerConfig(dirname(configFile), cliMain);
  const registered = typeof pi.registerMcpServer === "function";
  if (registered) pi.registerMcpServer!(MCP_SERVER_NAME, config);

  const explain = (): string =>
    registered
      ? [
          "YRM runs as an MCP server here (pi is on Node; YRM's store needs Bun).",
          `Server "${MCP_SERVER_NAME}": ${config.command} ${(config.args ?? []).join(" ")}  (cwd ${config.cwd})`,
          "Tools are mcp__yrm__<name>; check the connection with /mcp. Run pi under Bun for the in-process mode with /yrm today|who|facts.",
        ].join("\n")
      : [
          "This pi cannot register MCP servers from an extension. Add YRM to .pi/mcp.json, then /reload:",
          mcpJsonSnippet(config),
        ].join("\n");

  pi.registerCommand("yrm", {
    description: "YRM over MCP: show how the server is connected",
    handler: async (_args, ctx) => show(pi, ctx, explain()),
  });
  if (!registered) {
    pi.on("session_start", (_event, ctx) => {
      if (ctx.hasUI) ctx.ui.notify("YRM: add the MCP server to .pi/mcp.json (run /yrm for the snippet).", "warning");
    });
  }
  return { registered, config };
}
