import type { BuiltinCommand, CliEnv } from "../env.ts";

/**
 * Fallback for `yrm serve`. Built-in commands register after extensions and
 * never replace one, so when `@yrm/ext-mcp` registers `serve` this is skipped.
 */
export function serveCommand(_env: CliEnv): BuiltinCommand {
  return {
    name: "serve",
    description: "Serve YRM to agents over MCP (requires @yrm/ext-mcp)",
    usage: "yrm serve",
    needsHost: true,
    async run(ctx) {
      ctx.stderr("yrm serve needs the MCP server extension: install @yrm/ext-mcp (bun add @yrm/ext-mcp)");
      return 1;
    },
  };
}
