/**
 * Errors raised by model providers and the router.
 *
 * `ModelProviderError` is what every provider throws. The router reads
 * `retryable` to decide whether to fall through to the next hop in a tier's
 * chain. It is named to avoid colliding with the store's `ProviderError`; the
 * two are expected to be unified after both land.
 */

export interface ModelProviderErrorInit {
  message: string;
  code: string;
  retryable: boolean;
  provider: string;
  status?: number;
  cause?: unknown;
}

export class ModelProviderError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly provider: string;
  readonly status?: number;

  constructor(init: ModelProviderErrorInit) {
    super(init.message, init.cause === undefined ? undefined : { cause: init.cause });
    this.name = "ModelProviderError";
    this.code = init.code;
    this.retryable = init.retryable;
    this.provider = init.provider;
    if (init.status !== undefined) this.status = init.status;
  }
}

export type RouterErrorCode =
  | "NO_ROUTE"
  | "NO_ELIGIBLE_ROUTE"
  | "BUDGET_EXCEEDED"
  | "BLOCKED"
  | "ALL_ROUTES_FAILED";

export interface RouteAttempt {
  provider: string;
  model: string;
  /** "skipped" hops never reached the provider. */
  outcome: "skipped" | "failed";
  reason: string;
}

export class RouterError extends Error {
  readonly code: RouterErrorCode;
  readonly tier: string;
  readonly attempts: RouteAttempt[];

  constructor(code: RouterErrorCode, tier: string, message: string, attempts: RouteAttempt[] = [], cause?: unknown) {
    super(message, cause === undefined ? undefined : { cause });
    this.name = "RouterError";
    this.code = code;
    this.tier = tier;
    this.attempts = attempts;
  }
}

/**
 * Map an HTTP status to a provider error code. 408, 409, 429 and 5xx are worth
 * trying elsewhere; everything else in 4xx means the request itself is wrong
 * and another hop would reject it too.
 */
export function classifyHttpStatus(status: number): { code: string; retryable: boolean } {
  if (status === 400 || status === 422) return { code: "BAD_REQUEST", retryable: false };
  if (status === 401 || status === 403) return { code: "AUTH", retryable: false };
  if (status === 404) return { code: "NOT_FOUND", retryable: false };
  if (status === 408) return { code: "TIMEOUT", retryable: true };
  if (status === 409) return { code: "CONFLICT", retryable: true };
  if (status === 429) return { code: "RATE_LIMITED", retryable: true };
  if (status >= 500) return { code: "SERVER_ERROR", retryable: true };
  return { code: "HTTP_ERROR", retryable: false };
}

export function providerErrorFromStatus(provider: string, status: number, message: string, cause?: unknown): ModelProviderError {
  const { code, retryable } = classifyHttpStatus(status);
  return new ModelProviderError({ message, code, retryable, provider, status, cause });
}
