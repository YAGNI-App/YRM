import type { NewSourceEvent, Store, SyncContext } from "@yrm/core";
import { classifyNoise, parseEml } from "@yrm/ext-mail";
import { GmailHttpError, type GmailClient, type RawMessage } from "./api.ts";
import { decodeBase64Url, toGmailEvent } from "./convert.ts";
import { KV_NAMESPACE, type ResolvedSettings } from "./settings.ts";

/** Concurrent `messages.get` calls. 10 x 5 quota units stays well under 250 units/user/second. */
export const FETCH_CONCURRENCY = 10;
/** Events handed to the host per `emit` call. */
export const EMIT_BATCH = 50;
/** Search used to refill after Gmail has expired our history id. */
export const RECOVERY_QUERY = "newer_than:30d";

export const BACKFILL_KEY = "backfill:pageToken";
export const LAST_SYNC_KEY = "lastSync";
export const INGESTED_KEY = "ingested";

/** Resume point for a backfill that spans several runs. */
export interface BackfillState {
  /** Index into `settings.labels` being listed. */
  labelIndex: number;
  pageToken?: string;
  /** Profile history id taken when the backfill began; becomes the cursor when it ends. */
  historyId: string;
  /** The search in effect: `settings.query`, or the recovery query after a history 404. */
  query?: string;
}

export interface SyncStats {
  mode: "backfill" | "history" | "recovery";
  fetched: number;
  emitted: number;
  created: number;
  dropped: number;
  noiseReasons: Record<string, number>;
  /** True when a backfill stopped at `maxPerSync` and resumes next run. */
  partial: boolean;
}

type Kv = Pick<Store, "kvGet" | "kvSet" | "kvDelete">;

export interface SyncDeps {
  client: GmailClient;
  kv: Kv;
  settings: ResolvedSettings;
  account: string;
}

/** `report` is not part of SyncContext yet; call it when a host provides it. */
type Reporting = SyncContext & { report?: (stats: Record<string, unknown>) => void };

class Ingester {
  private batch: NewSourceEvent[] = [];
  private readonly seen = new Set<string>();

  constructor(
    private readonly ctx: SyncContext,
    private readonly deps: SyncDeps,
    readonly stats: SyncStats,
  ) {}

  private toEvent(m: RawMessage): NewSourceEvent | null {
    const msg = parseEml(decodeBase64Url(m.raw));
    const { settings } = this.deps;
    const verdict = classifyNoise(msg, settings.noise);
    if (verdict.noise) {
      const reason = verdict.reason ?? "noise";
      this.stats.noiseReasons[reason] = (this.stats.noiseReasons[reason] ?? 0) + 1;
      if (!settings.keepNoise) this.stats.dropped++;
    }
    const internal = m.internalDate !== undefined ? Number(m.internalDate) : NaN;
    const opts: Parameters<typeof toGmailEvent>[1] = {
      gmailId: m.id,
      labels: m.labelIds ?? [],
      rawRef: `gmail:${this.deps.account}/${m.id}`,
      noise: settings.noise,
      keepNoise: settings.keepNoise,
      verdict,
    };
    if (m.threadId) opts.threadId = m.threadId;
    if (Number.isFinite(internal)) opts.fallbackDate = new Date(internal).toISOString();
    return toGmailEvent(msg, opts);
  }

  private async flush(all: boolean): Promise<void> {
    while (this.batch.length >= EMIT_BATCH || (all && this.batch.length > 0)) {
      const chunk = this.batch.splice(0, EMIT_BATCH);
      const created = await this.ctx.emit(chunk);
      this.stats.emitted += chunk.length;
      this.stats.created += created.length;
    }
  }

  /** Fetch, convert and emit. Ids already handled this run are skipped (a message can sit under two labels). */
  async ingest(ids: string[]): Promise<void> {
    const todo = ids.filter((id) => !this.seen.has(id));
    for (const id of todo) this.seen.add(id);
    for (let i = 0; i < todo.length; i += FETCH_CONCURRENCY) {
      if (this.ctx.signal.aborted) return;
      const group = todo.slice(i, i + FETCH_CONCURRENCY);
      const messages = await Promise.all(
        group.map(async (id) => {
          try {
            return await this.deps.client.getRaw(id);
          } catch (err) {
            // Deleted between list and get: nothing to ingest.
            if (err instanceof GmailHttpError && err.status === 404) {
              this.ctx.log.debug("message vanished before fetch", { id });
              return null;
            }
            throw err;
          }
        }),
      );
      for (const m of messages) {
        if (!m) continue;
        this.stats.fetched++;
        const event = this.toEvent(m);
        if (event) this.batch.push(event);
      }
      await this.flush(false);
    }
  }

  finish(): Promise<void> {
    return this.flush(true);
  }
}

