import { describe, expect, it } from "bun:test";
import { list, parseFrontmatter, scalar } from "../src/frontmatter.ts";
import { attendee, parseNoteDate, slugify, toEvent } from "../src/to-event.ts";

describe("parseFrontmatter", () => {
  it("reads scalars, inline lists, block lists and comments", () => {
    const { data, body, hasFrontmatter } = parseFrontmatter(
      [
        "---",
        "date: 2026-06-16",
        'title: "Call: Acme # 2"',
        "attendees: [Jack@Yagni.example, 'priya@acme.example']",
        "# a comment",
        "tags:",
        "  - acme",
        "  - pilot # inline comment",
        "event: abc@yagni.example",
        "---",
        "",
        "# Heading",
        "Body text.",
      ].join("\n"),
    );
    expect(hasFrontmatter).toBe(true);
    expect(data).toEqual({
      date: "2026-06-16",
      title: "Call: Acme # 2",
      attendees: ["Jack@Yagni.example", "priya@acme.example"],
      tags: ["acme", "pilot"],
      event: "abc@yagni.example",
    });
    expect(body).toBe("# Heading\nBody text.");
  });

  it("accepts unindented block lists and CRLF", () => {
    const { data } = parseFrontmatter("---\r\nattendees:\r\n- a@x.example\r\n- b@x.example\r\n---\r\nhi");
    expect(data["attendees"]).toEqual(["a@x.example", "b@x.example"]);
  });

  it("keeps structures it does not understand as strings", () => {
    const { data } = parseFrontmatter("---\nmeeting:\n  room: 4\n  floor: 2\nsummary: |\n  line one\n  line two\n---\n");
    expect(data["meeting"]).toBe("  room: 4\n  floor: 2");
    expect(data["summary"]).toBe("  line one\n  line two");
  });

  it("treats a document without a closed fence as all body", () => {
    expect(parseFrontmatter("---\ntitle: x\nno close")).toEqual({ data: {}, body: "---\ntitle: x\nno close", hasFrontmatter: false });
    expect(parseFrontmatter("# Just a note").hasFrontmatter).toBe(false);
  });

  it("scalar and list helpers normalise shapes", () => {
    const data = { a: "x, y", b: ["z"], c: "" };
    expect(list(data, "a")).toEqual(["x", "y"]);
    expect(scalar(data, "b")).toBe("z");
    expect(scalar(data, "c")).toBeUndefined();
    expect(list(data, "missing")).toEqual([]);
  });
});

describe("note helpers", () => {
  it("parses attendee forms and lowercases addresses", () => {
    expect(attendee("Priya Raman <Priya.Raman@Acme.example>")).toEqual({ role: "attendee", address: "priya.raman@acme.example", name: "Priya Raman" });
    expect(attendee("Tom@Acme.example")).toEqual({ role: "attendee", address: "tom@acme.example" });
    expect(attendee("Marcus")).toEqual({ role: "attendee", name: "Marcus" });
  });

  it("parses dates and slugs", () => {
    expect(parseNoteDate("2026-06-16")).toBe("2026-06-16T00:00:00.000Z");
    expect(parseNoteDate("2026-06-16T10:00:00-06:00")).toBe("2026-06-16T16:00:00.000Z");
    expect(parseNoteDate("someday")).toBeNull();
    expect(slugify("Café: Acme / Pilot  scoping!")).toBe("cafe-acme-pilot-scoping");
  });
});

describe("toEvent", () => {
  const mtime = new Date("2026-07-01T12:00:00.000Z");

  it("falls back to the first heading and mtime, and hashes content", () => {
    const { event, warnings } = toEvent({ path: "sub/plain.md", raw: "Intro\n\n# Weekly sync\n\nNotes.", mtime });
    expect(warnings).toEqual([]);
    expect(event).toMatchObject({
      source: "notes",
      kind: "note",
      externalId: "sub/plain.md",
      occurredAt: "2026-07-01T12:00:00.000Z",
      participants: [{ role: "author", self: true }],
      content: { title: "Weekly sync", text: "Intro\n\n# Weekly sync\n\nNotes." },
      threadKey: "notes:weekly-sync",
      meta: { path: "sub/plain.md", tags: [], frontmatter: {} },
    });
    expect(event.meta["contentHash"]).toMatch(/^[0-9a-f]{64}$/);
    expect(toEvent({ path: "sub/plain.md", raw: "Intro\n\n# Weekly sync\n\nEdited.", mtime }).event.meta["contentHash"]).not.toBe(
      event.meta["contentHash"],
    );
  });

  it("falls back to the filename and warns on a bad date", () => {
    const { event, warnings } = toEvent({ path: "2026-07-01-standup.md", raw: "---\ndate: soon\n---\nno heading", mtime });
    expect(event.content.title).toBe("2026-07-01-standup");
    expect(event.occurredAt).toBe(mtime.toISOString());
    expect(warnings[0]).toContain("soon");
  });
});
