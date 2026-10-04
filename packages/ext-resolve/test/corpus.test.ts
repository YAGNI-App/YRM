import { describe, expect, it } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { NewSourceEvent, Participant } from "@yrm/core";
import { listSuggestions } from "../src/index.ts";
import { ingestAndResolve, runCommand, setup, TENANT } from "./helpers.ts";

const ROOT = join(import.meta.dir, "../../../fixtures/acme");

interface GroundTruth {
  freemailDomains: string[];
  noise: string[];
  people: Array<{ key: string; name: string; addresses: string[]; organizations: Array<{ domain: string; validFrom: string }> }>;
  organizations: Array<{ domain: string; name: string; self?: boolean }>;
}
const truth = JSON.parse(readFileSync(join(ROOT, "ground-truth.json"), "utf8")) as GroundTruth;

// Just enough RFC 5322 to get participants and threading; @yrm/ext-mail does the real job.
function parseEml(raw: string): { event: NewSourceEvent; bulk: boolean } {
  const [head = "", ...rest] = raw.replace(/\r\n/g, "\n").split("\n\n");
  const headers = new Map<string, string>();
  for (const line of head.replace(/\n[ \t]+/g, " ").split("\n")) {
    const i = line.indexOf(":");
    if (i > 0) headers.set(line.slice(0, i).toLowerCase(), line.slice(i + 1).trim());
  }
  const people = (role: string, v = ""): Participant[] =>
    [...v.matchAll(/(?:"?([^",<]*?)"?\s*)?<([^>]+)>|([^\s,<>]+@[^\s,<>]+)/g)].map((m) => {
      const p: Participant = { role, address: (m[2] ?? m[3] ?? "").toLowerCase() };
      if (m[1]?.trim()) p.name = m[1].trim();
      return p;
    });
  const id = headers.get("message-id") ?? "";
  const refs = (headers.get("references") ?? headers.get("in-reply-to") ?? "").match(/<[^>]+>/g) ?? [];
  // content.text is new text only: no quoted history, no signature.
  const text = rest.join("\n\n").split(/\n-- \n/)[0]!.split("\n").filter((l) => !l.startsWith(">")).join("\n").trim();
  return {
    bulk: headers.has("precedence") || headers.has("auto-submitted") || headers.has("list-unsubscribe"),
    event: {
      source: "fake",
      kind: "message",
      externalId: id,
      occurredAt: new Date(headers.get("date") ?? "").toISOString(),
      threadKey: refs[0] ?? id,
      participants: [...people("from", headers.get("from")), ...people("to", headers.get("to")), ...people("cc", headers.get("cc"))],
      content: { text, title: headers.get("subject") ?? "" },
      meta: {},
    },
  };
}

function loadMail(): NewSourceEvent[] {
  const dir = join(ROOT, "mail");
  const parsed = readdirSync(dir)
    .filter((f) => f.endsWith(".eml"))
    .sort()
    .map((f) => parseEml(readFileSync(join(dir, f), "utf8")));
  const noise = parsed.filter((p) => p.bulk).map((p) => p.event.externalId);
  expect(noise.sort()).toEqual([...truth.noise].sort());
  return parsed.filter((p) => !p.bulk).map((p) => p.event);
}

describe("Acme corpus", () => {
  it("resolves to the ground-truth people and organizations once suggestions are merged", async () => {
    const { host, store } = await setup({ freemailDomains: truth.freemailDomains });
    const events = await ingestAndResolve(host, loadMail());
    expect(events.length).toBe(33);

    const suggestions = await listSuggestions(store, TENANT);
    const named = async (id: string) => (await store.getEntity(id))?.name;
    expect((await Promise.all(suggestions.map((s) => named(s.from)))).sort()).toEqual(["Priya Raman", "Tom Fischer"]);
    for (const s of suggestions) {
      expect((await runCommand(host, "resolve:merge", [s.from, s.into], { user: "jack" })).code).toBe(0);
    }
    expect(await listSuggestions(store, TENANT)).toEqual([]);

    const people = (await store.findEntities({ tenantId: TENANT, kind: "person" })).filter((p) => p.status !== "merged");
    const actual = people
      .map((p) => ({ name: p.name, addresses: p.identifiers.filter((i) => i.type === "email").map((i) => i.value).sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    const expected = truth.people
      .map((p) => ({ name: p.name, addresses: [...p.addresses].sort() }))
      .sort((a, b) => a.name.localeCompare(b.name));
    expect(actual).toEqual(expected);

    const orgs = await store.findEntities({ tenantId: TENANT, kind: "organization" });
    const domainOf = (id: string) => orgs.find((o) => o.id === id)?.identifiers.find((i) => i.type === "domain")?.value;
    expect(orgs.map((o) => domainOf(o.id)).sort()).toEqual(truth.organizations.map((o) => o.domain).sort());
    for (const o of truth.organizations) {
      const org = orgs.find((x) => domainOf(x.id) === o.domain)!;
      expect(org.status).toBe(o.self ? "confirmed" : "proposed");
      // "Northwind Automation" is not recoverable from northwind.example; the domain-derived name is "Northwind".
      if (o.domain !== "northwind.example") expect(org.name).toBe(o.name);
    }

    // Every employment the story has is a works_at, starting no earlier than the truth says.
    for (const p of truth.people) {
      const person = people.find((x) => x.name === p.name)!;
      const facts = await store.queryFacts({ tenantId: TENANT, subjectId: person.id, predicate: "works_at" });
      expect(facts.map((f) => domainOf(f.object!.entityId)).sort()).toEqual(p.organizations.map((o) => o.domain).sort());
      for (const o of p.organizations) {
        const f = facts.find((x) => domainOf(x.object!.entityId) === o.domain)!;
        expect(f.validFrom >= o.validFrom).toBe(true);
      }
      expect(person.summary?.parentId).toBeDefined();
    }

    // The quarantined goodbye: true on August 14, recorded whenever we imported it.
    const leaving = events.find((e) => e.externalId === "<202608141702.leaving@acme-robotics.example>")!;
    const { facts } = await host.extract(leaving);
    const priya = people.find((p) => p.name === "Priya Raman")!;
    expect(facts.map((f) => [f.predicate, f.subject.entityId, f.validFrom, f.value])).toEqual([
      ["job_change", priya.id, leaving.occurredAt, { leaving: "Acme", joining: "Northwind Automation" }],
    ]);
    await host.close();
  });
});
