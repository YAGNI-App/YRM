import type { Usage } from "../contracts/models.ts";

/** One model call as the router saw it. Persisted to `model_calls` by the store-backed sink. */
export interface ModelCallRecord {
  tenantId: string;
  tier: string;
  /** "complete" or "embed". */
  kind: "complete" | "embed";
  provider: string;
  model: string;
  /** ISO 8601. */
  at: string;
  latencyMs: number;
  /** `costUsd` is always filled; zero when the route has no known pricing. */
  usage: Usage & { costUsd: number };
  /** False when the provider answered but the router rejected the answer (schema mismatch). */
  ok: boolean;
  errorCode?: string;
  meta?: Record<string, unknown>;
}

/**
 * Where the router writes usage. The host wires a store-backed sink; tests and
 * dev use `MemoryUsageSink`.
 */
export interface UsageSink {
  record(entry: ModelCallRecord): Promise<void>;
  /** Spend since the start of the current UTC month. */
  monthToDate(tenantId: string): Promise<{ usd: number; byTier: Record<string, number> }>;
}

export function monthStart(now: Date): Date {
  return new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), 1));
}

export class MemoryUsageSink implements UsageSink {
  readonly records: ModelCallRecord[] = [];
  private readonly now: () => Date;

  constructor(opts: { now?: () => Date } = {}) {
    this.now = opts.now ?? (() => new Date());
  }

  async record(entry: ModelCallRecord): Promise<void> {
    this.records.push(entry);
  }

  async monthToDate(tenantId: string): Promise<{ usd: number; byTier: Record<string, number> }> {
    const since = monthStart(this.now()).getTime();
    const byTier: Record<string, number> = {};
    let usd = 0;
    for (const r of this.records) {
      if (r.tenantId !== tenantId || Date.parse(r.at) < since) continue;
      usd += r.usage.costUsd;
      byTier[r.tier] = (byTier[r.tier] ?? 0) + r.usage.costUsd;
    }
    return { usd, byTier };
  }
}
