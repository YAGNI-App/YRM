import type { Command, CommandContext } from "@yrm/core";
import type { ParsedArgs } from "./argv.ts";
import type { Booted } from "./bootstrap.ts";
import type { Style } from "./format.ts";

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

/**
 * What the built-in commands close over. `CommandContext` is the contract for
 * extension commands; built-ins also need the host and the full parsed argv
 * (repeatable flags), so they read those from here.
 */
export interface CliEnv {
  cwd: string;
  parsed: ParsedArgs;
  stdout: (line: string) => void;
  stderr: (line: string) => void;
  style: Style;
  env: Record<string, string | undefined>;
  fetch: FetchLike;
  /** Set once a host is running; commands that need one call `booted(env)`. */
  boot?: Booted;
}

export type BuiltinCommand = Command & {
  /** Whether the command can run without a config file (only `init`). */
  needsHost: boolean;
};

export function booted(env: CliEnv): Booted {
  if (!env.boot) throw new Error("this command needs a yrm.config.ts; run `yrm init` first");
  return env.boot;
}

export type { CommandContext };