async function backfill(ctx: SyncContext, deps: SyncDeps, state: BackfillState, ing: Ingester): Promise<void> {
  const { client, kv, settings } = deps;
  let budget = settings.maxPerSync;
  while (state.labelIndex < settings.labels.length && budget > 0 && !ctx.signal.aborted) {
    const listOpts: Parameters<GmailClient["listMessages"]>[0] = { labelId: settings.labels[state.labelIndex]!, maxResults: budget };
    if (state.query) listOpts.query = state.query;
    if (state.pageToken) listOpts.pageToken = state.pageToken;
    const page = await client.listMessages(listOpts);
    const ids = (page.messages ?? []).map((m) => m.id);
    budget -= ids.length;
    await ing.ingest(ids);
    await ing.finish();
    // A partly ingested page must be listed again, so do not move past it.
    if (ctx.signal.aborted) break;
    if (page.nextPageToken) state.pageToken = page.nextPageToken;
    else {
      state.labelIndex++;
      delete state.pageToken;
    }
    // Saved after the page's events are in the log, so a crash re-lists at most one page.
    await kv.kvSet(KV_NAMESPACE, BACKFILL_KEY, state);
  }
  if (state.labelIndex >= settings.labels.length) {
    await ctx.setCursor(state.historyId);
    await kv.kvDelete(KV_NAMESPACE, BACKFILL_KEY);
  } else {
    ing.stats.partial = true;
    ctx.log.info("gmail backfill paused at maxPerSync; the next sync continues", {
      label: settings.labels[state.labelIndex],
      maxPerSync: settings.maxPerSync,
    });
  }
}

async function startBackfill(deps: SyncDeps, query: string | undefined): Promise<BackfillState> {
  // Take the history id before listing: anything that arrives mid-backfill is then replayed by history mode.
  const profile = await deps.client.getProfile();
  const state: BackfillState = { labelIndex: 0, historyId: profile.historyId };
  if (query) state.query = query;
  await deps.kv.kvSet(KV_NAMESPACE, BACKFILL_KEY, state);
  return state;
}

async function history(ctx: SyncContext, deps: SyncDeps, cursor: string, ing: Ingester): Promise<void> {
  const wanted = new Set(deps.settings.labels);
  const ids = new Set<string>();
  let latest = cursor;
  let pageToken: string | undefined;
  do {
    const page = await deps.client.listHistory(cursor, pageToken);
    for (const record of page.history ?? []) {
      for (const added of record.messagesAdded ?? []) {
        const labels = added.message.labelIds;
        // Drafts and chats also show up as added messages; keep only the labels we sync.
        if (labels === undefined || labels.some((l) => wanted.has(l))) ids.add(added.message.id);
      }
    }
    latest = page.historyId ?? latest;
    pageToken = page.nextPageToken;
  } while (pageToken && !ctx.signal.aborted);
  await ing.ingest([...ids]);
  await ing.finish();
  if (!ctx.signal.aborted) await ctx.setCursor(latest);
}

/**
 * One sync run. No cursor: backfill (resumable across runs). Cursor: replay
 * history since it. A history 404 means Gmail no longer has that history id;
 * refill the last 30 days and pick history up again from there.
 */
export async function syncGmail(ctx: SyncContext, deps: SyncDeps): Promise<SyncStats> {
  const stats: SyncStats = { mode: "backfill", fetched: 0, emitted: 0, created: 0, dropped: 0, noiseReasons: {}, partial: false };
  const ing = new Ingester(ctx, deps, stats);
  const pending = await deps.kv.kvGet<BackfillState>(KV_NAMESPACE, BACKFILL_KEY);

  if (pending) {
    if (pending.query === RECOVERY_QUERY) stats.mode = "recovery";
    await backfill(ctx, deps, pending, ing);
  } else if (ctx.cursor === null) {
    await backfill(ctx, deps, await startBackfill(deps, deps.settings.query), ing);
  } else {
    stats.mode = "history";
    try {
      await history(ctx, deps, ctx.cursor, ing);
    } catch (err) {
      if (!(err instanceof GmailHttpError && err.status === 404)) throw err;
      ctx.log.warn("gmail history id expired; refilling the last 30 days", { cursor: ctx.cursor });
      stats.mode = "recovery";
      await backfill(ctx, deps, await startBackfill(deps, RECOVERY_QUERY), ing);
    }
  }

  const now = new Date().toISOString();
  await deps.kv.kvSet(KV_NAMESPACE, LAST_SYNC_KEY, now);
  const total = (await deps.kv.kvGet<number>(KV_NAMESPACE, INGESTED_KEY)) ?? 0;
  await deps.kv.kvSet(KV_NAMESPACE, INGESTED_KEY, total + stats.created);

  const summary = {
    mode: stats.mode,
    fetched: stats.fetched,
    created: stats.created,
    duplicates: stats.emitted - stats.created,
    dropped: stats.dropped,
    noiseReasons: stats.noiseReasons,
    partial: stats.partial,
  };
  const reporting = ctx as Reporting;
  if (typeof reporting.report === "function") reporting.report({ dropped: stats.dropped });
  ctx.log.info("gmail sync finished", summary);
  return stats;
}
