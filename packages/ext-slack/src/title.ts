import type { Extractor, FactOrigin, NewFact } from "@yrm/core";
import type { UserMap } from "./convert.ts";
import { KV_NAMESPACE, SOURCE_NAME, titleKey, USERS_KEY } from "./settings.ts";
import type { Kv } from "./sync.ts";

export const TITLE_EXTRACTOR = "slack-title";
export const TITLE_VERSION = "1";
export const TITLE_ORIGIN: FactOrigin = { kind: "rule", by: SOURCE_NAME, version: TITLE_VERSION };
/** A profile title is self-reported and often stale, so below a header-derived fact. */
export const TITLE_CONFIDENCE = 0.7;

/** What was last recorded for a Slack user, so each title is recorded once. */
export interface RecordedTitle {
  title: string;
  entityId: string;
}

/**
 * Slack profiles carry a job title that mail rarely does. For every resolved
 * participant of a Slack event whose profile has one, propose an `attribute`
 * fact `title`, once per user and title (kv `slack/title/<userId>`). A changed
 * title is proposed again; the store's reconciliation decides which one wins.
 */
export function titleExtractor(kv: Kv): Extractor {
  return {
    name: TITLE_EXTRACTOR,
    version: TITLE_VERSION,
    applies: (event) => event.source === SOURCE_NAME,
    async extract(event) {
      const ids = event.meta["slackUserIds"];
      if (!Array.isArray(ids)) return [];
      const users = (await kv.kvGet<UserMap>(KV_NAMESPACE, USERS_KEY)) ?? {};
      const facts: NewFact[] = [];
      const done = new Set<string>();
      for (const [index, p] of event.participants.entries()) {
        const userId = ids[index];
        if (typeof userId !== "string" || done.has(userId) || p.entityId === undefined) continue;
        done.add(userId);
        const title = users[userId]?.title;
        if (!title) continue;
        const prior = await kv.kvGet<RecordedTitle>(KV_NAMESPACE, titleKey(userId));
        if (prior && prior.title === title && prior.entityId === p.entityId) continue;
        const name = p.name ?? users[userId]?.realName ?? users[userId]?.name;
        facts.push({
          type: "attribute",
          subject: name !== undefined ? { entityId: p.entityId, name } : { entityId: p.entityId },
          predicate: "title",
          value: { title },
          statement: `${name ?? "This person"}'s Slack profile title is ${title}.`,
          validFrom: event.occurredAt,
          provenance: [{ eventId: event.id }],
          confidence: TITLE_CONFIDENCE,
          origin: TITLE_ORIGIN,
          tags: ["slack-profile"],
        });
        await kv.kvSet<RecordedTitle>(KV_NAMESPACE, titleKey(userId), { title, entityId: p.entityId });
      }
      return facts;
    },
  };
}
