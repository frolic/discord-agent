import { describe, expect, test } from "bun:test";
import type { ImageContent } from "@earendil-works/pi-ai";
import { buildPromptOptions } from "./buildPromptOptions.ts";

const image: ImageContent = { type: "image", data: "AAAA", mimeType: "image/png" };

/**
 * The contract that matters here is the `isBusy` → `streamingBehavior: "steer"`
 * pairing: `createAgentPool.handle` derives both the option and its own branch
 * from one reading of the session's busy flag, so if this function ever stopped
 * steering when busy, an interrupting user message would be submitted as a
 * fresh prompt into a run that is already starting — which pi rejects.
 */
describe("buildPromptOptions", () => {
  test("idle session with no images → no options at all", () => {
    expect(buildPromptOptions({ images: [], isBusy: false })).toEqual({});
  });

  test("idle session with images → images only, no steering", () => {
    expect(buildPromptOptions({ images: [image], isBusy: false })).toEqual({ images: [image] });
  });

  test("busy session with no images → steer only", () => {
    expect(buildPromptOptions({ images: [], isBusy: true })).toEqual({
      streamingBehavior: "steer",
    });
  });

  test("busy session with images → both images and steer", () => {
    expect(buildPromptOptions({ images: [image], isBusy: true })).toEqual({
      images: [image],
      streamingBehavior: "steer",
    });
  });
});
