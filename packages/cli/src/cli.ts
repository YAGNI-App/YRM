import { createLogger, findConfigFile, type Command, type CommandContext, type LogLevel, type LogSink } from "@yrm/core";
import { parseArgv } from "./argv.ts";
import { bootstrap, type BootstrapOptions } from "./bootstrap.ts";
import { builtinCommands, cliExtension, cliManifest } from "./commands/index.ts";
import type { CliEnv, FetchLike } from "./env.ts";
import { createStyle, table } from "./format.ts";
// The release version lives in the root package.json (ADR 0011); the bundler inlines it into the binary.
import root from "../../../package.json" with { type: "json" };

export const VERSION: string = root.version;

export interface RunCliOptions {
  cwd?: string;
  stdout?: (line: string) => void;
  stderr?: (line: string) => void;
  /** ANSI styling. Defaults to whether stdout is a TTY. */
  color?: boolean;
  env?: Record<string, string | undefined>;
  /** Used by `doctor` to probe endpoints. */
  fetch?: FetchLike;
  /** Passed to the extension loader; `null` skips `~/.yrm/extensions`. */
  homeDir?: string | null;
  /** Override the builtin extension list (tests). */
  builtins?: readonly string[];
}

const LEVELS = new Set<LogLevel>(["debug", "info", "warn", "error", "silent"]);

function humanSink(write: (line: string) => void): LogSink {
  return (r) => {
    const data = r.data && Object.keys(r.data).length > 0 ? ` ${JSON.stringify(r.data)}` : "";
    write(`[${r.level}]${r.scope ? ` ${r.scope}:` : ""} ${r.msg}${data}`);
  };
}

function helpLines(commands: Array<Pick<Command, "name" | "description">>, hasConfig: boolean): string[] {
  const lines = [
    "yrm: an open context layer for relationships",
    "",
    "usage: yrm <command> [args] [--flags]",
    "",
    "commands:",
    ...table(
      [...commands].sort((a, b) => a.name.localeCompare(b.name)).map((c) => [c.name, c.description]),
      { indent: "  " },
    ),
    "",
    "global flags: --verbose (debug logs), --quiet, --help",
    "run `yrm <command> --help` for a command's usage",
  ];
  if (!hasConfig) lines.push("", "no yrm.config.ts found here; start with `yrm init`");
  return lines;
}

/**
 * Run the CLI in-process and return its exit code. `main.ts` is a thin
 * wrapper over this; tests call it directly.
 */
export async function runCli(argv: readonly string[], opts: RunCliOptions = {}): Promise<number> {
  const stdout = opts.stdout ?? ((l: string) => void process.stdout.write(`${l}\n`));
  const stderr = opts.stderr ?? ((l: string) => void process.stderr.write(`${l}\n`));
  const env = opts.env ?? process.env;
  const parsed = parseArgv(argv);
  const cwd = opts.cwd ?? process.cwd();

  const envLevel = env["YRM_LOG"] as LogLevel | undefined;
  const level: LogLevel =
    parsed.flags["verbose"] === true ? "debug" : parsed.flags["quiet"] === true ? "error" : envLevel && LEVELS.has(envLevel) ? envLevel : "warn";
  const log = createLogger(level, humanSink(stderr));

  const cli: CliEnv = {
    cwd,
    parsed,
    stdout,
    stderr,
    style: createStyle(opts.color ?? process.stdout.isTTY === true),
    env,
    fetch: opts.fetch ?? ((input, init) => fetch(input, init)),
  };
  const builtins = builtinCommands(cli);

  let [name, ...args] = parsed.positionals;
  if (name === "help") {
    name = args[0];
    args = [];
    if (name) parsed.flags["help"] = true;
  }
  const hasConfig = findConfigFile(cwd) !== null;

  try {
    if (parsed.flags["version"] === true && name === undefined) {
      stdout(`yrm ${VERSION}`);
      return 0;
    }

    if (name === undefined) {
      // With a config, help lists extension commands too; without one, built-ins only.
      let commands: Array<Pick<Command, "name" | "description">> = builtins;
      if (hasConfig) {
        const boot = await bootstrap(bootOptions(cwd, log, opts));
        try {
          await boot.host.use(cliExtension(builtins, boot.host.registry), cliManifest);
          commands = boot.host.registry.commands.list();
        } finally {
          await boot.host.close();
        }
      }
      for (const l of helpLines(commands, hasConfig)) stdout(l);
      return 0;
    }

    const builtin = builtins.find((c) => c.name === name);
    // Usage for built-ins needs no host; extension commands fall through to boot.
    if (builtin && parsed.flags["help"] === true && !hasConfig) return await runCommand(builtin, args, cli, log);

    const local = builtin && !builtin.needsHost ? builtin : undefined;
    if (!local && !hasConfig) {
      if (builtins.some((c) => c.name === name)) {
        stderr(`no yrm.config.ts found in ${cwd} or any parent; run \`yrm init\` first`);
      } else {
        stderr(`unknown command "${name}"`);
        for (const l of helpLines(builtins, false)) stderr(l);
      }
      return 1;
    }

    if (local) return await runCommand(local, args, cli, log);

    const boot = await bootstrap(bootOptions(cwd, log, opts));
    try {
      cli.boot = boot;
      await boot.host.use(cliExtension(builtins, boot.host.registry), cliManifest);
      const command = boot.host.registry.commands.get(name);
      if (!command) {
        stderr(`unknown command "${name}"`);
        for (const l of helpLines(boot.host.registry.commands.list(), true)) stderr(l);
        return 1;
      }
      return await runCommand(command, args, cli, log);
    } finally {
      await boot.host.close();
    }
  } catch (err) {
    stderr(`error: ${err instanceof Error ? err.message : String(err)}`);
    if (level === "debug" && err instanceof Error && err.stack) stderr(err.stack);
    return 1;
  }
}

function bootOptions(cwd: string, log: ReturnType<typeof createLogger>, opts: RunCliOptions): BootstrapOptions {
  const b: BootstrapOptions = { cwd, log, needConfig: true };
  if (opts.homeDir !== undefined) b.homeDir = opts.homeDir;
  if (opts.builtins !== undefined) b.builtins = opts.builtins;
  return b;
}

async function runCommand(command: Command, args: string[], cli: CliEnv, log: ReturnType<typeof createLogger>): Promise<number> {
  if (cli.parsed.flags["help"] === true) {
    cli.stdout(`${command.name}: ${command.description}`);
    cli.stdout(`usage: ${command.usage ?? `yrm ${command.name}`}`);
    return 0;
  }
  const host = cli.boot?.host;
  const ctx: CommandContext = {
    tenantId: host?.config.tenant.id ?? "local",
    args,
    flags: cli.parsed.flags,
    // init runs without a host; it never touches store or models.
    store: host?.store ?? unavailable("store"),
    models: host?.models ?? unavailable("models"),
    stdout: cli.stdout,
    stderr: cli.stderr,
    log: log.prefix(command.name),
  };
  const code = await command.run(ctx);
  return typeof code === "number" ? code : 0;
}

function unavailable<T extends object>(what: string): T {
  return new Proxy({} as T, {
    get() {
      throw new Error(`${what} is not available before \`yrm init\``);
    },
  });
}
