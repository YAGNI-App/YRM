/**
 * A deliberately small argv parser. Supports positionals, `--flag`,
 * `--flag=value`, `--flag value`, `--no-flag` (sets false), repeated flags,
 * `-h`, and `--` to end flag parsing.
 *
 * `--flag value` is ambiguous with "boolean flag followed by a positional", so
 * flags named in `booleans` never consume the next token. Flags not in that
 * set take the next token as their value unless it starts with `-`.
 */
export interface ParsedArgs {
  positionals: string[];
  /** Last value wins for repeated flags; what `CommandContext.flags` receives. */
  flags: Record<string, string | boolean>;
  /** Every value of every flag, in order, for repeatable flags like `--self`. */
  multi: Record<string, Array<string | boolean>>;
}

/** Boolean flags understood by the built-in commands. Extension commands may add more. */
export const BOOLEAN_FLAGS: ReadonlySet<string> = new Set([
  "help",
  "json",
  "facts",
  "all",
  "force",
  "extract",
  "verbose",
  "quiet",
  "version",
  "mcp",
  "dry-run",
  "live",
]);

export function parseArgv(argv: readonly string[], booleans: ReadonlySet<string> = BOOLEAN_FLAGS): ParsedArgs {
  const out: ParsedArgs = { positionals: [], flags: {}, multi: {} };
  const set = (name: string, value: string | boolean): void => {
    out.flags[name] = value;
    (out.multi[name] ??= []).push(value);
  };

  for (let i = 0; i < argv.length; i++) {
    const tok = argv[i]!;
    if (tok === "--") {
      out.positionals.push(...argv.slice(i + 1));
      break;
    }
    if (tok === "-h") {
      set("help", true);
      continue;
    }
    if (!tok.startsWith("--") || tok.length === 2) {
      out.positionals.push(tok);
      continue;
    }
    const body = tok.slice(2);
    const eq = body.indexOf("=");
    if (eq >= 0) {
      set(body.slice(0, eq), body.slice(eq + 1));
      continue;
    }
    if (body.startsWith("no-") && body.length > 3) {
      set(body.slice(3), false);
      continue;
    }
    const next = argv[i + 1];
    if (!booleans.has(body) && next !== undefined && !next.startsWith("-")) {
      set(body, next);
      i++;
      continue;
    }
    set(body, true);
  }
  return out;
}

/** All string values given for a repeatable flag; also splits comma lists. */
export function flagList(parsed: ParsedArgs, name: string): string[] {
  return (parsed.multi[name] ?? [])
    .filter((v): v is string => typeof v === "string")
    .flatMap((v) => v.split(","))
    .map((v) => v.trim())
    .filter((v) => v.length > 0);
}

/** A flag's string value, or undefined when absent or given as a bare boolean. */
export function flagString(flags: Record<string, string | boolean>, name: string): string | undefined {
  const v = flags[name];
  return typeof v === "string" ? v : undefined;
}
