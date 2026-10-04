import { systemTimezone, YrmError, type Command, type ExtensionAPI, type ExtensionFactory, type ExtensionManifest, type Logger, type Store } from "@yrm/core";
import { assertBindAllowed, authSettingsOf, loadTokens, type Auth } from "@yrm/ext-auth";
import { createWebApp, type WebApp } from "./app.ts";
import type { WebDeps } from "./data.ts";
import { HOST_READY_TOPIC, HostBinding, isWebHost, type WebHost } from "./host.ts";
import { isLoopbackBind } from "./security.ts";

export { createWebApp, type WebApp, type WebAppOptions } from "./app.ts";
export { classify, collectFacts, locateQuote, type FactState, type FactView, type QuoteLocation, type TimeMachine, type WebDeps } from "./data.ts";
export { esc, html, raw, Html } from "./html.ts";
export { HOST_READY_TOPIC, HostBinding, type WebHost } from "./host.ts";
export { CSRF_COOKIE, CSRF_FIELD, CSRF_HEADER } from "./security.ts";

export const manifest: ExtensionManifest = {
  name: "web",
  version: "0.1.0",
  description: "Local web dashboard: the attention queue, entities with a bi-temporal time machine, provenance down to the quoted words.",
};

export const DEFAULT_PORT = 7777;
export const DEFAULT_HOSTNAME = "127.0.0.1";

/** Settings under `settings.web` in yrm.config.ts. Flags win. */
export interface WebSettings {
  port?: number;
  host?: string;
  /** Who dashboard actions are attributed to. Default `user:<tenant name or $USER>`. */
  principal?: string;
}

export interface WebExtensionOptions {
  /** The host, when the caller has it at registration time (CLI, embedding, tests). */
  host?: WebHost;
}

export interface StartOptions {
  store: Store;
  tenantId: string;
  log: Logger;
  host?: WebHost | null;
  /** Default 7777; 0 picks a free port. */
  port?: number;
  /** Default 127.0.0.1. */
  hostname?: string;
  principal?: string;
  /**
   * Who may connect (`loadTokens` from `@yrm/ext-auth`). Without it the
   * server only binds loopback and lets every local request through.
   */
  auth?: Auth;
  now?: () => Date;
}

export interface RunningWeb {
  server: ReturnType<typeof Bun.serve>;
  app: WebApp;
  url: string;
  stop(): Promise<void>;
}

function defaultPrincipal(host: WebHost | null): string {
  const who = host?.config.tenant.name ?? process.env["USER"] ?? process.env["USERNAME"] ?? "local";
  return `user:${who.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

/** Start the dashboard. Embedding hosts and tests call this directly; `yrm web` wraps it. */
export function startWebServer(opts: StartOptions): RunningWeb {
  const hostname = opts.hostname ?? DEFAULT_HOSTNAME;
  const host = (): WebHost | null => opts.host ?? null;
  const deps: WebDeps = {
    store: opts.store,
    tenantId: opts.tenantId,
    log: opts.log,
    host,
    timezone: () => host()?.config.tenant.timezone ?? systemTimezone(),
    actor: () => opts.principal ?? defaultPrincipal(host()),
    now: opts.now ?? (() => new Date()),
  };
  if (opts.auth) assertBindAllowed(hostname, opts.auth, "yrm web");
  else if (!isLoopbackBind(hostname)) {
    throw new Error(`yrm web will not listen on ${hostname} without authentication; pass auth (see @yrm/ext-auth) or bind 127.0.0.1`);
  }
  const app = createWebApp(deps, opts.auth ? { loopbackOnly: isLoopbackBind(hostname), auth: opts.auth } : { loopbackOnly: isLoopbackBind(hostname) });
  const server: ReturnType<typeof Bun.serve> = Bun.serve({
    port: opts.port ?? DEFAULT_PORT,
    hostname,
    fetch: (req) => app.fetch(req, server.requestIP(req)?.address ?? null),
  });
  const shown = hostname.includes(":") ? `[${hostname}]` : hostname;
  return {
    server,
    app,
    url: `http://${shown}:${server.port}/`,
    async stop() {
      await server.stop(true);
    },
  };
}

function parsePort(v: string | boolean | undefined, fallback: number): number {
  if (v === undefined || v === true || v === false) return fallback;
  const n = Number(v);
  if (!Number.isInteger(n) || n < 0 || n > 65535) throw new Error(`--port must be 0..65535, got "${v}"`);
  return n;
}

