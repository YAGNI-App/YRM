import { describe, expect, test } from "bun:test";
import {
  decodeEncodedWords,
  htmlToText,
  parseAddressList,
  parseEml,
  parseMbox,
  parseRfc2822Date,
} from "../src/parse.ts";

const crlf = (s: string): string => s.replace(/\n/g, "\r\n");

describe("headers", () => {
  test("unfolds folded headers and reads threading fields", () => {
    const msg = parseEml(
      crlf(`Message-ID: <a1@example.test>
In-Reply-To: <r2@example.test>
References: <r1@example.test>
\t<r2@example.test>
Subject: A subject that
 was folded
From: Alice <alice@example.test>
Date: Tue, 02 Jun 2026 09:14:22 -0700

Body
`),
    );
    expect(msg.messageId).toBe("<a1@example.test>");
    expect(msg.inReplyTo).toBe("<r2@example.test>");
    expect(msg.references).toEqual(["<r1@example.test>", "<r2@example.test>"]);
    expect(msg.subject).toBe("A subject that was folded");
    expect(msg.date).toBe("2026-06-02T16:14:22.000Z");
    expect(msg.text).toBe("Body\n");
  });

  test("decodes RFC 2047 encoded words, joining adjacent ones", () => {
    expect(decodeEncodedWords("=?UTF-8?B?Q2Fmw6k=?= menu")).toBe("Café menu");
    expect(decodeEncodedWords("=?iso-8859-1?Q?R=E9sum=E9_attached?=")).toBe("Résumé attached");
    expect(decodeEncodedWords("=?utf-8?Q?Hello?= =?utf-8?Q?_world?=")).toBe("Hello world");
    const msg = parseEml("Subject: =?utf-8?Q?Gr=C3=BC=C3=9Fe?=\n =?utf-8?B?IGF1cyBCZXJsaW4=?=\n\nx");
    expect(msg.subject).toBe("Grüße aus Berlin");
  });

  test("parses address lists with display names, quotes, groups and comments", () => {
    expect(parseAddressList('"Bell, Marcus" <Marcus.Bell@Acme.example>, priya@acme.example')).toEqual([
      { address: "marcus.bell@acme.example", name: "Bell, Marcus" },
      { address: "priya@acme.example" },
    ]);
    expect(parseAddressList("team: a@x.example, B <b@x.example>;, c@x.example (Cee)")).toEqual([
      { address: "a@x.example" },
      { address: "b@x.example", name: "B" },
      { address: "c@x.example", name: "Cee" },
    ]);
    expect(parseAddressList("=?utf-8?Q?Ren=C3=A9e?= <renee@x.example>")).toEqual([{ address: "renee@x.example", name: "Renée" }]);
    expect(parseAddressList("undisclosed-recipients:;")).toEqual([]);
  });

  test("reads To, Cc and Bcc with multiple addresses and bulk headers", () => {
    const msg = parseEml(`From: A <a@x.example>
To: B <b@x.example>, C <c@x.example>
Cc: D <d@x.example>
Bcc: e@x.example
List-Unsubscribe: <mailto:u@x.example>
List-Id: News <news.x.example>
Precedence: Bulk
Auto-Submitted: auto-generated
X-Auto-Response-Suppress: All

hi`);
    expect(msg.to.map((a) => a.address)).toEqual(["b@x.example", "c@x.example"]);
    expect(msg.cc).toEqual([{ address: "d@x.example", name: "D" }]);
    expect(msg.bcc).toEqual([{ address: "e@x.example" }]);
    expect(msg.listUnsubscribe).toBe("<mailto:u@x.example>");
    expect(msg.listId).toBe("News <news.x.example>");
    expect(msg.precedence).toBe("bulk");
    expect(msg.autoSubmitted).toBe("auto-generated");
    expect(msg.autoResponseSuppress).toBe("All");
  });

  test("parses RFC 2822 dates with offsets, obsolete zones and comments", () => {
    expect(parseRfc2822Date("Fri, 05 Jun 2026 15:30:04 -0400")).toBe("2026-06-05T19:30:04.000Z");
    expect(parseRfc2822Date("5 Jun 2026 12:30 PDT")).toBe("2026-06-05T19:30:00.000Z");
    expect(parseRfc2822Date("Fri, 5 Jun 26 19:30:04 +0000 (UTC)")).toBe("2026-06-05T19:30:04.000Z");
    expect(parseRfc2822Date("not a date")).toBeUndefined();
  });

  test("takes the latest Received timestamp", () => {
    const msg = parseEml(`Received: from a by b; Thu, 03 Sep 2026 09:05:12 -0400
Received: from c by a; Thu, 03 Sep 2026 13:05:09 +0000
Date: Fri, 14 Aug 2026 17:02:45 -0700

x`);
    expect(msg.receivedAt).toBe("2026-09-03T13:05:12.000Z");
    expect(msg.date).toBe("2026-08-15T00:02:45.000Z");
  });
});

