/**
 * Structural checks for the Acme fixture corpus. These guard the corpus, not
 * any ingester: if a hand edit breaks threading, chronology or the ground
 * truth's references, this fails before an extractor benchmark silently
 * measures the wrong thing. Parsers here are deliberately minimal.
 */
import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = import.meta.dir;

interface Mail {
  file: string;
  headers: Map<string, string[]>;
  body: string;
}

function parseHeaders(block: string): Map<string, string[]> {
  const headers = new Map<string, string[]>();
  // RFC 5322 folding: a line starting with whitespace continues the previous header.
  const unfolded = block.replace(/\r?\n[ \t]+/g, " ");
  for (const line of unfolded.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) throw new Error(`malformed header line: ${line}`);
    const name = line.slice(0, i).trim().toLowerCase();
    const list = headers.get(name) ?? [];
    list.push(line.slice(i + 1).trim());
    headers.set(name, list);
  }
  return headers;
}

function parseMail(file: string, raw: string): Mail {
  const sep = raw.search(/\r?\n\r?\n/);
  if (sep < 0) throw new Error(`${file}: no header/body separator`);
  return { file, headers: parseHeaders(raw.slice(0, sep)), body: raw.slice(sep).trim() };
}

function header(m: Mail, name: string): string | undefined {
  return m.headers.get(name)?.[0];
}

function addresses(value: string | undefined): string[] {
  if (!value) return [];
  return [...value.matchAll(/<([^<>\s]+@[^<>\s]+)>/g)].map((x) => x[1]!.toLowerCase());
}

interface VEvent {
  props: Map<string, string[]>;
}

function parseIcs(raw: string): VEvent[] {
  const lines = raw.replace(/\r?\n[ \t]/g, "").split(/\r?\n/).filter((l) => l.length > 0);
  if (lines[0] !== "BEGIN:VCALENDAR" || lines.at(-1) !== "END:VCALENDAR") throw new Error("not a VCALENDAR");
  const events: VEvent[] = [];
  let cur: VEvent | undefined;
  for (const line of lines) {
    if (line === "BEGIN:VEVENT") cur = { props: new Map() };
    else if (line === "END:VEVENT") {
      if (!cur) throw new Error("END:VEVENT without BEGIN");
      events.push(cur);
      cur = undefined;
    } else if (cur) {
      const i = line.indexOf(":");
      const name = line.slice(0, i).split(";")[0]!.toUpperCase();
      const list = cur.props.get(name) ?? [];
      list.push(line);
      cur.props.set(name, list);
    }
  }
  return events;
}

function propValue(line: string | undefined): string | undefined {
  return line === undefined ? undefined : line.slice(line.indexOf(":") + 1);
}

interface Note {
  path: string;
  date: string;
  attendees: string[];
}

function parseNote(path: string, raw: string): Note {
  const m = /^---\n([\s\S]*?)\n---\n/.exec(raw);
  if (!m) throw new Error(`${path}: missing frontmatter`);
  const fm = m[1]!;
  const date = /^date:\s*(\S+)/m.exec(fm)?.[1];
  if (!date) throw new Error(`${path}: missing date`);
  const attendees = [...fm.matchAll(/^\s+-\s+(\S+@\S+)\s*$/gm)].map((x) => x[1]!);
  return { path, date, attendees };
}

interface GroundTruth {
  corpus: { start: string; end: string; counts: { messages: number; noise: number; calendarEvents: number; notes: number } };
  tenant: { selfAddresses: string[]; selfDomains: string[] };
  noise: string[];
  organizations: { domain: string; name: string }[];
  people: { key: string; name: string; addresses: string[]; organizations: { domain: string; validFrom: string; validTo?: string }[] }[];
  facts: {
    id: string;
    type: string;
    subject: string;
    object?: string;
    statement: string;
    evidence: string[];
    resolvedBy?: string;
    answeredBy?: string;
    status?: string;
    dueAt?: string;
  }[];
  expectedQueueOn: Record<string, { kind: string; about: string; fact?: string; evidence?: string[] }[]>;
}

