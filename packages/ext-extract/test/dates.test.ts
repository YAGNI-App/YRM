import { describe, expect, it } from "bun:test";
import { findDue, resolveDue } from "../src/dates.ts";

// 2026-06-02 is a Tuesday.
const TUE = "2026-06-02T14:02:10.000Z";
// 2026-08-27 is a Thursday.
const THU = "2026-08-27T14:15:00.000Z";
// 2026-06-06 is a Saturday.
const SAT = "2026-06-06T10:00:00.000Z";
// 2026-12-15 is a Tuesday.
const DEC = "2026-12-15T10:00:00.000Z";

const CASES: Array<[string, string, string | undefined]> = [
  ["I'll send it by Friday", TUE, "2026-06-05"],
  ["I'll send it by Friday, June 5", TUE, "2026-06-05"],
  ["We will have it by Tuesday", TUE, "2026-06-09"],
  ["I'll get you numbers by next Friday", TUE, "2026-06-12"],
  ["I can do it tomorrow", TUE, "2026-06-03"],
  ["I'll have it to you by EOD", TUE, "2026-06-02"],
  ["by end of day", TUE, "2026-06-02"],
  ["by end of week", TUE, "2026-06-05"],
  ["by the end of this week", SAT, "2026-06-12"],
  ["I'll send it next week", TUE, "2026-06-12"],
  ["I will send you our SOC 2 Type II report by September 30.", THU, "2026-09-30"],
  ["Dana will send the list by 4 September", THU, "2026-09-04"],
  ["Due 9/4", THU, "2026-09-04"],
  ["Due 09/04/2027", THU, "2027-09-04"],
  ["I'll have it by 2026-10-16", THU, "2026-10-16"],
  ["We'll talk on Thursday the 17th", "2026-09-11T14:02:51.000Z", "2026-09-17"],
  ["I'll send the plan by January 5", DEC, "2027-01-05"],
  ["by end of month", THU, "2026-08-31"],
  ["Monday works", THU, "2026-08-31"],
  ["Our number is 24/7 support", THU, undefined],
  ["No date in here at all", THU, undefined],
  ["Fulcrum 11.2 runs at 50 requests/second", THU, undefined],
  ["by February 30", THU, undefined],
];

describe("resolveDue", () => {
  for (const [text, at, expected] of CASES) {
    it(`${JSON.stringify(text)} @ ${at.slice(0, 10)} -> ${expected ?? "none"}`, () => {
      expect(resolveDue(text, at)).toBe(expected);
    });
  }

  it("prefers a date introduced by a deadline cue over an incidental one", () => {
    const m = findDue("After the June 16 call, I'll send a proposal by June 26.", TUE);
    expect(m?.dueAt).toBe("2026-06-26");
    expect(m?.phrase).toBe("June 26");
  });

  it("uses the calendar date written in occurredAt when it carries an offset", () => {
    expect(resolveDue("tomorrow", "2026-09-02T17:48:09-07:00")).toBe("2026-09-03");
    expect(resolveDue("tomorrow", "2026-09-03T00:48:09.000Z")).toBe("2026-09-04");
  });
});
