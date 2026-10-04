import type { HookContext, HookMap, HookName, Logger } from "../contracts/index.ts";
import { HookError, messageOf } from "./errors.ts";

type Result<E extends HookName> = Awaited<ReturnType<HookMap[E]>>;
type Args<E extends HookName> = Parameters<HookMap[E]> extends [HookContext, ...infer R] ? R : never;
type Last<T extends unknown[]> = T extends [...unknown[], infer L] ? L : never;

/** Hooks whose handlers return a replacement subject (always the last argument). */
export type PipeHook = { [E in HookName]: Result<E> extends void ? never : E }[HookName];
/** Hooks that only notify. */
export type NotifyHook = Exclude<HookName, PipeHook>;

/** What `pipe` resolves to: the final subject, or null when a handler vetoed it. */
export type PipeResult<E extends PipeHook> = null extends Result<E> ? Last<Args<E>> | null : Last<Args<E>>;

/** Hooks where returning `null` means "drop / skip / block". Elsewhere null is a bug. */
const VETO_HOOKS: ReadonlySet<HookName> = new Set<HookName>(["ingest:before", "extract:before", "model:before"]);

interface Entry {
  extension: string;
  handler: (ctx: HookContext, ...args: unknown[]) => Promise<unknown>;
}

/**
 * Runs hook handlers in registration order (which is extension load order).
 * A returned value replaces the subject for the next handler, `undefined`
 * leaves it, and `null` vetoes where the hook allows it. Handler errors are
 * logged with the extension name and rethrown as HookError; never swallowed.
 */
export class HookBus {
  private readonly handlers = new Map<HookName, Entry[]>();

  constructor(private readonly log: Logger) {}

  on<E extends HookName>(hook: E, handler: HookMap[E], extension = "host"): () => void {
    const list = this.handlers.get(hook) ?? [];
    const entry: Entry = { extension, handler: handler as Entry["handler"] };
    list.push(entry);
    this.handlers.set(hook, list);
    return () => {
      const current = this.handlers.get(hook);
      if (!current) return;
      const i = current.indexOf(entry);
      if (i >= 0) current.splice(i, 1);
    };
  }

  has(hook: HookName): boolean {
    return (this.handlers.get(hook)?.length ?? 0) > 0;
  }

  count(hook: HookName): number {
    return this.handlers.get(hook)?.length ?? 0;
  }

  /** Fire a notification hook. Handlers run sequentially so ordering is observable. */
  async emit<E extends NotifyHook>(hook: E, ctx: HookContext, ...args: Args<E>): Promise<void> {
    for (const entry of this.snapshot(hook)) {
      await this.call(hook, entry, ctx, args);
    }
  }

  /** Thread a subject (the hook's last argument) through every handler. */
  async pipe<E extends PipeHook>(hook: E, ctx: HookContext, ...args: Args<E>): Promise<PipeResult<E>> {
    const fixed = args.slice(0, -1) as unknown[];
    let subject = args[args.length - 1] as unknown;
    for (const entry of this.snapshot(hook)) {
      const out = await this.call(hook, entry, ctx, [...fixed, subject]);
      if (out === undefined) continue;
      if (out === null) {
        if (VETO_HOOKS.has(hook)) {
          this.log.debug("hook vetoed subject", { hook, extension: entry.extension });
          return null as PipeResult<E>;
        }
        throw this.fail(hook, entry, new TypeError(`hook "${hook}" does not allow returning null`));
      }
      subject = out;
    }
    return subject as PipeResult<E>;
  }

  private snapshot(hook: HookName): Entry[] {
    // Copy so a handler that registers or unregisters mid-run does not change this run.
    return [...(this.handlers.get(hook) ?? [])];
  }

  private async call(hook: HookName, entry: Entry, ctx: HookContext, args: unknown[]): Promise<unknown> {
    try {
      return await entry.handler(ctx, ...args);
    } catch (err) {
      throw this.fail(hook, entry, err);
    }
  }

  private fail(hook: HookName, entry: Entry, err: unknown): HookError {
    this.log.error("hook handler failed", { hook, extension: entry.extension, error: messageOf(err) });
    return new HookError(hook, entry.extension, err);
  }
}