const mailDir = join(ROOT, "mail");
const mailFiles = readdirSync(mailDir).filter((f) => f.endsWith(".eml")).sort();
const mails = mailFiles.map((f) => parseMail(f, readFileSync(join(mailDir, f), "utf8")));
const icsRaw = readFileSync(join(ROOT, "calendar", "acme.ics"), "utf8");
const vevents = parseIcs(icsRaw);
const noteFiles = readdirSync(join(ROOT, "notes")).filter((f) => f.endsWith(".md")).sort();
const notes = noteFiles.map((f) => parseNote(`notes/${f}`, readFileSync(join(ROOT, "notes", f), "utf8")));
const gt = JSON.parse(readFileSync(join(ROOT, "ground-truth.json"), "utf8")) as GroundTruth;

const messageIds = new Map<string, Mail>();
for (const m of mails) {
  const id = header(m, "message-id");
  if (id) messageIds.set(id, m);
}
const uids = new Set(vevents.map((e) => propValue(e.props.get("UID")?.[0]) ?? ""));
const notePaths = new Set(notes.map((n) => n.path));
const corpusIds = new Set<string>([...messageIds.keys(), ...uids, ...notePaths]);

function isBulk(m: Mail): boolean {
  const from = addresses(header(m, "from"))[0] ?? "";
  return (
    m.headers.has("list-unsubscribe") ||
    /bulk|list|junk/i.test(header(m, "precedence") ?? "") ||
    /^(no-?reply|do-?not-?reply)@/.test(from) ||
    (header(m, "auto-submitted") ?? "no") !== "no"
  );
}

