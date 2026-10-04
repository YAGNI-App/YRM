/**
 * Host-local error classes. ConfigError specializes the shared one from
 * ../errors.ts with the config file path; it is not re-exported from the
 * host barrel because @yrm/core already exports the base class.
 */
import { ConfigError as CoreConfigError } from "../errors.ts";

export class ConfigError extends CoreConfigError {
  constructor(
    message: string,
    /** Path to the config file, when known. */
    readonly file?: string,
    options?: { cause?: unknown },
  ) {
    super("CONFIG_INVALID", file ? `${message} (in ${file})` : message, options);
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
