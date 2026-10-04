import type { Host } from "@yrm/core";

/**
 * The slice of the host the dashboard needs beyond `ExtensionAPI`: ranking for
 * Today, hooks so confirm and merge fire `entity:confirmed` / `entity:merged`,
 * projection after a merge, and the tenant config for the timezone.
 * `ExtensionAPI` does not expose these, so the host is handed in through
 * `createWebExtension({ host })` or announced on the extension bus under
 * `HOST_READY_TOPIC` (the same topic `@yrm/ext-mcp` listens on).
 */
export type WebHost = Pick<Host, "config" | "store" | "models" | "log" | "hooks" | "rank" | "project">;

/** `host.events.emit(HOST_READY_TOPIC, host)` after loading extensions binds the host. */
export const HOST_READY_TOPIC = "host:ready";

export class HostBinding {
  #host: WebHost | null;

  constructor(host: WebHost | null = null) {
    this.#host = host;
  }

  bind(host: WebHost): void {
    this.#host = host;
  }

  get current(): WebHost | null {
    return this.#host;
  }
}

export function isWebHost(v: unknown): v is WebHost {
  if (typeof v !== "object" || v === null) return false;
  const h = v as Record<string, unknown>;
  return (
    typeof h["rank"] === "function" &&
    typeof h["project"] === "function" &&
    typeof h["hooks"] === "object" &&
    h["hooks"] !== null &&
    typeof h["config"] === "object"
  );
}
