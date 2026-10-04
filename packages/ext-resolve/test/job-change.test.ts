import { describe, expect, it } from "bun:test";
import { JOB_CHANGE_TRIGGER, parseJobChange } from "../src/index.ts";

describe("parseJobChange", () => {
  it("reads leaving and joining across adjacent sentences", () => {
    const text =
      "Jack,\n\nI wanted you to hear this from me. Today is my last day at Acme. I've accepted a role at Northwind Automation and start there on Monday the 17th.\n\nPriya";
    const parsed = parseJobChange(text);
    expect(parsed?.value).toEqual({ leaving: "Acme", joining: "Northwind Automation" });
    expect(parsed?.quote.text).toBe(
      "Today is my last day at Acme. I've accepted a role at Northwind Automation and start there on Monday the 17th.",
    );
    expect(text.slice(parsed!.quote.start, parsed!.quote.end)).toBe(parsed!.quote.text);
  });

  it("handles other phrasings", () => {
    expect(parseJobChange("Quick note: I'm leaving Initech next month.")?.value).toEqual({ leaving: "Initech" });
    expect(parseJobChange("I am starting at Globex Corp on Monday.")?.value).toEqual({ joining: "Globex Corp" });
    expect(parseJobChange("I'm no longer with Hooli.")?.value).toEqual({ leaving: "Hooli" });
    expect(parseJobChange("My last day is Friday.")?.value).toEqual({});
  });

  it("ignores meeting talk", () => {
    expect(JOB_CHANGE_TRIGGER.test("Bob, are you joining?")).toBe(true);
    expect(parseJobChange("Bob, are you joining?")).toBeNull();
    expect(parseJobChange("Thanks for joining the call.")).toBeNull();
    expect(parseJobChange("Nothing to see here.")).toBeNull();
  });
});
