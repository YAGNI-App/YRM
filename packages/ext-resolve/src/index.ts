import type { ExtensionAPI, ExtensionManifest } from "@yrm/core";
import { headerResolver } from "./header.ts";
import { jobChangeExtractor } from "./job-change.ts";
import { mergeCommand, nameLinkResolver, suggestionsCommand, suggestSameName } from "./names.ts";
import { readSettings } from "./settings.ts";

export const manifest: ExtensionManifest = {
  name: "resolve",
  description: "Addresses to people, domains to organizations, same-name merge suggestions, job-change signals.",
};

export {
  baseAddress,
  DEFAULT_FREEMAIL_DOMAINS,
  displayNameFromHeader,
  domainOf,
  isFreemail,
  isFullName,
  nameFromLocalPart,
  normalizeAddress,
  normalizeName,
  orgNameFromDomain,
} from "./normalize.ts";
export { JOB_CHANGE_TRIGGER, parseJobChange, type JobChangeValue } from "./job-change.ts";
export { listSuggestions, suggestionKey, type MergeSuggestion } from "./names.ts";
export type { ResolveSettings } from "./settings.ts";

/**
 * Note on hooks: entities created here are not announced through
 * `entity:proposed`. Resolvers receive no hook bus, and the host does not fire
 * that hook itself yet.
 */
export default function resolve(yrm: ExtensionAPI): void {
  const settings = readSettings(yrm.config);
  yrm.registerResolver(headerResolver(settings));
  yrm.registerResolver(nameLinkResolver());
  yrm.on("resolve:after", async (ctx, event, entities) => {
    await suggestSameName({ store: ctx.store, tenantId: ctx.tenantId, log: yrm.log, settings }, event, entities);
  });
  yrm.registerExtractor(jobChangeExtractor());
  yrm.registerCommand(suggestionsCommand());
  yrm.registerCommand(mergeCommand());
}
