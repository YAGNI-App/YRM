import { describe, expect, test } from "bun:test";
import {
  appManifestYaml,
  backoffDelay,
  channelSelected,
  compareTs,
  dmsEnabled,
  normalizeMarkup,
  parseCursor,
  resolveSettings,
  SCOPES,
  toSlackEvent,
  toUserMap,
  tsToIso,
  type ChannelInfo,
  type MapContext,
} from "../src/index.ts";

const users = toUserMap([
  { id: "U1", name: "maria", real_name: "Maria Lopez", profile: { email: "Maria@Acme.example", title: "VP Ops" } },
  { id: "U2", name: "tom", real_name: "Tom Fischer" },
  { id: "B1", name: "bot", is_bot: true },
]);
const lookup = {
  user: (id: string) => users[id]?.realName,
  channel: (id: string) => (id === "C9" ? "general" : undefined),
};

describe("markup normalization", () => {
  const cases: Array<[string, string, string[]]> = [
    ["hi <@U1>", "hi @Maria Lopez", ["U1"]],
    ["hi <@U1|maria>", "hi @Maria Lopez", ["U1"]],
    ["hi <@U7|someone>", "hi @someone", ["U7"]],
    ["hi <@U7>", "hi @U7", ["U7"]],
    ["see <#C123|sales>", "see #sales", []],
    ["see <#C9>", "see #general", []],
    ["see <#C8>", "see #C8", []],
    ["<http://x.example|label>", "label (http://x.example)", []],
    ["<https://x.example/a?b=1&amp;c=2>", "https://x.example/a?b=1&c=2", []],
    ["<https://x.example|https://x.example>", "https://x.example", []],
    ["<mailto:a@b.example|a@b.example>", "a@b.example", []],
    ["<mailto:a@b.example|write us>", "write us (a@b.example)", []],
    ["<!here> and <!channel> and <!everyone>", "@here and @channel and @everyone", []],
    ["<!subteam^S1|@sales-team> ping", "@sales-team ping", []],
    ["<!date^1392734382^{date}|Feb 18th>", "Feb 18th", []],
    ["a &amp; b &lt;c&gt;", "a & b <c>", []],
    ["literal &lt;@U1&gt;", "literal <@U1>", []],
    ["<@U1> and <@U2> and <@U1> again", "@Maria Lopez and @Tom Fischer and @Maria Lopez again", ["U1", "U2"]],
  ];
  for (const [input, text, mentions] of cases) {
    test(JSON.stringify(input), () => {
      expect(normalizeMarkup(input, lookup)).toEqual({ text, mentions });
    });
  }
});

describe("event mapping", () => {
  const map: MapContext = { users, channelNames: new Map([["C9", "general"]]), includeBots: false, selfIds: new Set(["U2"]) };
  const sales: ChannelInfo = { id: "C1", name: "sales", kind: "channel", members: [] };

  test("ids, times, thread keys and participants", () => {
    const e = toSlackEvent({ ts: "1782918600.000300", thread_ts: "1782918000.000200", user: "U2", text: "cc <@U1>" }, sales, map)!;
    expect(e.externalId).toBe("C1:1782918600.000300");
    expect(e.occurredAt).toBe("2026-07-01T15:10:00.000Z");
    expect(e.threadKey).toBe("C1:1782918000.000200");
    expect(e.inReplyTo).toEqual(["C1:1782918000.000200"]);
    expect(e.content.title).toBe("#sales");
    expect(e.participants).toEqual([
      { role: "from", address: "slack:U2", name: "Tom Fischer", self: true },
      { role: "mentioned", address: "maria@acme.example", name: "Maria Lopez" },
    ]);
    expect(e.meta["slackUserIds"]).toEqual(["U2", "U1"]);
  });

  test("DMs add the other members as `to`, titled by name", () => {
    const dm: ChannelInfo = { id: "D1", kind: "im", members: ["U1", "U2"] };
    const e = toSlackEvent({ ts: "1.000001", user: "U1", text: "hello" }, dm, map)!;
    expect(e.content.title).toBe("DM with Maria Lopez");
    expect(e.participants.map((p) => [p.role, p.address])).toEqual([
      ["from", "maria@acme.example"],
      ["to", "slack:U2"],
    ]);
    expect(e.threadKey).toBe("D1:1.000001");
    expect(e.inReplyTo).toBeUndefined();
  });

  test("bots and housekeeping are dropped unless asked for", () => {
    expect(toSlackEvent({ ts: "1.1", subtype: "bot_message", bot_id: "B9", text: "x" }, sales, map)).toBeNull();
    expect(toSlackEvent({ ts: "1.1", user: "B1", text: "x" }, sales, map)).toBeNull();
    expect(toSlackEvent({ ts: "1.1", subtype: "channel_join", user: "U1", text: "x" }, sales, map)).toBeNull();
    const withBots = { ...map, includeBots: true };
    expect(toSlackEvent({ ts: "1.1", user: "B1", text: "x" }, sales, withBots)).not.toBeNull();
    expect(toSlackEvent({ ts: "1.1", subtype: "channel_topic", user: "U1", text: "x" }, sales, withBots)).toBeNull();
  });
});

describe("helpers", () => {
  test("settings defaults and token type", () => {
    const s = resolveSettings({}, { YRM_SLACK_TOKEN: " xoxb-1 " });
    expect(s.token).toBe("xoxb-1");
    expect(s.maxPerSync).toBe(2000);
    expect(s.apiBase).toBe("https://slack.com/api");
    expect(dmsEnabled(s, s.token)).toBe(false);
    expect(dmsEnabled(s, "xoxp-1")).toBe(true);
    expect(dmsEnabled({ includeDMs: true }, "xoxb-1")).toBe(true);
    expect(resolveSettings({ tokenEnv: "X", maxPerSync: -1 }, { X: "xoxp-2" })).toMatchObject({ token: "xoxp-2", maxPerSync: 2000 });
  });

  test("channel filter by name or id", () => {
    expect(channelSelected([], "C1", "sales")).toBe(true);
    expect(channelSelected(["#Sales"], "C1", "sales")).toBe(true);
    expect(channelSelected(["sales"], "C1", "sales")).toBe(true);
    expect(channelSelected(["C1"], "C1", undefined)).toBe(true);
    expect(channelSelected(["#random"], "C1", "sales")).toBe(false);
  });

  test("timestamps compare exactly and convert to ISO", () => {
    expect(compareTs("1782918000.000200", "1782918000.000199")).toBeGreaterThan(0);
    expect(compareTs("1782918000.1", "1782918000.000200")).toBeGreaterThan(0);
    expect(compareTs("99.5", "100.0")).toBeLessThan(0);
    expect(tsToIso("1767225600.123456")).toBe("2026-01-01T00:00:00.123Z");
  });

  test("cursor summary parses or starts over", () => {
    expect(parseCursor(null)).toEqual({ v: 1, channels: {} });
    expect(parseCursor("garbage")).toEqual({ v: 1, channels: {} });
    expect(parseCursor('{"v":1,"channels":{"C1":"1.2"}}')).toEqual({ v: 1, channels: { C1: "1.2" } });
  });

  test("backoff honors Retry-After", () => {
    expect(backoffDelay(0, "3")).toBe(3000);
    expect(backoffDelay(2, null)).toBe(4000);
    expect(backoffDelay(10, undefined)).toBe(60_000);
  });

  test("the app manifest requests every documented scope, read-only", () => {
    const yaml = appManifestYaml().join("\n");
    for (const s of SCOPES) expect(yaml).toContain(`- ${s}`);
    expect(yaml).not.toMatch(/:write/);
  });
});
