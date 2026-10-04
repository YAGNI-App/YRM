/**
 * Error hierarchy for YRM. Every error carries a stable machine-readable
 * `code` so callers (CLI, MCP, extensions) can branch without parsing messages.
 */
export class YrmError extends Error {
  readonly code: string;

  constructor(code: string, message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = new.target.name;
    this.code = code;
  }
}

/** Invalid or missing configuration. */
export class ConfigError extends YrmError {}

/** Persistence failures and violated store invariants. */
export class StoreError extends YrmError {}

/** A model provider failed or refused a request. */
export class ProviderError extends YrmError {}
