import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { YrmError, type Logger, type Tool, type ToolContext } from "@yrm/core";
import { toolInputSchema } from "./schema.ts";
import { SERVER_INSTRUCTIONS, STORY_MARKDOWN } from "./story.ts";

export const SERVER_NAME = "yrm";
export const SERVER_VERSION = "0.1.0";

export interface McpResources {
  /** Same JSON as yrm_get_entity. */
  entity(id: string): Promise<unknown>;
  /** Same JSON as yrm_today with no arguments. */
  today(): Promise<unknown>;
  /** Entities to advertise in resources/list. */
  listEntities(): Promise<Array<{ id: string; name: string; kind: string }>>;
}

export interface McpServerOptions {
  tools: Tool[];
  /** Build the context for one call. `client` is the MCP client's self-reported name, when known. */
  context(client: string | undefined): ToolContext;
  resources: McpResources;
  log: Logger;
  /**
   * False when the caller's token lacks the `write` scope: write tools stay
   * listed but refuse, even with `confirm: true`. Default true (stdio).
   */
  canWrite?: boolean;
}

export class WriteScopeRequiredError extends YrmError {
  constructor(tool: string) {
    super("WRITE_SCOPE_REQUIRED", `${tool} writes to YRM, and this connection's token has read-only access. Nothing was written.`);
  }
}

function json(value: unknown): string {
  return JSON.stringify(value);
}

/** A tool failure becomes an MCP tool error the agent can read and react to, never a crashed server. */
export function toolError(err: unknown): CallToolResult {
  const code = err instanceof YrmError ? err.code : err instanceof Error ? err.name : "ERROR";
  const message = err instanceof Error ? err.message : String(err);
  return { isError: true, content: [{ type: "text", text: json({ error: { code, message } }) }] };
}

/** MCP lists direct and deferred tools; codemode tools are only for sandboxed code and stay out. */
export function exposedTools(tools: Tool[]): Tool[] {
  return tools.filter((t) => (t.exposure ?? "direct") !== "codemode");
}

/**
 * Build an MCP server over YRM tools (every registered tool, not only this
 * extension's) and the yrm:// resources. Not connected; pass it to a transport.
 */
export function createMcpServer(opts: McpServerOptions): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: SERVER_INSTRUCTIONS });
  const client = (): string | undefined => server.server.getClientVersion()?.name;

  for (const tool of exposedTools(opts.tools)) {
    server.registerTool(
      tool.name,
      {
        description: tool.description,
        inputSchema: toolInputSchema(tool.inputSchema),
        annotations: { readOnlyHint: tool.readOnly, openWorldHint: false },
        _meta: { "yrm/exposure": tool.exposure ?? "direct" },
      },
      async (args: unknown): Promise<CallToolResult> => {
        try {
          if (!tool.readOnly && opts.canWrite === false) throw new WriteScopeRequiredError(tool.name);
          const out = await tool.run(args ?? {}, opts.context(client()));
          return { content: [{ type: "text", text: json(out ?? null) }] };
        } catch (err) {
          opts.log.warn("tool call failed", { tool: tool.name, error: err instanceof Error ? err.message : String(err) });
          return toolError(err);
        }
      },
    );
  }

  server.registerResource(
    "today",
    "yrm://today",
    { title: "Today's attention queue", description: "Same JSON as yrm_today with no arguments.", mimeType: "application/json" },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "application/json", text: json(await opts.resources.today()) }] }),
  );
  server.registerResource(
    "story",
    "yrm://story",
    {
      title: "How YRM works",
      description: "The data model (events, bi-temporal facts, provenance, entities) and which tool answers which question. Read first.",
      mimeType: "text/markdown",
    },
    async (uri) => ({ contents: [{ uri: uri.href, mimeType: "text/markdown", text: STORY_MARKDOWN }] }),
  );
  server.registerResource(
    "entity",
    new ResourceTemplate("yrm://entity/{id}", {
      list: async () => ({
        resources: (await opts.resources.listEntities()).map((e) => ({
          uri: `yrm://entity/${e.id}`,
          name: e.name,
          description: e.kind,
          mimeType: "application/json",
        })),
      }),
    }),
    { title: "Entity", description: "Same JSON as yrm_get_entity.", mimeType: "application/json" },
    async (uri, vars) => {
      const raw = vars["id"];
      const id = decodeURIComponent(Array.isArray(raw) ? (raw[0] ?? "") : (raw ?? ""));
      return { contents: [{ uri: uri.href, mimeType: "application/json", text: json(await opts.resources.entity(id)) }] };
    },
  );
  return server;
}

/**
 * Serve over stdio until the client disconnects or the process is told to
 * stop. stdout is the transport, so nothing else may write to it.
 */
export async function serveStdio(server: McpServer, log: Logger): Promise<void> {
  const transport = new StdioServerTransport();
  const closed = new Promise<void>((resolve) => {
    server.server.onclose = () => resolve();
  });
  const stop = (): void => {
    void server.close();
  };
  process.stdin.once("end", stop);
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  await server.connect(transport);
  log.info("mcp server listening on stdio");
  try {
    await closed;
  } finally {
    process.stdin.off("end", stop);
    process.off("SIGINT", stop);
    process.off("SIGTERM", stop);
    log.info("mcp server stopped");
  }
}
