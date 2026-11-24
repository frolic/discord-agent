import { describe, expect, test } from "bun:test";
import { parseChatMode, parseChatThinkingLevel } from "./chatMode.ts";

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

describe("parseChatThinkingLevel", () => {
  test("unset or blank means the mode decides", () => {
    expect(parseChatThinkingLevel(undefined)).toBeNull();
    expect(parseChatThinkingLevel("")).toBeNull();
    expect(parseChatThinkingLevel("  ")).toBeNull();
  });

  test("accepts every pi thinking level", () => {
    for (const level of ["off", "minimal", "low", "medium", "high", "xhigh", "max"] as const) {
      expect(parseChatThinkingLevel(level)).toBe(level);
    }
  });

  test("throws on anything else", () => {
    expect(() => parseChatThinkingLevel("none")).toThrow(/CHAT_THINKING_LEVEL must be/);
    expect(() => parseChatThinkingLevel("HIGH")).toThrow(/CHAT_THINKING_LEVEL must be/);
  });
});
