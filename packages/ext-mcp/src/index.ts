import {
  todayIn,
  YrmError,
  type Command,
  type ExtensionAPI,
  type ExtensionFactory,
  type ExtensionManifest,
  type Tool,
  type ToolContext,
} from "@yrm/core";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { authSettingsOf, hasScope, loadTokens, type Auth, type Grant } from "@yrm/ext-auth";
import { buildContextAdditions } from "./context.ts";
import { dropDismissed } from "./dismiss.ts";
import { clampLimit } from "./format.ts";
import { HOST_READY_TOPIC, HostBinding, isMcpHost, type McpHost } from "./host.ts";
import { getEntityView, readTools, todayView } from "./read-tools.ts";
import { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, HEALTH_PATH, MCP_PATH, serveHttp, type RunningHttp } from "./http.ts";
import { createMcpServer, serveStdio } from "./server.ts";
import { noteSource, writeTools, type WriteSettings } from "./write-tools.ts";

export { buildContextAdditions, HOW_TO_READ, OPEN_ITEMS_TITLE } from "./context.ts";
export { ATTENTION_NS, dismissKey, dropDismissed, type Dismissal } from "./dismiss.ts";
export { HOST_READY_TOPIC, HostBinding, type McpHost } from "./host.ts";
export { classify, openItems, type OpenItem } from "./open-items.ts";
export { jsonSchemaToZod } from "./schema.ts";
export { DEFAULT_HTTP_HOST, DEFAULT_HTTP_PORT, HEALTH_PATH, MCP_PATH, serveHttp, type HttpServeOptions, type RunningHttp } from "./http.ts";
export {
  createMcpServer,
  exposedTools,
  serveStdio,
  toolError,
  WriteScopeRequiredError,
  type McpResources,
  type McpServerOptions,
} from "./server.ts";
export { STORY_MARKDOWN } from "./story.ts";
export { ConfirmationRequiredError, DEFAULT_PRINCIPAL, NOTE_SOURCE, ORIGIN_VERSION } from "./write-tools.ts";

export const manifest: ExtensionManifest = {
  name: "mcp",
  version: "0.1.0",
  description: "MCP server and agent tools: facts with provenance, entities, events, the attention queue and context bundles.",
};

/** Settings under `settings.mcp` in yrm.config.ts. */
export interface McpSettings {
  /** Let write tools run without `confirm: true`. Only for trusted, non-interactive agents. */
  unattendedWrites?: boolean;
  /** Who MCP callers act as, e.g. "user:jack". Default `agent:mcp/<client name>`. */
  principal?: string;
}

export interface McpExtensionOptions {
  /** The host, when the caller has it at registration time (CLI, embedding, tests). */
  host?: McpHost;
}

/** Entities advertised in resources/list. */
const RESOURCE_ENTITY_LIMIT = 50;

/**
 * Build the extension. Ranking, context bundles, note ingest and `serve` need
 * the host, which `ExtensionAPI` does not expose: pass it here, or let
 * `host.start()` announce it under `HOST_READY_TOPIC` (the default path).
 * Store-only tools work either way.
 */
export function createMcpExtension(options: McpExtensionOptions = {}): ExtensionFactory {
  return (yrm: ExtensionAPI) => {
    const binding = new HostBinding(options.host ?? null);
    yrm.events.on(HOST_READY_TOPIC, (payload) => {
      if (isMcpHost(payload)) binding.bind(payload);
    });

    const settings = (): McpSettings => yrm.config.get<McpSettings>() ?? {};
    const writeSettings = (): WriteSettings => ({ unattendedWrites: settings().unattendedWrites === true });
    const own = [...readTools(binding), ...writeTools(binding, writeSettings)];
    for (const tool of own) yrm.registerTool(tool);
    yrm.registerSource(noteSource());

    yrm.on("queue:after_rank", async (ctx, items) =>
      dropDismissed(ctx.store, items, todayIn(binding.current?.config.tenant.timezone)),
    );
    yrm.on("context:build", buildContextAdditions);

    yrm.registerCommand(serveCommand(yrm, binding, own, settings));
  };
}

/** Build an MCP server for a host: all its registered tools, with calls running as `principal`. */
export function createServerForHost(
  host: McpHost,
  opts: { principal?: string; tools?: Tool[]; canWrite?: boolean } = {},
): McpServer {
  const binding = new HostBinding(host);
  const tenantId = host.config.tenant.id;
  return createMcpServer({
    tools: opts.tools ?? host.registry.tools.list(),
    log: host.log,
    context: (client) => toolContext(tenantId, host, opts.principal, client),
    resources: resourcesFor(binding, { tenantId, store: host.store }),
    ...(opts.canWrite !== undefined ? { canWrite: opts.canWrite } : {}),
  });
}

