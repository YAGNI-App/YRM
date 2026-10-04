import { describe, expect, test } from "bun:test";
import { stripQuotes } from "../src/strip.ts";

describe("stripQuotes", () => {
  test("removes > lines but keeps interleaved replies", () => {
    const r = stripQuotes("> Can you do Friday?\nYes, Friday works.\n> And the deck?\nSending tonight.");
    expect(r.text).toBe("Yes, Friday works.\nSending tonight.");
    expect(r.stripped).toBe("> Can you do Friday?\n> And the deck?");
  });

  test("cuts at an English attribution, including one wrapped over lines", () => {
    expect(stripQuotes("Sounds good.\n\nOn Tue, 02 Jun 2026 at 14:02, Jack Collins <jack@yagni.example> wrote:\n> hi").text).toBe("Sounds good.");
    const wrapped = stripQuotes("Sounds good.\n\nOn Tue, 02 Jun 2026 at 14:02, Jack Collins\n<jack@yagni.example> wrote:\n\n> hi");
    expect(wrapped.text).toBe("Sounds good.");
    expect(wrapped.stripped).toContain("wrote:");
  });

  test("cuts at French and German attributions", () => {
    expect(stripQuotes("Merci.\n\nLe mar. 2 juin 2026 à 14:02, Jack <j@x.example> a écrit :\n> salut").text).toBe("Merci.");
    expect(stripQuotes("Danke.\n\nAm Di., 2. Juni 2026 um 14:02 Uhr schrieb Jack <j@x.example>:\n> hallo").text).toBe("Danke.");
  });

  test("cuts at Outlook header blocks", () => {
    const r = stripQuotes("Approved.\n\nFrom: Rachel Kim <rachel@acme.example>\nSent: Friday, July 17, 2026 3:48 PM\nTo: Jack Collins\nSubject: Order form\n\nHi Jack,");
    expect(r.text).toBe("Approved.");
    expect(r.stripped.startsWith("From: Rachel Kim")).toBe(true);
  });

  test("cuts at -----Original Message-----", () => {
    expect(stripQuotes("See below.\n\n-----Original Message-----\nFrom: x\nquoted").text).toBe("See below.");
  });

  test("cuts at an underscore rule followed by headers", () => {
    const r = stripQuotes("Works for me.\n\n________________________________\nFrom: Elena <e@acme.example>\nSent: Tuesday\nTo: Jack\nSubject: Review");
    expect(r.text).toBe("Works for me.");
    expect(r.stripped.startsWith("____")).toBe(true);
    // A rule that is not followed by headers stays.
    expect(stripQuotes("Notes\n\n__________\nmore notes").text).toBe("Notes\n\n__________\nmore notes");
  });

  test("removes the signature from the -- delimiter to the end", () => {
    const r = stripQuotes("Thanks,\nTom\n\n-- \nTom Fischer\nSenior Operations Engineer\n+1 775 555 0133");
    expect(r.text).toBe("Thanks,\nTom");
    expect(r.stripped).toBe("--\nTom Fischer\nSenior Operations Engineer\n+1 775 555 0133");
  });

  test("removes a contact block after a sign-off and name heuristically", () => {
    const r = stripQuotes("Let's talk Thursday.\n\nBest,\nSam\nSam Lindqvist | Partner Lead\nNorthwind Automation\n+1 503 555 0199\nnorthwind.example");
    expect(r.text).toBe("Let's talk Thursday.\n\nBest,\nSam");
    expect(r.stripped).toContain("+1 503 555 0199");
  });

  test("keeps trailing lines after a sign-off when they look like prose", () => {
    const body = "Let's talk Thursday.\n\nThanks,\nSam\n\nP.S. the agenda is attached and I added two items.";
    expect(stripQuotes(body).text).toBe(body);
  });

  test("removes mobile sign-offs", () => {
    expect(stripQuotes("On my way.\n\nSent from my iPhone").text).toBe("On my way.");
    expect(stripQuotes("Yes.\n\nGet Outlook for iOS").text).toBe("Yes.");
  });

  test("never returns empty text for a non-empty body: keeps the first paragraph", () => {
    const r = stripQuotes("> only a quote\n> nothing new\n\n> more");
    expect(r.text).toBe("> only a quote\n> nothing new");
    expect(r.stripped).toBe("> more");
    // The whole first paragraph comes back, quote line included: better noisy than empty.
    expect(stripQuotes("On Mon, A <a@x.example> wrote:\n> hi").text).toBe("On Mon, A <a@x.example> wrote:\n> hi");
    expect(stripQuotes("")).toEqual({ text: "", stripped: "" });
  });

  test("collapses runs of blank lines", () => {
    expect(stripQuotes("a\n\n\n\nb\n   \n\n\nc").text).toBe("a\n\nb\n\nc");
  });
});
