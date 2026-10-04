import { describe, expect, test } from "bun:test";
import { classifyNoise } from "../src/noise.ts";
import { parseEml } from "../src/parse.ts";

const mail = (headers: string, from = "Alice <alice@acme.example>"): ReturnType<typeof parseEml> =>
  parseEml(`From: ${from}\nTo: jack@yagni.example\nSubject: hi\n${headers}\n\nBody`);

describe("classifyNoise", () => {
  test("person-to-person mail is not noise", () => {
    expect(classifyNoise(mail(""))).toEqual({ noise: false });
  });

  test("List-Unsubscribe", () => {
    expect(classifyNoise(mail("List-Unsubscribe: <https://x.example/u>"))).toEqual({ noise: true, reason: "list-unsubscribe" });
  });

  test("Precedence bulk, list and junk; other values are not noise", () => {
    for (const p of ["bulk", "List", "junk"]) {
      expect(classifyNoise(mail(`Precedence: ${p}`))).toEqual({ noise: true, reason: `precedence:${p.toLowerCase()}` });
    }
    expect(classifyNoise(mail("Precedence: first-class")).noise).toBe(false);
  });

  test("Auto-Submitted other than no", () => {
    expect(classifyNoise(mail("Auto-Submitted: auto-replied"))).toEqual({ noise: true, reason: "auto-submitted:auto-replied" });
    expect(classifyNoise(mail("Auto-Submitted: no")).noise).toBe(false);
  });

  test("X-Auto-Response-Suppress alone is not noise (Outlook sets it on ordinary mail)", () => {
    expect(classifyNoise(mail("X-Auto-Response-Suppress: OOF")).noise).toBe(false);
  });

  test("sender local parts, including sub-addressing", () => {
    for (const local of ["noreply", "no-reply", "donotreply", "notifications", "mailer-daemon", "postmaster", "bounce", "alerts", "newsletter", "news", "marketing", "digest", "notification"]) {
      expect(classifyNoise(mail("", `X <${local}@saas.example>`))).toEqual({ noise: true, reason: `sender:${local}` });
    }
    expect(classifyNoise(mail("", "Billing <alerts+billing@saas.example>")).reason).toBe("sender:alerts");
    expect(classifyNoise(mail("", "Newsy <newsroom@saas.example>")).noise).toBe(false);
  });

  test("configurable local parts replace the defaults, domains match subdomains", () => {
    expect(classifyNoise(mail("", "<alerts@saas.example>"), { localParts: ["robot"] }).noise).toBe(false);
    expect(classifyNoise(mail("", "<robot@saas.example>"), { localParts: ["robot"] }).reason).toBe("sender:robot");
    expect(classifyNoise(mail("", "<bob@mail.vendor.example>"), { domains: ["vendor.example"] })).toEqual({
      noise: true,
      reason: "domain:vendor.example",
    });
    expect(classifyNoise(mail("", "<bob@notvendor.example>"), { domains: ["vendor.example"] }).noise).toBe(false);
  });

  test("a 'via' display name is not noise by itself", () => {
    expect(classifyNoise(mail("", '"Priya Raman (via Docs)" <comments@docs.example>')).noise).toBe(false);
    expect(classifyNoise(mail("", "Marcus Bell via Calendly <marcus@acme.example>")).noise).toBe(false);
  });
});
