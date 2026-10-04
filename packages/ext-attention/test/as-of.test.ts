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

  it("with asOf, ranks on only what was known by then (here: recorded and known on Oct 4)", async () => {
    const h = await importedLate();
    const items = await h.host.rank("2026-10-03", { asOf: "2026-10-03T23:59:59.999Z" });
    expect(byRule(items, "unanswered-ask")).toHaveLength(0);
    expect(byRule(items, "overdue-commitment")).toHaveLength(0);
  });
});

/**
 * The same import as the host does it (ADR 0008): recorded on October 4, but
 * each fact known from when its message arrived.
 */
async function importedWithKnownAt() {
  const h = await harness();
  h.setClock("2026-10-04T15:00:00Z");
  const marcus = await h.person("Marcus Bell", "marcus@acme.example");
  const elena = await h.person("Elena Vasquez", "elena@acme.example");
  const tom = await h.person("Tom Fischer", "tom@acme.example");
  await h.fact<AskValue>({
    type: "ask",
    subject: ref(marcus),
    object: ref(h.me),
    value: { what: "Can we exit with no fee?", answered: false },
    validFrom: "2026-09-02T10:00:00Z",
    knownAt: "2026-09-02T10:00:00Z",
  });
  await h.fact<CommitmentValue>({
    type: "commitment",
    predicate: "committed_to",
    subject: ref(h.me),
    object: ref(elena),
    value: { what: "Send the SOC 2 Type II report", owedBy: ref(h.me), owedTo: ref(elena), dueAt: "2026-09-30", status: "open" },
    validFrom: "2026-08-26T10:00:00Z",
    knownAt: "2026-08-26T10:00:00Z",
  });
  await h.fact<CommitmentValue>({
    type: "commitment",
    predicate: "committed_to",
    subject: ref(tom),
    object: ref(h.me),
    value: { what: "Install the agent on the test VLAN", owedBy: ref(tom), owedTo: ref(h.me), dueAt: "2026-08-14", status: "open" },
    validFrom: "2026-07-30T10:00:00Z",
    knownAt: "2026-07-30T10:00:00Z",
  });
  return h;
}

describe("ranking a past day on imported history", () => {
  it("today --date 2026-10-03 --as-of 2026-08-20 hides what was not yet known", async () => {
    const h = await importedWithKnownAt();
    const items = await h.host.rank("2026-10-03", { asOf: "2026-08-20T23:59:59.999Z" });
    // Marcus asked on Sept 2 and the Type II promise was made on Aug 26: not known on Aug 20.
    expect(byRule(items, "unanswered-ask")).toHaveLength(0);
    const overdue = byRule(items, "overdue-commitment");
    expect(overdue.map((i) => i.action)).toEqual([expect.stringContaining("test VLAN")]);
  });

  it("with asOf on the day itself, sees everything received by then although it was imported later", async () => {
    const h = await importedWithKnownAt();
    const items = await h.host.rank("2026-10-03", { asOf: "2026-10-03T23:59:59.999Z" });
    expect(byRule(items, "unanswered-ask")).toHaveLength(1);
    expect(byRule(items, "overdue-commitment")).toHaveLength(2);
  });

  it("dates a job change from when it was known, not when it was imported", async () => {
    const h = await harness();
    h.setClock("2026-10-04T15:00:00Z");
    const acme = await h.org("Acme Robotics", "acme.example");
    const nw = await h.org("Northwind", "northwind.example");
    const priya = await h.person("Priya Raman", "priya@acme.example", acme.id);
    await h.fact({ type: "relationship", predicate: "works_at", subject: ref(priya), object: ref(acme), value: {}, validFrom: "2026-06-01T00:00:00Z", knownAt: "2026-06-01T00:00:00Z" });
    await h.fact({
      type: "signal",
      predicate: "job_change",
      subject: ref(priya),
      value: { leaving: ref(acme), joining: ref(nw) },
      validFrom: "2026-08-14T00:00:00Z",
      knownAt: "2026-09-03T09:00:00Z",
    });
    const at = (day: string) => h.host.rank(day, { asOf: `${day}T23:59:59.999Z` });
    expect(byRule(await at("2026-08-20"), "job-change")).toHaveLength(0);
    const [item] = byRule(await at("2026-09-05"), "job-change");
    expect(item?.reason).toContain("learned on 2026-09-03");
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
