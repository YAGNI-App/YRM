import type { ExtensionAPI, ExtensionFactory, ExtensionManifest } from "@yrm/core";
import { authCommand } from "./command.ts";
import type { AuthSettings } from "./tokens.ts";

export {
  assertBindAllowed,
  Auth,
  bearerToken,
  DEFAULT_SESSION_HOURS,
  hasScope,
  isLoopbackAddress,
  isLoopbackBind,
  loadTokens,
  requireAuth,
  SESSION_COOKIE,
  type Grant,
  type LoadOptions,
  type RequireAuthOptions,
} from "./auth.ts";
export {
  createStoredToken,
  generateToken,
  installSecret,
  KV_NAMESPACE,
  listStoredTokens,
  parseScopes,
  revokeStoredToken,
  safeEqual,
  sha256,
  type AuthSettings,
  type Scope,
  type StoredToken,
  type TokenSetting,
} from "./tokens.ts";

export const manifest: ExtensionManifest = {
  name: "auth",
  version: "0.1.0",
  description: "Bearer tokens and web sessions for yrm web and yrm serve --http.",
};

/** `settings.auth` from a whole config, for extensions whose own reader is scoped to their name. */
export function authSettingsOf(config: { settings?: Record<string, Record<string, unknown>> } | null | undefined): AuthSettings {
  return (config?.settings?.["auth"] as AuthSettings | undefined) ?? {};
}

/** Registers nothing model-facing: only `yrm auth`. Web and MCP import the helpers directly. */
const authExtension: ExtensionFactory = (yrm: ExtensionAPI) => {
  yrm.registerCommand(authCommand(() => yrm.config.get<AuthSettings>() ?? {}));
};
export default authExtension;