/** Who loopback HTTP callers act as when `settings.mcp.principal` is unset. */
export const HTTP_LOCAL_PRINCIPAL = "agent:mcp/http";

function parseHttpPort(v: string | boolean): number {
  if (v === true) return DEFAULT_HTTP_PORT;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--http must be a port 0..65535, got "${String(v)}"`);
  return n;
}

/** Resolves on SIGINT or SIGTERM. */
function untilSignal(): Promise<void> {
  return new Promise((resolve) => {
    const done = (): void => {
      process.off("SIGINT", done);
      process.off("SIGTERM", done);
      resolve();
    };
    process.on("SIGINT", done);
    process.on("SIGTERM", done);
  });
}

function toolContext(
  tenantId: string,
  deps: Pick<ToolContext, "store" | "models" | "log">,
  principal: string | undefined,
  client: string | undefined,
): ToolContext {
  const ctx: ToolContext = { tenantId, store: deps.store, models: deps.models, log: deps.log };
  const who = principal ?? (client ? `agent:mcp/${client}` : undefined);
  if (who !== undefined) ctx.principal = who;
  return ctx;
}

function resourcesFor(binding: HostBinding, ctx: Pick<ToolContext, "tenantId" | "store">) {
  return {
    entity: (id: string) => getEntityView(ctx.store, ctx.tenantId, id),
    today: () => todayView(binding, ctx, undefined, clampLimit(undefined)),
    listEntities: async () =>
      (
        await ctx.store.findEntities({
          tenantId: ctx.tenantId,
          status: ["confirmed", "proposed"],
          limit: RESOURCE_ENTITY_LIMIT,
        })
      ).map((e) => ({ id: e.id, name: e.name, kind: e.kind })),
  };
}

function serveCommand(yrm: ExtensionAPI, binding: HostBinding, own: Tool[], settings: () => McpSettings): Command {
  return {
    name: "serve",
    description: "Serve YRM to agents over MCP: stdio by default, or Streamable HTTP with bearer tokens (--http). Writes need confirm: true.",
    usage: "serve [--mcp] [--http <port>] [--host 127.0.0.1]",
    async run(ctx) {
      const host = binding.current;
      if (!host) {
        ctx.log.warn(
          `mcp: no host bound; serving only this extension's tools, and yrm_today, yrm_context and yrm_record_note will fail. ` +
            `Start the host after loading extensions (it emits "${HOST_READY_TOPIC}"), or use createMcpExtension({ host }).`,
        );
      }
      const tools = host ? host.registry.tools.list() : own;
      const principal = settings().principal;
      const httpFlag = ctx.flags["http"];
      if (httpFlag !== undefined && httpFlag !== false) {
        let port: number;
        let auth: Auth;
        try {
          port = parseHttpPort(httpFlag);
          auth = await loadTokens(ctx.store, authSettingsOf(host?.config), { log: ctx.log });
        } catch (err) {
          ctx.stderr(err instanceof Error ? err.message : String(err));
          return 2;
        }
        const hostFlag = ctx.flags["host"];
        const hostname = typeof hostFlag === "string" && hostFlag ? hostFlag : DEFAULT_HTTP_HOST;
        const deps = { store: ctx.store, models: ctx.models, log: ctx.log };
        const serverFor = (grant: Grant): McpServer =>
          createMcpServer({
            tools,
            log: ctx.log,
            context: () => toolContext(ctx.tenantId, deps, grant.principal, undefined),
            resources: resourcesFor(binding, { tenantId: ctx.tenantId, store: ctx.store }),
            canWrite: hasScope(grant, "write"),
          });
        let running: RunningHttp;
        try {
          running = serveHttp({ auth, log: ctx.log, serverFor, localPrincipal: principal ?? HTTP_LOCAL_PRINCIPAL, port, hostname });
        } catch (err) {
          ctx.stderr(err instanceof Error ? err.message : String(err));
          return err instanceof YrmError ? 2 : 1;
        }
        const origin = running.url.slice(0, -MCP_PATH.length);
        ctx.stderr(`YRM MCP over HTTP: ${running.url} (health: ${origin}${HEALTH_PATH}). Ctrl-C to stop.`);
        ctx.log.info("mcp tools", { count: tools.length, extension: yrm.manifest.name });
        await untilSignal();
        await running.stop();
        return 0;
      }
      const server = createMcpServer({
        tools,
        log: ctx.log,
        context: (client) => toolContext(ctx.tenantId, { store: ctx.store, models: ctx.models, log: ctx.log }, principal, client),
        resources: resourcesFor(binding, { tenantId: ctx.tenantId, store: ctx.store }),
      });
      ctx.log.info("mcp tools", { count: tools.length, extension: yrm.manifest.name });
      await serveStdio(server, ctx.log);
      return 0;
    },
  };
}

const mcpExtension: ExtensionFactory = createMcpExtension();
export default mcpExtension;
