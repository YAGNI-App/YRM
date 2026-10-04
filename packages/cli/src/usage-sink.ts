import { monthStart, type ModelCallRecord, type ModelCallStore, type UsageSink } from "@yrm/core";

/**
 * Persists router usage to the store's `model_calls` table (SQLite or
 * Postgres) so spend and the monthly budget survive across CLI invocations.
 *
 * `sumModelCost` only reports a total, so `byTier` is always empty here; a
 * per-tier breakdown needs a store method that does not exist yet.
 */
export class StoreUsageSink implements UsageSink {
  constructor(
    private readonly store: ModelCallStore,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async record(entry: ModelCallRecord): Promise<void> {
    const meta: Record<string, unknown> = { ...entry.meta, kind: entry.kind, ok: entry.ok };
    if (entry.errorCode !== undefined) meta["errorCode"] = entry.errorCode;
    await this.store.recordModelCall({
      tenantId: entry.tenantId,
      tier: entry.tier,
      provider: entry.provider,
      model: entry.model,
      inputTokens: entry.usage.inputTokens,
      outputTokens: entry.usage.outputTokens,
      cacheReadTokens: entry.usage.cacheReadTokens ?? 0,
      costUsd: entry.usage.costUsd,
      latencyMs: entry.latencyMs,
      createdAt: entry.at,
      meta,
    });
  }

  async monthToDate(tenantId: string): Promise<{ usd: number; byTier: Record<string, number> }> {
    const usd = await this.store.sumModelCost(tenantId, monthStart(this.now()).toISOString());
    return { usd, byTier: {} };
  }
}

/** @deprecated The sink works with any `ModelCallStore`; use `StoreUsageSink`. */
export const SqliteUsageSink = StoreUsageSink;
