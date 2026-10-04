import { DEFAULT_CLIENT_SECRET_ENV, type ResolvedSettings } from "./settings.ts";

/** Where the loopback listener will receive the redirect, as shown to the user. */
export function redirectDescription(port: number): string {
  return port > 0 ? `http://127.0.0.1:${port}/` : "http://127.0.0.1:<random port>/ (Desktop app clients accept any loopback port)";
}

/** The Google Cloud checklist `gmail:setup` prints before signing in. */
export function setupText(s: Pick<ResolvedSettings, "scopes" | "redirectPort" | "clientId" | "clientSecretEnv" | "account">): string[] {
  const envName = s.clientSecretEnv || DEFAULT_CLIENT_SECRET_ENV;
  return [
    "Gmail setup: one-time, in your own Google Cloud project",
    "",
    "1. Create a project: https://console.cloud.google.com/projectcreate",
    "2. Enable the Gmail API: https://console.cloud.google.com/apis/library/gmail.googleapis.com",
    "3. Configure the OAuth consent screen (APIs & Services > OAuth consent screen):",
    "     User type: Internal   if you use Google Workspace. Internal apps need no Google verification.",
    "     User type: External   for a personal @gmail.com account. Leave it in Testing and add yourself under Test users.",
    "4. Create credentials (APIs & Services > Credentials > Create credentials > OAuth client ID):",
    "     Application type: Desktop app",
    "5. Paste the client id and secret into yrm.config.ts:",
    "",
    "     settings: {",
    "       gmail: {",
    '         clientId: "1234567890-abc.apps.googleusercontent.com",',
    `         // either clientSecret: "GOCSPX-...", or keep it out of the file:`,
    `         clientSecretEnv: "${envName}",`,
    `         account: "${s.account ?? "you@yourcompany.com"}",`,
    '         labels: ["INBOX", "SENT"],',
    '         query: "newer_than:1y",',
    "       },",
    "     },",
    "",
    `   and export ${envName}=<client secret> if you use the env var.`,
    "6. Scopes this app requests (add them on the consent screen's Data access page):",
    ...s.scopes.map((scope) => `     ${scope}`),
    `7. Redirect URI: ${redirectDescription(s.redirectPort)}`,
    "8. Run `yrm gmail:setup` again to sign in, then `yrm sync gmail`.",
    "",
    "Tokens are stored in the local SQLite kv table, never in the config file.",
  ];
}
