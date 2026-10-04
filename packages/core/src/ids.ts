import { monotonicFactory } from "ulid";

// Monotonic so ids minted within the same millisecond still sort in creation
// order; the event log relies on id order for resumable reads.
const ulid = monotonicFactory();

/** A new ULID. */
export function newId(): string {
  return ulid();
}

/** The current time as an ISO 8601 UTC string. */
export function nowIso(): string {
  return new Date().toISOString();
}
