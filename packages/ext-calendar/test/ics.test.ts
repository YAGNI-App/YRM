import { describe, expect, it } from "bun:test";
import { parseDuration, parseIcs, parseProperty, unescapeText, unfold, zonedToUtc } from "../src/ics.ts";
import { toEvent } from "../src/to-event.ts";

const cal = (...lines: string[]): string => ["BEGIN:VCALENDAR", "VERSION:2.0", ...lines, "END:VCALENDAR"].join("\r\n");

describe("unfold", () => {
  it("joins CRLF and LF continuations starting with a space or tab", () => {
    expect(unfold("A:one\r\n two\r\nB:x\n\tyz\r\n")).toEqual(["A:onetwo", "B:xyz"]);
  });
});

describe("parseProperty", () => {
  it("splits name, parameters and value", () => {
    expect(parseProperty("DTSTART;TZID=America/Denver:20260615T100000")).toEqual({
      name: "DTSTART",
      params: { TZID: "America/Denver" },
      value: "20260615T100000",
    });
    expect(parseProperty("ATTENDEE;CN=Name;PARTSTAT=ACCEPTED:mailto:x@y")).toEqual({
      name: "ATTENDEE",
      params: { CN: "Name", PARTSTAT: "ACCEPTED" },
      value: "mailto:x@y",
    });
  });

  it("keeps colons and semicolons inside quoted parameter values", () => {
    expect(parseProperty('ATTENDEE;CN="Bell; Marcus: VP":mailto:M@X.example')).toEqual({
      name: "ATTENDEE",
      params: { CN: "Bell; Marcus: VP" },
      value: "mailto:M@X.example",
    });
  });
});

describe("unescapeText", () => {
  it("unescapes newlines, commas, semicolons and backslashes", () => {
    expect(unescapeText("a\\nb\\Nc\\, d\\; e\\\\f")).toBe("a\nb\nc, d; e\\f");
  });
});

describe("dates", () => {
  it("converts TZID wall time with the zone's offset (Denver is UTC-6 in June, UTC-7 in January)", () => {
    const { events } = parseIcs(
      cal(
        "BEGIN:VEVENT",
        "UID:tz-1",
        "DTSTART;TZID=America/Denver:20260615T100000",
        "DTEND;TZID=America/Denver:20260615T113000",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:tz-2",
        "DTSTART;TZID=America/Denver:20260115T100000",
        "END:VEVENT",
      ),
    );
    expect(events[0]!.start).toEqual({ iso: "2026-06-15T16:00:00.000Z", allDay: false, tzid: "America/Denver" });
    expect(events[0]!.end!.iso).toBe("2026-06-15T17:30:00.000Z");
    expect(events[1]!.start!.iso).toBe("2026-01-15T17:00:00.000Z");
  });

  it("handles a time across a DST transition", () => {
    // 2026-03-08 03:30 in Denver is just after spring-forward: UTC-6.
    expect(new Date(zonedToUtc(Date.UTC(2026, 2, 8, 3, 30), "America/Denver")).toISOString()).toBe("2026-03-08T09:30:00.000Z");
  });

  it("reads Z as UTC and floating times in the default zone", () => {
    const { events } = parseIcs(
      cal("BEGIN:VEVENT", "UID:u", "DTSTART:20260616T160000Z", "END:VEVENT", "BEGIN:VEVENT", "UID:f", "DTSTART:20260616T090000", "END:VEVENT"),
      { defaultTimezone: "Europe/Berlin" },
    );
    expect(events[0]!.start!.iso).toBe("2026-06-16T16:00:00.000Z");
    expect(events[1]!.start!.iso).toBe("2026-06-16T07:00:00.000Z");
  });

  it("parses all-day dates and defaults their end to one day", () => {
    const { events } = parseIcs(cal("BEGIN:VEVENT", "UID:d", "DTSTART;VALUE=DATE:20260704", "END:VEVENT"));
    expect(events[0]!.start).toEqual({ iso: "2026-07-04T00:00:00.000Z", allDay: true });
    expect(events[0]!.end!.iso).toBe("2026-07-05T00:00:00.000Z");
    expect(toEvent(events[0]!)!.meta).toMatchObject({ allDay: true, durationMinutes: 1440 });
  });

  it("warns and falls back to UTC on an unknown TZID", () => {
    const { events, warnings } = parseIcs(cal("BEGIN:VEVENT", "UID:w", "DTSTART;TZID=Mountain Standard Time:20260615T100000", "END:VEVENT"));
    expect(events[0]!.start!.iso).toBe("2026-06-15T10:00:00.000Z");
    expect(warnings.some((w) => w.includes("Mountain Standard Time"))).toBe(true);
  });

  it("uses DURATION when DTEND is absent", () => {
    expect(parseDuration("PT1H30M")).toBe(90 * 60_000);
    expect(parseDuration("P1W")).toBe(7 * 86_400_000);
    const { events } = parseIcs(cal("BEGIN:VEVENT", "UID:d", "DTSTART:20260616T160000Z", "DURATION:PT45M", "END:VEVENT"));
    expect(events[0]!.end!.iso).toBe("2026-06-16T16:45:00.000Z");
  });
});

