import { YrmError, type Command, type CommandContext } from "@yrm/core";
import { createStoredToken, listStoredTokens, parseScopes, revokeStoredToken, type AuthSettings } from "./tokens.ts";

const USAGE = [
  "auth token create <name> --principal user:<you> [--scopes read,write]",
  "auth token list",
  "auth token revoke <name>",
].join("\n       ");

async function create(ctx: CommandContext, name: string | undefined): Promise<number> {
  const principal = ctx.flags["principal"];
  if (!name || typeof principal !== "string") {
    ctx.stderr(`usage: yrm ${USAGE.split("\n")[0]}`);
    return 2;
  }
  const scopesFlag = ctx.flags["scopes"];
  const scopes = parseScopes(typeof scopesFlag === "string" ? scopesFlag : "read");
  const { token, record } = await createStoredToken(ctx.store, { name, principal, scopes });
  ctx.stdout(token);
  ctx.stderr(`token "${record.name}" for ${record.principal} (${record.scopes.join(",")}). Shown once; only its SHA-256 is stored.`);
  return 0;
}

async function list(ctx: CommandContext, settings: () => AuthSettings): Promise<number> {
  const rows: string[] = [];
  for (const t of settings().tokens ?? []) {
    rows.push(`${t.name}\t${t.principal}\t${t.scopes.join(",")}\tsettings${t.tokenEnv ? ` ($${t.tokenEnv})` : ""}`);
  }
  for (const t of await listStoredTokens(ctx.store)) rows.push(`${t.name}\t${t.principal}\t${t.scopes.join(",")}\tkv, created ${t.createdAt}`);
  if (rows.length === 0) {
    ctx.stdout("no tokens; yrm web and yrm serve --http accept loopback callers only");
    return 0;
  }
  for (const r of rows) ctx.stdout(r);
  return 0;
}

async function revoke(ctx: CommandContext, name: string | undefined, settings: () => AuthSettings): Promise<number> {
  if (!name) {
    ctx.stderr("usage: yrm auth token revoke <name>");
    return 2;
  }
  if (await revokeStoredToken(ctx.store, name)) {
    ctx.stdout(`revoked "${name}"; its web sessions end on their next request`);
    return 0;
  }
  if ((settings().tokens ?? []).some((t) => t.name === name)) {
    ctx.stderr(`"${name}" comes from settings.auth.tokens in yrm.config.ts; remove it there`);
    return 1;
  }
  ctx.stderr(`no token named "${name}"`);
  return 1;
}

export function authCommand(settings: () => AuthSettings): Command {
  return {
    name: "auth",
    description: "Manage bearer tokens for yrm web and yrm serve --http.",
    usage: USAGE,
    async run(ctx) {
      const [group, verb, name] = ctx.args;
      try {
        if (group === "token" && verb === "create") return await create(ctx, name);
        if (group === "token" && verb === "list") return await list(ctx, settings);
        if (group === "token" && verb === "revoke") return await revoke(ctx, name, settings);
      } catch (err) {
        if (err instanceof YrmError) {
          ctx.stderr(err.message);
          return 2;
        }
        throw err;
      }
      ctx.stderr(`usage: yrm ${USAGE}`);
      return 2;
    },
  };
}
