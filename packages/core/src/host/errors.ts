/**
 * Host-local error classes.
 *
 * `ConfigError` is a minimal stand-in until the shared `errors.ts` from the
 * store work lands; it is intentionally not re-exported from the host barrel so
 * the two cannot collide in `@yrm/core`'s public surface. Swap the import when
 * they merge.
 */

export class ConfigError extends Error {
  override name = "ConfigError";
  constructor(
    message: string,
    /** Path to the config file, when known. */
    readonly file?: string,
    options?: { cause?: unknown },
  ) {
    super(file ? `${message} (in ${file})` : message, options);
  }
}

/** A hook handler threw. Carries which hook and which extension. */
export class HookError extends Error {
  override name = "HookError";
  constructor(
    readonly hook: string,
    readonly extension: string,
    cause: unknown,
  ) {
    super(`hook "${hook}" failed in extension "${extension}": ${messageOf(cause)}`, { cause });
  }
}

/** An extension could not be loaded or registered. */
export class ExtensionError extends Error {
  override name = "ExtensionError";
  constructor(
    message: string,
    readonly extension?: string,
    options?: { cause?: unknown },
  ) {
    super(message, options);
  }
}

export function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
