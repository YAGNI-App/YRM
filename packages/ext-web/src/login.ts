import type { View } from "./components.ts";
import { html, type Html } from "./html.ts";
import { layout } from "./pages.ts";
import { CSRF_FIELD } from "./security.ts";

/** Only same-site paths survive as a post-login destination. */
export function safeNext(next: string | null | undefined): string {
  if (next && next.startsWith("/") && !next.startsWith("//") && !next.startsWith("/\\") && !next.startsWith("/login")) return next;
  return "/";
}

export function loginView(v: View, next: string, error?: string): Html {
  return layout(
    v,
    "Sign in",
    "",
    html`<div class="empty">
  <h1>Sign in</h1>
  <p>This dashboard is reachable beyond this machine, so it needs a token. Create one with
  <span class="mono">yrm auth token create &lt;name&gt; --principal user:&lt;you&gt; --scopes read,write</span>.</p>
  ${error ? html`<p role="alert"><strong>${error}</strong></p>` : ""}
  <form method="post" action="/login">
    <input type="hidden" name="${CSRF_FIELD}" value="${v.csrf}">
    <input type="hidden" name="next" value="${next}">
    <p><label>Token <input type="password" name="token" autocomplete="current-password" required autofocus></label></p>
    <p><button type="submit" class="btn primary">Sign in</button></p>
  </form>
</div>`,
  );
}