describe("parseIcs", () => {
  const folded = cal(
    "METHOD:REQUEST",
    "BEGIN:VEVENT",
    "UID:abc-123@example.test",
    "SEQUENCE:2",
    "DTSTART:20260616T160000Z",
    "DTEND:20260616T164500Z",
    "SUMMARY:Quarterly review\\, Acme",
    "DESCRIPTION:Agenda:\\n1. Pricing\\; terms\\n2. Securi",
    " ty review",
    "LOCATION:Room 4",
    "URL:https://meet.example/abc",
    "STATUS:CANCELLED",
    "ORGANIZER;CN=Jack Collins:MAILTO:Jack@Yagni.Example",
    "ATTENDEE;CN=Priya Raman;PARTSTAT=ACCEPTED:mailto:Priya.Raman@acme-robotic",
    " s.example",
    "ATTENDEE;CN=Marcus Bell;PARTSTAT=DECLINED:mailto:marcus.bell@acme-robotics.example",
    "BEGIN:VALARM",
    "TRIGGER:-PT15M",
    "DESCRIPTION:Reminder",
    "END:VALARM",
    "END:VEVENT",
  );

  it("parses a folded, escaped, cancelled VEVENT and ignores nested VALARM", () => {
    const { events, method } = parseIcs(folded);
    expect(method).toBe("REQUEST");
    expect(events).toHaveLength(1);
    const ev = events[0]!;
    expect(ev.summary).toBe("Quarterly review, Acme");
    expect(ev.description).toBe("Agenda:\n1. Pricing; terms\n2. Security review");
    expect(ev.status).toBe("CANCELLED");
    expect(ev.sequence).toBe(2);
    expect(ev.organizer).toEqual({ address: "jack@yagni.example", name: "Jack Collins" });
    expect(ev.attendees.map((a) => a.address)).toEqual(["priya.raman@acme-robotics.example", "marcus.bell@acme-robotics.example"]);
  });

  it("maps to a cancelled meeting event with lowercased participants", () => {
    const e = toEvent(parseIcs(folded).events[0]!)!;
    expect(e).toMatchObject({
      source: "calendar",
      kind: "meeting",
      externalId: "abc-123@example.test",
      occurredAt: "2026-06-16T16:00:00.000Z",
      threadKey: "abc-123@example.test",
      content: { title: "Quarterly review, Acme", text: "Agenda:\n1. Pricing; terms\n2. Security review" },
    });
    expect(e.participants).toEqual([
      { role: "organizer", address: "jack@yagni.example", name: "Jack Collins" },
      { role: "attendee", address: "priya.raman@acme-robotics.example", name: "Priya Raman" },
      { role: "attendee", address: "marcus.bell@acme-robotics.example", name: "Marcus Bell" },
    ]);
    expect(e.meta).toEqual({
      status: "CANCELLED",
      start: "2026-06-16T16:00:00.000Z",
      end: "2026-06-16T16:45:00.000Z",
      durationMinutes: 45,
      allDay: false,
      location: "Room 4",
      url: "https://meet.example/abc",
      sequence: 2,
      cancelled: true,
      partstat: { "priya.raman@acme-robotics.example": "ACCEPTED", "marcus.bell@acme-robotics.example": "DECLINED" },
    });
  });

  it("falls back to SUMMARY for text, suffixes RECURRENCE-ID and keeps RRULE on the master", () => {
    const { events, warnings } = parseIcs(
      cal(
        "BEGIN:VEVENT",
        "UID:series",
        "DTSTART:20260601T150000Z",
        "RRULE:FREQ=WEEKLY;BYDAY=MO",
        "SUMMARY:Weekly sync",
        "END:VEVENT",
        "BEGIN:VEVENT",
        "UID:series",
        "RECURRENCE-ID:20260608T150000Z",
        "DTSTART:20260608T170000Z",
        "SUMMARY:Weekly sync (moved)",
        "END:VEVENT",
      ),
    );
    const [master, moved] = events.map((e) => toEvent(e)!);
    expect(master!.content.text).toBe("Weekly sync");
    expect(master!.meta["rrule"]).toBe("FREQ=WEEKLY;BYDAY=MO");
    expect(master!.meta["cancelled"]).toBe(false);
    expect(warnings.some((w) => w.includes("RRULE"))).toBe(true);
    expect(moved!.externalId).toBe("series_2026-06-08T15:00:00.000Z");
    expect(moved!.threadKey).toBe("series");
    expect(moved!.meta["recurrenceId"]).toBe("2026-06-08T15:00:00.000Z");
  });

  it("skips events without a UID and reports it", () => {
    const { events, warnings } = parseIcs(cal("BEGIN:VEVENT", "SUMMARY:Orphan", "DTSTART:20260601T150000Z", "END:VEVENT"));
    expect(events).toHaveLength(0);
    expect(warnings[0]).toContain("Orphan");
  });

  it("marks every event cancelled in a METHOD:CANCEL calendar", () => {
    const { events, method } = parseIcs(cal("METHOD:CANCEL", "BEGIN:VEVENT", "UID:c", "DTSTART:20260601T150000Z", "END:VEVENT"));
    expect(toEvent(events[0]!, { method: method! })!.meta["cancelled"]).toBe(true);
  });
});
