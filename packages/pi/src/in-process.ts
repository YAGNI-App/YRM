// Bun only: loaded with a dynamic import after `runningOnBun()` says so.
import { AUTO_CONTEXT_BUDGET, AUTO_CONTEXT_SECTION, autoContextFor, piSettings } from "./auto-context.ts";
import { runYrmCommand } from "./commands.ts";
import { LazyHost, type BootHost } from "./host.ts";
import { show } from "./mcp-mode.ts";
import type { PiExtensionAPI } from "./pi-types.ts";
import { yrmTools } from "./tools.ts";

export interface InProcessOptions {
  boot: BootHost;
  /** Token budget for the automatic context section. */
  autoContextBudget?: number;
}

/**
 * Bun mode: YRM's host runs inside pi's process. Tools, the `/yrm` command
 * and the context hook share one lazily opened host, closed with the session.
 */
export function registerInProcess(pi: PiExtensionAPI, opts: InProcessOptions): LazyHost {
  const lazy = new LazyHost(opts.boot);
  const budget = opts.autoContextBudget ?? AUTO_CONTEXT_BUDGET;

  for (const tool of yrmTools(lazy)) pi.registerTool(tool);

  pi.registerCommand("yrm", {
    description: "YRM: today | who <query> | facts <entity> [--at] [--as-of]",
    handler: async (args, ctx) => show(pi, ctx, await runYrmCommand(await lazy.get(), args)),
  });

  pi.on("before_agent_start", async (event) => {
    const sections = event.systemPromptOptions?.sections;
    // Drop last run's brief so a prompt about someone else never inherits it.
    if (sections) delete sections[AUTO_CONTEXT_SECTION];
    const host = await lazy.get();
    if (piSettings(host).autoContext === false) return;
    const text = await autoContextFor(host, event.prompt, budget);
    if (text === null) return;
    if (sections) {
      sections[AUTO_CONTEXT_SECTION] = text;
      return;
    }
    // Runtimes without structured prompt sections get a hidden message instead.
    return { message: { customType: "yrm-context", content: text, display: false } };
  });

  pi.on("session_shutdown", () => lazy.close());
  return lazy;
}
