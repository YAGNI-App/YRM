import { describe, expect, it } from "bun:test";
import type { AskValue, CommitmentValue, TenantConfig } from "@yrm/core";
import { readSettings } from "../src/index.ts";
import { byRule, harness, ref } from "./helpers.ts";

/** Facts about September, all recorded on October 4: the shape of a fresh `yrm import`. */
async function importedLate() {
  const h = await harness();
  h.setClock("2026-10-04T15:00:00Z");
  const marcus = await h.person("Marcus Bell", "marcus@acme.example");
  const elena = await h.person("Elena Vasquez", "elena@acme.example");
  await h.fact<AskValue>({
    type: "ask",
    subject: ref(marcus),
    object: ref(h.me),
    value: { what: "Can we exit with no fee?", answered: false },
    validFrom: "2026-09-02T10:00:00Z",
  });
  await h.fact<CommitmentValue>({
    type: "commitment",
    predicate: "committed_to",
    subject: ref(h.me),
    object: ref(elena),
    value: { what: "Send the SOC 2 Type II report", owedBy: ref(h.me), owedTo: ref(elena), dueAt: "2026-09-30", status: "open" },
    validFrom: "2026-08-26T10:00:00Z",
  });
  return h;
}

describe("ranking a past day", () => {
  it("uses everything known now, so a corpus imported today still ranks for yesterday", async () => {
    const h = await importedLate();
    const items = await h.host.rank("2026-10-03");
    expect(byRule(items, "unanswered-ask")).toHaveLength(1);
    expect(byRule(items, "overdue-commitment")).toHaveLength(1);
  });

  it("with asOf, ranks on only what had been recorded by then", async () => {
    const h = await importedLate();
    const items = await h.host.rank("2026-10-03", { asOf: "2026-10-03T23:59:59.999Z" });
    expect(byRule(items, "unanswered-ask")).toHaveLength(0);
    expect(byRule(items, "overdue-commitment")).toHaveLength(0);
  });
});

describe("tenant fallback", () => {
  const tenant: TenantConfig = { id: "local", selfAddresses: ["Jack@Yagni.example"], selfDomains: ["yagni.example"], timezone: "America/Denver" };

  it("takes self addresses, domains and timezone from the tenant when settings omit them", () => {
    const s = readSettings(undefined, tenant);
    expect(s.selfAddresses).toEqual(["jack@yagni.example"]);
    expect(s.selfDomains).toEqual(["yagni.example"]);
    expect(s.timezone).toBe("America/Denver");
  });

  it("lets settings.attention override the tenant", () => {
    const s = readSettings({ selfAddresses: ["me@other.example"], timezone: "UTC" }, tenant);
    expect(s.selfAddresses).toEqual(["me@other.example"]);
    expect(s.selfDomains).toEqual(["yagni.example"]);
    expect(s.timezone).toBe("UTC");
  });
});