async function openBrowser(url: string, log: Logger): Promise<void> {
  const cmd = process.platform === "darwin" ? ["open", url] : process.platform === "win32" ? ["cmd", "/c", "start", "", url] : ["xdg-open", url];
  try {
    Bun.spawn(cmd, { stdout: "ignore", stderr: "ignore" });
  } catch (err) {
    log.warn("could not open a browser", { error: err instanceof Error ? err.message : String(err) });
  }
}

/** Resolves on SIGINT or SIGTERM, so the CLI closes the store only after the server stops. */
function untilSignal(): Promise<string> {
  return new Promise((resolve) => {
    const done = (sig: string) => () => {
      process.off("SIGINT", onInt);
      process.off("SIGTERM", onTerm);
      resolve(sig);
    };
    const onInt = done("SIGINT");
    const onTerm = done("SIGTERM");
    process.on("SIGINT", onInt);
    process.on("SIGTERM", onTerm);
  });
}

function webCommand(yrm: ExtensionAPI, binding: HostBinding): Command {
  return {
    name: "web",
    description: "Open the local web dashboard: today's queue, people, facts with provenance and a time machine.",
    usage: "web [--port 7777] [--host 127.0.0.1] [--open]",
    async run(ctx) {
      const settings = yrm.config.get<WebSettings>() ?? {};
      let port: number;
      try {
        port = parsePort(ctx.flags["port"], settings.port ?? DEFAULT_PORT);
      } catch (err) {
        ctx.stderr(err instanceof Error ? err.message : String(err));
        return 2;
      }
      const hostFlag = ctx.flags["host"];
      const hostname = typeof hostFlag === "string" && hostFlag ? hostFlag : (settings.host ?? DEFAULT_HOSTNAME);
      const host = binding.current;
      if (!host) {
        ctx.log.warn(
          `web: no host bound, so Today shows the last saved queue and confirm/merge fire no hooks. ` +
            `Bind it with createWebExtension({ host }) or emit "${HOST_READY_TOPIC}" with the host after loading extensions.`,
        );
      }
      let auth: Auth;
      try {
        auth = await loadTokens(ctx.store, authSettingsOf(host?.config), { log: ctx.log });
      } catch (err) {
        ctx.stderr(err instanceof Error ? err.message : String(err));
        return 2;
      }
      const opts: StartOptions = { store: ctx.store, tenantId: ctx.tenantId, log: ctx.log, host, port, hostname, auth };
      if (settings.principal !== undefined) opts.principal = settings.principal;
      let running: RunningWeb;
      try {
        running = startWebServer(opts);
      } catch (err) {
        if (err instanceof YrmError) {
          ctx.stderr(err.message);
          return 2;
        }
        ctx.stderr(`could not listen on ${hostname}:${port}: ${err instanceof Error ? err.message : String(err)}`);
        return 1;
      }
      ctx.stdout(`YRM dashboard: ${running.url}`);
      if (!isLoopbackBind(hostname)) {
        ctx.stderr(`listening on ${hostname}: remote callers sign in with a token at /login${auth.allowLoopback ? "; loopback callers need none" : ""}. Traffic is plain HTTP; put TLS in front for anything beyond a trusted LAN.`);
      }
      ctx.stdout("Ctrl-C to stop.");
      if (ctx.flags["open"] === true) await openBrowser(running.url, ctx.log);
      await untilSignal();
      await running.stop();
      return 0;
    },
  };
}

/**
 * Build the extension. Ranking for Today and the confirm/merge hooks need the
 * host, which `ExtensionAPI` does not expose: pass it here, or emit
 * `HOST_READY_TOPIC` with the host on the extension bus after loading. Without
 * it the dashboard still reads everything from the store.
 */
export function createWebExtension(options: WebExtensionOptions = {}): ExtensionFactory {
  return (yrm: ExtensionAPI) => {
    const binding = new HostBinding(options.host ?? null);
    yrm.events.on(HOST_READY_TOPIC, (payload) => {
      if (isWebHost(payload)) binding.bind(payload);
    });
    yrm.registerCommand(webCommand(yrm, binding));
  };
}

const webExtension: ExtensionFactory = createWebExtension();
export default webExtension;
