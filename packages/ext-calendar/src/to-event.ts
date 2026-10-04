import type { NewSourceEvent, Participant } from "@yrm/core";
import type { CalAddress, VEvent } from "./ics.ts";

export const SOURCE_NAME = "calendar";
export const MEETING_KIND = "meeting";

/**
 * What downstream extensions may rely on in a meeting event's `meta`. Times
 * are ISO 8601 UTC instants; all-day meetings start at midnight UTC.
 */
export interface MeetingMeta {
  status?: string;
  start: string;
  end: string;
  durationMinutes: number;
  allDay: boolean;
  location?: string;
  url?: string;
  sequence: number;
  /** STATUS:CANCELLED, or a METHOD:CANCEL calendar. A cancelled meeting is still an event. */
  cancelled: boolean;
  /** PARTSTAT per lower-cased attendee address. */
  partstat: Record<string, string>;
  /** Present on recurring masters; occurrences are not expanded in 0.1. */
  rrule?: string;
  /** ISO instant of the occurrence this event overrides, for RECURRENCE-ID exceptions. */
  recurrenceId?: string;
  timezone?: string;
}

export interface ToEventOptions {
  /** Calendar-level METHOD; CANCEL marks every event cancelled. */
  method?: string;
  /** Pointer to the source file, stored as `rawRef`. */
  rawRef?: string;
}

function participant(role: string, a: CalAddress): Participant {
  const p: Participant = { role };
  if (a.address !== undefined) p.address = a.address;
  if (a.name !== undefined) p.name = a.name;
  return p;
}

/** Stable per-instance id: the UID, plus the recurrence instant for overridden occurrences. */
export function externalIdOf(ev: VEvent): string {
  return ev.recurrenceId ? `${ev.uid}_${ev.recurrenceId.iso}` : ev.uid;
}

/** Map a parsed VEVENT to a meeting event. Returns null when it has no DTSTART. */
export function toEvent(ev: VEvent, opts: ToEventOptions = {}): NewSourceEvent | null {
  if (!ev.start) return null;
  const start = ev.start.iso;
  const end = ev.end?.iso ?? start;

  const participants: Participant[] = [];
  if (ev.organizer) participants.push(participant("organizer", ev.organizer));
  const partstat: Record<string, string> = {};
  for (const a of ev.attendees) {
    participants.push(participant("attendee", a));
    if (a.address && a.partstat) partstat[a.address] = a.partstat;
  }

  const meta: MeetingMeta = {
    start,
    end,
    durationMinutes: Math.round((Date.parse(end) - Date.parse(start)) / 60_000),
    allDay: ev.start.allDay,
    sequence: ev.sequence,
    cancelled: ev.status === "CANCELLED" || opts.method === "CANCEL",
    partstat,
  };
  if (ev.status !== undefined) meta.status = ev.status;
  if (ev.location) meta.location = ev.location;
  if (ev.url) meta.url = ev.url;
  if (ev.rrule) meta.rrule = ev.rrule;
  if (ev.recurrenceId) meta.recurrenceId = ev.recurrenceId.iso;
  if (ev.start.tzid) meta.timezone = ev.start.tzid;

  const description = ev.description?.trim() ?? "";
  const out: NewSourceEvent = {
    source: SOURCE_NAME,
    kind: MEETING_KIND,
    externalId: externalIdOf(ev),
    occurredAt: start,
    participants,
    content: { text: description || ev.summary?.trim() || "" },
    // Every instance of a series shares the UID, so they thread together.
    threadKey: ev.uid,
    meta: { ...meta },
  };
  if (ev.summary) out.content.title = ev.summary.trim();
  if (opts.rawRef !== undefined) out.rawRef = opts.rawRef;
  return out;
}

/**
 * Collapse re-deliveries of the same instance within one import to the highest
 * SEQUENCE, so a file holding both the original and the update yields the update.
 */
export function latestRevisions(events: VEvent[]): VEvent[] {
  const byId = new Map<string, VEvent>();
  for (const ev of events) {
    const key = externalIdOf(ev);
    const prev = byId.get(key);
    if (!prev || ev.sequence >= prev.sequence) byId.set(key, ev);
  }
  return [...byId.values()];
}
