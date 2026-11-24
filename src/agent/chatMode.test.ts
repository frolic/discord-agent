import { describe, expect, test } from "bun:test";
import { parseChatMode } from "./chatMode.ts";

describe("parseChatMode", () => {
  test("defaults to stream when unset or blank", () => {
    expect(parseChatMode(undefined)).toBe("stream");
    expect(parseChatMode("")).toBe("stream");
    expect(parseChatMode("   ")).toBe("stream");
  });

  test("accepts the two documented values, tolerating surrounding space", () => {
    expect(parseChatMode("stream")).toBe("stream");
    expect(parseChatMode("tools")).toBe("tools");
    expect(parseChatMode(" tools\n")).toBe("tools");
  });

  test("throws on an unknown value instead of falling back to stream", () => {
    expect(() => parseChatMode("tool")).toThrow(/CHAT_MODE must be/);
    expect(() => parseChatMode("STREAM")).toThrow(/CHAT_MODE must be/);
  });
});
