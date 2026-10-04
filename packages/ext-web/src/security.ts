/**
 * Who may use the dashboard is `@yrm/ext-auth`'s job (tokens, the loopback
 * bypass, the session cookie). This file stops other sites from driving a
 * signed-in browser:
 *
 * - it binds to 127.0.0.1 unless told otherwise;
 * - on a loopback bind it refuses requests whose Host header is not a
 *   loopback name, which defeats DNS rebinding;
 * - every POST must come from the same origin (Origin, or Referer when a
 *   browser omits Origin) and carry a CSRF token that matches the cookie
 *   (double-submit), in the `x-csrf-token` header or the `_csrf` form field.
 */

export const CSRF_COOKIE = "yrm_csrf";
export const CSRF_HEADER = "x-csrf-token";
export const CSRF_FIELD = "_csrf";

const LOOPBACK_NAMES = new Set(["localhost", "127.0.0.1", "[::1]", "::1"]);

export function isLoopbackBind(hostname: string): boolean {
  return LOOPBACK_NAMES.has(hostname) || hostname.startsWith("127.");
}

function hostnameOf(hostHeader: string): string {
  if (hostHeader.startsWith("[")) return hostHeader.slice(0, hostHeader.indexOf("]") + 1);
  return hostHeader.split(":")[0] ?? "";
}

/** On a loopback bind, only loopback Host headers are served. */
export function hostAllowed(req: Request, loopbackOnly: boolean): boolean {
  if (!loopbackOnly) return true;
  const host = req.headers.get("host");
  if (!host) return false;
  const name = hostnameOf(host.toLowerCase());
  return LOOPBACK_NAMES.has(name) || name.startsWith("127.");
}

/** Same-origin check for writes: Origin must match the Host the request was sent to. */
export function sameOrigin(req: Request): boolean {
  const host = req.headers.get("host");
  if (!host) return false;
  const origin = req.headers.get("origin");
  const candidate = origin && origin !== "null" ? origin : req.headers.get("referer");
  if (!candidate) return false;
  try {
    return new URL(candidate).host.toLowerCase() === host.toLowerCase();
  } catch {
    return false;
  }
}

export function readCookie(req: Request, name: string): string | null {
  const header = req.headers.get("cookie");
  if (!header) return null;
  for (const part of header.split(";")) {
    const [k, ...v] = part.trim().split("=");
    if (k === name) return decodeURIComponent(v.join("="));
  }
  return null;
}

export function newToken(): string {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Buffer.from(bytes).toString("base64url");
}

/** Constant-time string compare, so the token cannot be guessed byte by byte. */
export function tokensMatch(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b || a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export function csrfCookie(token: string): string {
  return `${CSRF_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict`;
}

export const SECURITY_HEADERS: Readonly<Record<string, string>> = {
  "content-security-policy":
    "default-src 'none'; style-src 'self'; script-src 'self'; img-src 'self' data:; connect-src 'self'; form-action 'self'; base-uri 'none'; frame-ancestors 'none'",
  "x-content-type-options": "nosniff",
  "referrer-policy": "same-origin",
  "x-frame-options": "DENY",
};
