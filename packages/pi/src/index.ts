// Node-safe entry point. pi runs on Node >= 22.19 or as a Bun-compiled
// binary; YRM's store needs bun:sqlite. Everything that imports @yrm/core is
// behind a dynamic import taken only on Bun.
import type { BootHost } from "./host.ts";
import { locateConfig, registerInitOnly, registerMcpMode, resolveCliMain, runningOnBun } from "./mcp-mode.ts";
import type { PiExtensionAPI } from "./pi-types.ts";

export {
  CONFIG_FILES,
  initGuidance,
  locateConfig,
  MCP_SERVER_NAME,
  MCP_TOOL_EXPOSURE,
  mcpJsonSnippet,
  mcpServerConfig,
  resolveCliMain,
  runningOnBun,
} from "./mcp-mode.ts";
export type * from "./pi-types.ts";

export type YrmPiMode = "in-process" | "mcp" | "init";

export interface YrmPiOptions {
  /** Where to look for yrm.config.ts (walking up). Default `process.cwd()`, which is pi's working directory. */
  cwd?: string;
  /** Override runtime detection (tests). */
  bun?: boolean;
  /** Boot the host yourself (tests, embedding). Default: `bootstrap` from `@yrm/cli` for the config found. */
  boot?: BootHost;
  /** `@yrm/cli`'s main.ts for MCP mode. Default: resolved from this package; `yrm` on PATH if that fails. */
  cliMain?: string | null;
  /** Called with the mode chosen at load, for diagnostics and tests. */
  onMode?: (mode: YrmPiMode) => void;
}

export function createYrmPiExtension(options: YrmPiOptions = {}): (pi: PiExtensionAPI) => Promise<void> {
  return async (pi) => {
    const cwd = options.cwd ?? process.cwd();
    const configFile = locateConfig(cwd);
    if (!configFile && !options.boot) {
      registerInitOnly(pi, cwd);
      options.onMode?.("init");
      return;
    }
    if (!(options.bun ?? runningOnBun())) {
      if (!configFile) throw new Error("@yrm/pi: MCP mode needs a yrm.config.ts to point the server at");
      registerMcpMode(pi, configFile, options.cliMain !== undefined ? options.cliMain : resolveCliMain());
      options.onMode?.("mcp");
      return;
    }
    const { registerInProcess } = await import("./in-process.ts");
    const boot = options.boot ?? (await import("./host.ts")).bootFromConfig(cwd);
    registerInProcess(pi, { boot });
    options.onMode?.("in-process");
  };
}

/** The pi extension: `extensions/yrm.ts` re-exports this. */
const yrmPiExtension = createYrmPiExtension();
export default yrmPiExtension;
