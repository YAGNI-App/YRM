import { SCOPES, type ResolvedSettings } from "./settings.ts";

/** A Slack app manifest for "Create New App > From an app manifest". Read-only scopes only. */
export function appManifestYaml(): string[] {
  return [
    "display_information:",
    "  name: YRM",
    "  description: Reads conversations into your local YRM log.",
    "features:",
    "  bot_user:",
    "    display_name: YRM",
    "    always_online: false",
    "oauth_config:",
    "  scopes:",
    "    user:",
    ...SCOPES.map((s) => `      - ${s}`),
    "    bot:",
    ...SCOPES.map((s) => `      - ${s}`),
    "settings:",
    "  org_deploy_enabled: false",
    "  socket_mode_enabled: false",
    "  token_rotation_enabled: false",
  ];
}

/** The checklist `slack:setup` prints. */
export function setupText(s: Pick<ResolvedSettings, "tokenEnv" | "token">): string[] {
  return [
    "Slack setup: one-time, a private app in your workspace",
    "",
    "1. Open https://api.slack.com/apps and choose Create New App > From an app manifest.",
    "2. Pick the workspace, choose YAML, and paste:",
    "",
    ...appManifestYaml().map((l) => `     ${l}`),
    "",
    "3. Install to Workspace (OAuth & Permissions). An admin may need to approve it.",
    "4. Copy a token from OAuth & Permissions:",
    "     User OAuth Token (xoxp-...)  reads what you can read, including your DMs. Recommended.",
    "     Bot User OAuth Token (xoxb-...)  reads only channels the bot is invited to (/invite @YRM).",
    `5. export ${s.tokenEnv}=xoxp-...   (or settings.slack.token in yrm.config.ts)`,
    "6. Optional, in yrm.config.ts:",
    "",
    "     settings: {",
    "       slack: {",
    '         channels: ["#sales", "C0123ABCD"],   // default: every channel the token can read',
    "         includeDMs: true,",
    "       },",
    "     },",
    "",
    "7. yrm sync slack, then yrm slack:status",
    "",
    s.token ? "A token is configured." : `No token yet: ${s.tokenEnv} is not set.`,
    "No app? Import a workspace export instead: yrm import slack <export-dir>",
  ];
}
