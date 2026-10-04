import type { Booted } from "../bootstrap.ts";
import { booted, type BuiltinCommand, type CliEnv } from "../env.ts";

/** Who a CLI action is attributed to: `user:<tenant name or $USER>`. */
export function actor(boot: Booted, env: Record<string, string | undefined>): string {
  const who = boot.config.tenant.name ?? env["USER"] ?? env["USERNAME"] ?? "local";
  return `user:${who.trim().toLowerCase().replace(/\s+/g, "-")}`;
}

function hookCtx(boot: Booted) {
  const { host } = boot;
  return { tenantId: host.config.tenant.id, store: host.store, models: host.models, log: host.log };
}

async function setStatus(env: CliEnv, id: string | undefined, status: "confirmed" | "rejected", out: (l: string) => void, err: (l: string) => void): Promise<number> {
  const boot = booted(env);
  const { host } = boot;
  if (!id) {
    err(`usage: yrm ${status === "confirmed" ? "confirm" : "reject"} <entity-id>`);
    return 1;
  }
  const entity = await host.store.resolveEntity(id);
  if (!entity) {
    err(`no entity ${id}`);
    return 1;
  }
  const updated = await host.store.updateEntity(entity.id, { status });
  // There is no entity:rejected hook in the contract; confirmation is the only one to fire.
  if (status === "confirmed") await host.hooks.emit("entity:confirmed", hookCtx(boot), updated);
  out(`${status} ${updated.name} (${updated.id}) by ${actor(boot, env.env)}`);
  return 0;
}

export function confirmCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "confirm",
    description: "Confirm a proposed entity",
    usage: "yrm confirm <entity-id>",
    needsHost: true,
    run: (ctx) => setStatus(env, ctx.args[0], "confirmed", ctx.stdout, ctx.stderr),
  };
}

export function rejectCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "reject",
    description: "Reject a proposed entity",
    usage: "yrm reject <entity-id>",
    needsHost: true,
    run: (ctx) => setStatus(env, ctx.args[0], "rejected", ctx.stdout, ctx.stderr),
  };
}

export function mergeCommand(env: CliEnv): BuiltinCommand {
  return {
    name: "merge",
    description: "Merge one entity into another (identifiers, facts and events move)",
    usage: "yrm merge <from-id> <into-id>",
    needsHost: true,
    async run(ctx) {
      const boot = booted(env);
      const { host } = boot;
      const [fromId, intoId] = ctx.args;
      if (!fromId || !intoId) {
        ctx.stderr("usage: yrm merge <from-id> <into-id>");
        return 1;
      }
      const from = await host.store.getEntity(fromId);
      if (!from) {
        ctx.stderr(`no entity ${fromId}`);
        return 1;
      }
      const by = actor(boot, env.env);
      const into = await host.store.mergeEntities(fromId, intoId, by);
      const merged = (await host.store.getEntity(fromId)) ?? from;
      await host.hooks.emit("entity:merged", hookCtx(boot), merged, into);
      await host.project([into.id]);
      ctx.stdout(`merged ${from.name} (${from.id}) into ${into.name} (${into.id}) by ${by}`);
      return 0;
    },
  };
}
