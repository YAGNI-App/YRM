import type { QueueItem, Store } from "@yrm/core";

/** Shared with the attention extension: dismissals and the daily brief live here. */
export const ATTENTION_NS = "attention";

export interface Dismissal {
  key: string;
  /** ISO date the item may reappear on; null hides it until the ranker stops proposing it. */
  until: string | null;
  by: string;
  at: string;
}

export function dismissKey(key: string): string {
  return `dismiss:${key}`;
}

export async function dismiss(store: Store, d: Dismissal): Promise<void> {
  await store.kvSet(ATTENTION_NS, dismissKey(d.key), d);
}

/**
 * Drop dismissed items. A dismissal whose `until` date has arrived is deleted
 * so the item comes back and stays back until dismissed again.
 */
export async function dropDismissed(store: Store, items: QueueItem[], today: string): Promise<QueueItem[]> {
  const out: QueueItem[] = [];
  for (const item of items) {
    const d = await store.kvGet<Dismissal>(ATTENTION_NS, dismissKey(item.key));
    if (d === null) {
      out.push(item);
      continue;
    }
    if (d.until !== null && d.until.slice(0, 10) <= today) {
      await store.kvDelete(ATTENTION_NS, dismissKey(item.key));
      out.push(item);
    }
  }
  return out;
}
