import { describe, expect, it } from "bun:test";
import { splitSentences } from "../src/sentences.ts";

const texts = (s: string) => splitSentences(s).map((x) => x.text);

describe("splitSentences", () => {
  it("splits on terminal punctuation and keeps spans into the original", () => {
    const text = "Thanks for the time. Can you send the deck? Great!";
    const out = splitSentences(text);
    expect(out.map((s) => s.text)).toEqual(["Thanks for the time.", "Can you send the deck?", "Great!"]);
    for (const s of out) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it("does not split after abbreviations", () => {
    expect(texts("We met Dr. Okafor at 9 a.m. Monday. Then e.g. lunch.")).toEqual([
      "We met Dr. Okafor at 9 a.m. Monday.",
      "Then e.g. lunch.",
    ]);
  });

  it("does not split inside quoted text", () => {
    expect(texts('We have been burned by "integrations. They were CSV exports." Not again.')).toEqual([
      'We have been burned by "integrations. They were CSV exports."',
      "Not again.",
    ]);
  });

  it("keeps decimals and versions intact", () => {
    expect(texts("They run Fulcrum 11.2 today. Load is 4.5 rps.")).toEqual(["They run Fulcrum 11.2 today.", "Load is 4.5 rps."]);
  });

  it("treats list items and paragraphs as boundaries and strips markers", () => {
    const text = "Next steps:\n- Priya will share data by June 23\n- I'll send a proposal by June 26.\n\n1. Does it need internet?";
    const out = splitSentences(text);
    expect(out.map((s) => s.text)).toEqual([
      "Next steps:",
      "Priya will share data by June 23",
      "I'll send a proposal by June 26.",
      "Does it need internet?",
    ]);
    for (const s of out) expect(text.slice(s.start, s.end)).toBe(s.text);
  });

  it("joins hard-wrapped lines but keeps the span on the original text", () => {
    const text = "I will send you the report\nby September 30. Thanks.";
    const [first] = splitSentences(text);
    expect(first!.text).toBe("I will send you the report by September 30.");
    expect(text.slice(first!.start, first!.end)).toBe("I will send you the report\nby September 30.");
  });

  it("ends a sentence at a single capital letter", () => {
    expect(texts("We're going with Option A. Reno only.")).toEqual(["We're going with Option A.", "Reno only."]);
  });

  it("returns nothing for blank text", () => {
    expect(splitSentences(" \n\n ")).toEqual([]);
  });
});