describe("acme corpus: mail", () => {
  test("files are numbered NNN-slug.eml without gaps", () => {
    expect(mailFiles.length).toBeGreaterThanOrEqual(35);
    mailFiles.forEach((f, i) => {
      expect(f).toMatch(/^\d{3}-[a-z0-9-]+\.eml$/);
      expect(Number(f.slice(0, 3))).toBe(i + 1);
    });
  });

  test("required headers are present and well formed", () => {
    for (const m of mails) {
      for (const h of ["message-id", "date", "from", "to", "subject", "content-type"]) {
        expect(header(m, h), `${m.file}: ${h}`).toBeDefined();
      }
      expect(header(m, "message-id"), m.file).toMatch(/^<[^<>@\s]+@[^<>@\s]+>$/);
      expect(header(m, "content-type"), m.file).toBe("text/plain; charset=utf-8");
      expect(addresses(header(m, "from")).length, m.file).toBe(1);
      expect(m.body.length, m.file).toBeGreaterThan(0);
    }
  });

  test("Message-IDs are unique", () => {
    expect(messageIds.size).toBe(mails.length);
  });

  test("replies point at earlier messages in the corpus", () => {
    const seen = new Set<string>();
    for (const m of mails) {
      const irt = header(m, "in-reply-to");
      if (irt) {
        expect(seen.has(irt), `${m.file}: In-Reply-To ${irt}`).toBe(true);
        expect(header(m, "subject"), m.file).toMatch(/^Re: /);
        const refs = (header(m, "references") ?? "").split(/\s+/).filter(Boolean);
        expect(refs.at(-1), `${m.file}: References must end with In-Reply-To`).toBe(irt);
        for (const r of refs) expect(seen.has(r), `${m.file}: References ${r}`).toBe(true);
      }
      seen.add(header(m, "message-id")!);
    }
  });

  test("dates parse, weekdays are right, and files are chronological", () => {
    const start = Date.parse(`${gt.corpus.start}T00:00:00Z`);
    const end = Date.parse(`${gt.corpus.end}T23:59:59Z`);
    let prev = -Infinity;
    for (const m of mails) {
      const raw = header(m, "date")!;
      const t = Date.parse(raw);
      expect(Number.isNaN(t), `${m.file}: ${raw}`).toBe(false);
      const parts = /^(\w{3}), (\d{2}) (\w{3}) (\d{4}) \d{2}:\d{2}:\d{2} [+-]\d{4}$/.exec(raw);
      expect(parts, `${m.file}: RFC 2822 date`).not.toBeNull();
      const local = new Date(Date.parse(`${parts![2]} ${parts![3]} ${parts![4]} 00:00:00 UTC`));
      expect(["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][local.getUTCDay()], `${m.file}: weekday`).toBe(parts![1]!);
      expect(t, `${m.file}: chronological`).toBeGreaterThanOrEqual(prev);
      expect(t >= start && t <= end, `${m.file}: inside corpus window`).toBe(true);
      prev = t;
    }
  });

  test("noise is exactly the bulk/automated mail", () => {
    const noise = new Set(gt.noise);
    for (const m of mails) {
      expect(isBulk(m), `${m.file}`).toBe(noise.has(header(m, "message-id")!));
    }
  });

  test("enough quoted replies and signatures for tier 0 stripping", () => {
    const quoted = mails.filter((m) => /^On .+ wrote:$/m.test(m.body) && /^> /m.test(m.body));
    const signed = mails.filter((m) => /^-- ?$/m.test(m.body));
    expect(quoted.length).toBeGreaterThanOrEqual(5);
    expect(signed.length).toBeGreaterThanOrEqual(5);
  });
});

describe("acme corpus: calendar", () => {
  test("VEVENTs have unique UIDs and required properties", () => {
    expect(vevents.length).toBe(gt.corpus.counts.calendarEvents);
    expect(uids.size).toBe(vevents.length);
    for (const e of vevents) {
      for (const p of ["UID", "DTSTAMP", "DTSTART", "DTEND", "SUMMARY", "DESCRIPTION", "ORGANIZER", "STATUS"]) {
        expect(e.props.has(p), `${propValue(e.props.get("UID")?.[0])}: ${p}`).toBe(true);
      }
      const attendees = e.props.get("ATTENDEE") ?? [];
      expect(attendees.length).toBeGreaterThanOrEqual(3);
      for (const a of attendees) expect(a).toMatch(/;CN=[^;:]+.*:mailto:\S+@\S+$/);
    }
  });

  test("exactly one meeting is cancelled", () => {
    const cancelled = vevents.filter((e) => propValue(e.props.get("STATUS")?.[0]) === "CANCELLED");
    expect(cancelled.length).toBe(1);
  });

  test("lines are folded at 75 octets with CRLF endings", () => {
    for (const line of icsRaw.split("\r\n")) expect(new TextEncoder().encode(line).length).toBeLessThanOrEqual(75);
    expect(icsRaw.replace(/\r\n/g, "").includes("\n")).toBe(false);
  });
});

describe("acme corpus: notes", () => {
  test("notes have a date matching the filename and attendee emails", () => {
    expect(notes.length).toBe(gt.corpus.counts.notes);
    for (const n of notes) {
      expect(n.path).toMatch(/^notes\/\d{4}-\d{2}-\d{2}-[a-z0-9-]+\.md$/);
      expect(n.path.slice(6, 16)).toBe(n.date);
      expect(n.attendees.length).toBeGreaterThan(0);
      expect(n.attendees).toContain(gt.tenant.selfAddresses[0]!);
    }
  });
});

describe("acme corpus: ground truth", () => {
  const personKeys = new Set(gt.people.map((p) => p.key));
  const orgDomains = new Set(gt.organizations.map((o) => o.domain));
  const isKnown = (k: string) => personKeys.has(k) || orgDomains.has(k);

  test("counts match the corpus", () => {
    expect(gt.corpus.counts.messages).toBe(mails.length);
    expect(gt.corpus.counts.noise).toBe(gt.noise.length);
    expect(gt.facts.length).toBeGreaterThanOrEqual(15);
    expect(gt.facts.length).toBeLessThanOrEqual(25);
  });

  test("every referenced id exists in the corpus", () => {
    for (const id of gt.noise) expect(messageIds.has(id), `noise ${id}`).toBe(true);
    for (const f of gt.facts) {
      expect(f.evidence.length, f.id).toBeGreaterThan(0);
      for (const e of f.evidence) expect(corpusIds.has(e), `${f.id} evidence ${e}`).toBe(true);
      if (f.resolvedBy) expect(corpusIds.has(f.resolvedBy), `${f.id} resolvedBy`).toBe(true);
      if (f.answeredBy) expect(corpusIds.has(f.answeredBy), `${f.id} answeredBy`).toBe(true);
      for (const e of f.evidence) expect(gt.noise.includes(e), `${f.id} cites noise`).toBe(false);
    }
    const factIds = new Set(gt.facts.map((f) => f.id));
    expect(factIds.size).toBe(gt.facts.length);
    for (const [day, items] of Object.entries(gt.expectedQueueOn)) {
      for (const q of items) {
        expect(isKnown(q.about), `${day} ${q.kind} about ${q.about}`).toBe(true);
        if (q.fact) expect(factIds.has(q.fact), `${day} ${q.kind} fact`).toBe(true);
        for (const e of q.evidence ?? []) expect(corpusIds.has(e), `${day} ${q.kind} evidence ${e}`).toBe(true);
      }
    }
  });

  test("facts reference defined people and organizations", () => {
    for (const f of gt.facts) {
      expect(isKnown(f.subject), `${f.id} subject ${f.subject}`).toBe(true);
      if (f.object !== undefined) expect(isKnown(f.object), `${f.id} object ${f.object}`).toBe(true);
    }
    for (const p of gt.people) {
      for (const o of p.organizations) expect(orgDomains.has(o.domain), `${p.key} org ${o.domain}`).toBe(true);
    }
  });

  test("the required beats are present", () => {
    const of = (type: string) => gt.facts.filter((f) => f.type === type);
    const commitments = of("commitment");
    expect(commitments.length).toBeGreaterThanOrEqual(4);
    expect(commitments.every((c) => c.dueAt !== undefined)).toBe(true);
    expect(commitments.some((c) => c.status === "fulfilled")).toBe(true);
    expect(commitments.some((c) => c.status === "broken")).toBe(true);
    expect(commitments.some((c) => c.status === "open")).toBe(true);
    expect(of("ask").length).toBeGreaterThanOrEqual(3);
    expect(of("decision").length).toBeGreaterThanOrEqual(1);
    expect(of("objection").length).toBeGreaterThanOrEqual(1);
    expect(of("signal").length).toBeGreaterThanOrEqual(2);
    expect(of("role").length).toBeGreaterThanOrEqual(2);
  });

  test("every person's addresses actually appear in the corpus", () => {
    const seen = new Set<string>();
    for (const m of mails) for (const h of ["from", "to", "cc"]) for (const a of addresses(header(m, h))) seen.add(a);
    for (const e of vevents) for (const l of [...(e.props.get("ATTENDEE") ?? []), ...(e.props.get("ORGANIZER") ?? [])]) {
      seen.add(l.slice(l.indexOf("mailto:") + 7).toLowerCase());
    }
    for (const n of notes) for (const a of n.attendees) seen.add(a);
    for (const p of gt.people) for (const a of p.addresses) expect(seen.has(a), `${p.key} ${a}`).toBe(true);
    // And every non-noise correspondent is someone the ground truth knows.
    const known = new Set(gt.people.flatMap((p) => p.addresses));
    const noise = new Set(gt.noise);
    for (const m of mails) {
      if (noise.has(header(m, "message-id")!)) continue;
      for (const h of ["from", "to", "cc"]) for (const a of addresses(header(m, h))) expect(known.has(a), `${m.file} ${a}`).toBe(true);
    }
  });

  test("Acme goes quiet: no inbound Acme mail after the last one cited", () => {
    const noise = new Set(gt.noise);
    const acme = mails.filter(
      (m) => !noise.has(header(m, "message-id")!) && addresses(header(m, "from"))[0]!.endsWith("@acme-robotics.example"),
    );
    const last = Date.parse(header(acme.at(-1)!, "date")!);
    const asOf = Date.parse(`${gt.corpus.end}T23:59:59Z`);
    expect((asOf - last) / 86_400_000).toBeGreaterThanOrEqual(21);
  });
});
