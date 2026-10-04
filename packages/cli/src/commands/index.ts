import type { ExtensionFactory, ExtensionManifest, Registry } from "@yrm/core";
import type { BuiltinCommand, CliEnv } from "../env.ts";
import { doctorCommand } from "./doctor.ts";
import { confirmCommand, mergeCommand, rejectCommand } from "./entity-actions.ts";
import { factsCommand } from "./facts.ts";
import { importCommand } from "./import.ts";
import { initCommand } from "./init.ts";
import { serveCommand } from "./serve.ts";
import { syncCommand } from "./sync.ts";
import { todayCommand } from "./today.ts";
import { whoCommand } from "./who.ts";

export function builtinCommands(env: CliEnv): BuiltinCommand[] {
  return [
    initCommand(env),
    importCommand(env),
    syncCommand(env),
    todayCommand(env),
    whoCommand(env),
    factsCommand(env),
    confirmCommand(env),
    rejectCommand(env),
    mergeCommand(env),
    doctorCommand(env),
    serveCommand(env),
  ];
}

export const cliManifest: ExtensionManifest = {
  name: "cli",
  version: "0.1.0",
  description: "Built-in yrm commands.",
};

/**
 * Registers the built-in commands as an extension so they sit in the same
 * registry as extension commands. Runs after extensions load; a name an
 * extension already registered (e.g. `serve` from @yrm/ext-mcp) is left to it.
 */
export function cliExtension(commands: BuiltinCommand[], registry: Registry): ExtensionFactory {
  return (yrm) => {
    for (const c of commands) {
      if (registry.commands.has(c.name)) {
        yrm.log.debug("command provided by an extension; skipping built-in", { command: c.name, by: registry.commands.owner(c.name) });
        continue;
      }
      yrm.registerCommand(c);
    }
  };
}
