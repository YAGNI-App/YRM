import { monthStart, type ModelCallRecord, type SqliteStore, type UsageSink } from "@yrm/core";

/**
 * Persists router usage to the SQLite `model_calls` table so spend and the
 * monthly budget survive across CLI invocations.
 *
 * `sumModelCost` only reports a total, so `byTier` is always empty here; a
 * per-tier breakdown needs a store method that does not exist yet.
 */
export class SqliteUsageSink implements UsageSink {
  constructor(
    private readonly store: Pick<SqliteStore, "recordModelCall" | "sumModelCost">,
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