describe("bodies", () => {
  test("decodes quoted-printable with soft breaks and charset", () => {
    const msg = parseEml(`Content-Type: text/plain; charset="utf-8"
Content-Transfer-Encoding: quoted-printable

Caf=C3=A9 on the 5th, a long line that wraps=
 here. 2+2=3D4`);
    expect(msg.text).toBe("Café on the 5th, a long line that wraps here. 2+2=4");
  });

  test("decodes base64 with a declared charset", () => {
    const body = Buffer.from("Prix: 12 €", "utf-8").toString("base64");
    const msg = parseEml(`Content-Type: text/plain; charset=utf-8\nContent-Transfer-Encoding: base64\n\n${body}\n`);
    expect(msg.text).toBe("Prix: 12 €");
    const latin = parseEml(`Content-Type: text/plain; charset=iso-8859-1\nContent-Transfer-Encoding: base64\n\n${Buffer.from([0x52, 0xe9, 0x73]).toString("base64")}`);
    expect(latin.text).toBe("Rés");
  });

  test("prefers text/plain in multipart/alternative and lists attachments", () => {
    const msg = parseEml(`Content-Type: multipart/mixed; boundary="outer"

preamble
--outer
Content-Type: multipart/alternative; boundary=inner

--inner
Content-Type: text/plain; charset=utf-8
Content-Transfer-Encoding: quoted-printable

Plain version=21
--inner
Content-Type: text/html; charset=utf-8

<p>HTML version!</p>
--inner--
--outer
Content-Type: application/pdf; name="deck.pdf"
Content-Disposition: attachment; filename="deck.pdf"
Content-Transfer-Encoding: base64

JVBERi0xLjQK
--outer--
epilogue`);
    expect(msg.bodyType).toBe("text/plain");
    expect(msg.text.trim()).toBe("Plain version!");
    expect(msg.attachments).toEqual([{ contentType: "application/pdf", filename: "deck.pdf", size: 12 }]);
  });

  test("falls back to stripped html, turning blockquotes into > lines", () => {
    const msg = parseEml(`Content-Type: multipart/alternative; boundary=b

--b
Content-Type: text/html; charset=utf-8
Content-Transfer-Encoding: base64

${Buffer.from("<html><head><style>p{}</style></head><body><p>Sounds good &amp; thanks.</p><div>On Mon, A wrote:</div><blockquote><p>Can you send it?</p></blockquote></body></html>").toString("base64")}
--b--`);
    expect(msg.bodyType).toBe("text/html");
    expect(msg.text).toBe("Sounds good & thanks.\n\nOn Mon, A wrote:\n\n> Can you send it?");
  });

  test("htmlToText handles breaks, lists and entities", () => {
    expect(htmlToText("a<br>b<ul><li>one</li><li>two</li></ul>&lt;x&gt;&#39;&#x41;")).toBe("a\nb\n\n- one\n- two\n<x>'A");
  });
});

describe("mbox", () => {
  test("splits on From_ lines and unescapes >From", () => {
    const msgs = parseMbox(`From alice@x.example Mon Jun  1 10:00:00 2026
Message-ID: <1@x.example>
Subject: one

Hello
>From the start.

From bob@x.example Mon Jun  1 11:00:00 2026
Message-ID: <2@x.example>
Subject: two

Second
`);
    expect(msgs.map((m) => m.messageId)).toEqual(["<1@x.example>", "<2@x.example>"]);
    expect(msgs[0]!.text).toBe("Hello\nFrom the start.\n");
  });
});
