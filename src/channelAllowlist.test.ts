/**
 * Tests for the channel allowlist — the parse of
 * `DISCORD_CHANNEL_ALLOWLIST` and the wake predicate the router applies to
 * both `messageCreate` and `messageUpdate`.
 *
 * The interesting cases are the empty list (must preserve the historical
 * "wake everywhere" behaviour) and threads (a thread inherits its parent
 * channel, so an allowed channel's threads are allowed and nobody else's
 * are).
 */
import { describe, expect, test } from "bun:test";
import { isChannelAllowed, parseChannelAllowlist } from "./channelAllowlist.ts";

describe("parseChannelAllowlist", () => {
  test("unset or empty means no restriction", () => {
    expect(parseChannelAllowlist(undefined)).toEqual([]);
    expect(parseChannelAllowlist("")).toEqual([]);
    expect(parseChannelAllowlist("   ")).toEqual([]);
  });

  test("splits on commas, whitespace, and both mixed", () => {
    expect(parseChannelAllowlist("111,222")).toEqual(["111", "222"]);
    expect(parseChannelAllowlist("111 222\n333")).toEqual(["111", "222", "333"]);
    expect(parseChannelAllowlist(" 111 , 222 ")).toEqual(["111", "222"]);
  });

  test("drops empty entries and duplicates", () => {
    expect(parseChannelAllowlist("111,,222,")).toEqual(["111", "222"]);
    expect(parseChannelAllowlist("111,111,222")).toEqual(["111", "222"]);
  });
});

describe("isChannelAllowed", () => {
  test("an empty allowlist allows every channel", () => {
    expect(isChannelAllowed({ allowlist: [], channelId: "111" })).toBe(true);
  });

  test("a listed channel is allowed, an unlisted one is not", () => {
    const allowlist = ["111", "222"];
    expect(isChannelAllowed({ allowlist, channelId: "111" })).toBe(true);
    expect(isChannelAllowed({ allowlist, channelId: "999" })).toBe(false);
  });

  test("a thread is allowed when its parent channel is", () => {
    const allowlist = ["111"];
    expect(isChannelAllowed({ allowlist, channelId: "777", parentChannelId: "111" })).toBe(true);
  });

  test("a thread under an unlisted channel is not allowed", () => {
    const allowlist = ["111"];
    expect(isChannelAllowed({ allowlist, channelId: "777", parentChannelId: "999" })).toBe(false);
  });

  test("a listed thread id is allowed even without its parent", () => {
    const allowlist = ["777"];
    expect(isChannelAllowed({ allowlist, channelId: "777", parentChannelId: null })).toBe(true);
  });

  test("a thread with no known parent and no listing is not allowed", () => {
    const allowlist = ["111"];
    expect(isChannelAllowed({ allowlist, channelId: "777", parentChannelId: null })).toBe(false);
  });
});
