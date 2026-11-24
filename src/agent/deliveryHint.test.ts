import { describe, expect, test } from "bun:test";
import { deliveryHint, withDeliveryHint } from "./deliveryHint.ts";

describe("deliveryHint", () => {
  test("tools mode reminds the model to use the tool", () => {
    expect(deliveryHint("tools")).toContain("send_message");
  });

  test("stream mode adds nothing", () => {
    expect(deliveryHint("stream")).toBe("");
    expect(withDeliveryHint("hello", "stream")).toBe("hello");
  });

  test("the hint is appended, never prepended", () => {
    const prompt = "[user_id=1 message_id=2 created_at=x] frolic: hi";
    const withHint = withDeliveryHint(prompt, "tools");
    expect(withHint.startsWith(prompt)).toBe(true);
    expect(withHint.length).toBeGreaterThan(prompt.length);
  });

  test("the hint stays small — it repeats every turn", () => {
    expect(deliveryHint("tools").length).toBeLessThan(200);
  });
});
