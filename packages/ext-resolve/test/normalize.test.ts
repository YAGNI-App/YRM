import { describe, expect, it } from "bun:test";
import {
  baseAddress,
  displayNameFromHeader,
  domainOf,
  isFreemail,
  isFullName,
  nameFromLocalPart,
  normalizeAddress,
  normalizeName,
  orgNameFromDomain,
} from "../src/index.ts";
import { isAutomatedAddress } from "../src/normalize.ts";

describe("normalizeAddress", () => {
  it("lowercases, trims and strips mailto and brackets", () => {
    expect(normalizeAddress("  Priya.Raman@Acme-Robotics.Example ")).toBe("priya.raman@acme-robotics.example");
    expect(normalizeAddress("mailto:Jack@YAGNI.example")).toBe("jack@yagni.example");
    expect(normalizeAddress("MAILTO:jack@yagni.example?subject=hi")).toBe("jack@yagni.example");
    expect(normalizeAddress("<tom@acme.example>")).toBe("tom@acme.example");
  });

  it("keeps plus tags; baseAddress removes them", () => {
    expect(normalizeAddress("a+News@x.com")).toBe("a+news@x.com");
    expect(baseAddress("a+news@x.com")).toBe("a@x.com");
    expect(baseAddress("a@x.com")).toBe("a@x.com");
    expect(baseAddress("+only@x.com")).toBe("+only@x.com");
  });
});

describe("domainOf", () => {
  it("returns the bare domain", () => {
    expect(domainOf("priya@northwind.example")).toBe("northwind.example");
    expect(domainOf("Northwind.Example")).toBe("northwind.example");
  });

  it("strips common mail subdomains only", () => {
    expect(domainOf("a@mail.acme.example")).toBe("acme.example");
    expect(domainOf("a@smtp.acme.example")).toBe("acme.example");
    expect(domainOf("a@labs.acme.example")).toBe("labs.acme.example");
    expect(domainOf("a@mail.example")).toBe("mail.example");
  });

  it("rejects things without a domain", () => {
    expect(domainOf("not-an-address")).toBeUndefined();
    expect(domainOf("a@localhost")).toBeUndefined();
  });
});

describe("isFreemail", () => {
  it("knows the defaults and accepts extras", () => {
    expect(isFreemail("gmail.com")).toBe(true);
    expect(isFreemail("proton.me")).toBe(true);
    expect(isFreemail("acme-robotics.example")).toBe(false);
    expect(isFreemail("mailhub.example")).toBe(false);
    expect(isFreemail("mailhub.example", ["mailhub.example"])).toBe(true);
  });

  it("treats subdomains of a freemail provider as freemail", () => {
    expect(isFreemail("calendar.mailhub.example", ["mailhub.example"])).toBe(true);
    expect(isFreemail("notgmail.com")).toBe(false);
  });
});

describe("orgNameFromDomain", () => {
  it("strips the TLD and title-cases", () => {
    expect(orgNameFromDomain("acme-robotics.example")).toBe("Acme Robotics");
    expect(orgNameFromDomain("northwind.example")).toBe("Northwind");
    expect(orgNameFromDomain("acme.co.uk")).toBe("Acme");
    expect(orgNameFromDomain("big_co.com")).toBe("Big Co");
  });
});

describe("displayNameFromHeader", () => {
  it("cleans quotes", () => {
    expect(displayNameFromHeader('"Priya Raman"')).toBe("Priya Raman");
    expect(displayNameFromHeader("'\"Tom Fischer\"'")).toBe("Tom Fischer");
  });

  it("turns Last, First into First Last", () => {
    expect(displayNameFromHeader('"Bell, Marcus"')).toBe("Marcus Bell");
  });

  it("title-cases all caps, keeping hyphens and apostrophes", () => {
    expect(displayNameFromHeader("ELENA VASQUEZ")).toBe("Elena Vasquez");
    expect(displayNameFromHeader("SEAN O'BRIEN-SMITH")).toBe("Sean O'Brien-Smith");
    expect(displayNameFromHeader("Dana McKay")).toBe("Dana McKay");
  });

  it("drops a trailing comment", () => {
    expect(displayNameFromHeader("Rachel Kim (Acme)")).toBe("Rachel Kim");
  });

  it("falls back to the local part", () => {
    expect(displayNameFromHeader(undefined, "priya.raman@acme-robotics.example")).toBe("Priya Raman");
    expect(displayNameFromHeader("", "tfischer@mailhub.example")).toBe("Tfischer");
    expect(displayNameFromHeader("jack@yagni.example", "jack@yagni.example")).toBe("Jack");
    expect(displayNameFromHeader(undefined, "sam+deals@northwind.example")).toBe("Sam");
    expect(nameFromLocalPart("first_last-2@x.com")).toBe("First Last");
  });
});

describe("normalizeName", () => {
  it("ignores case, diacritics and punctuation", () => {
    expect(normalizeName("José  Núñez-García")).toBe("jose nunez garcia");
    expect(normalizeName("PRIYA RAMAN")).toBe(normalizeName("Priya Raman"));
    expect(normalizeName("O'Brien, Sean")).toBe("o brien sean");
  });

  it("isFullName needs two tokens", () => {
    expect(isFullName(normalizeName("Priya Raman"))).toBe(true);
    expect(isFullName(normalizeName("Tfischer"))).toBe(false);
  });
});

describe("isAutomatedAddress", () => {
  it("spots system senders", () => {
    expect(isAutomatedAddress("noreply@trackly.example")).toBe(true);
    expect(isAutomatedAddress("no-reply+x@a.com")).toBe(true);
    expect(isAutomatedAddress("newsletter@opsweekly.example")).toBe(true);
    expect(isAutomatedAddress("priya@northwind.example")).toBe(false);
  });
});
