import { describe, expect, it } from "bun:test";
import { describeToolFailure, formatToolFailureLine } from "./renderToolFailure.ts";

const toolResult = (text: string) => ({
  content: [{ type: "text", text }],
  isError: true,
});

describe("describeToolFailure", () => {
  it("extracts the exit code from pi's bash error suffix", () => {
    const details = describeToolFailure(toolResult("checking status…\n\nCommand exited with code 1"));
    expect(details.exitCode).toBe(1);
    expect(details.outputPreview).toBe("checking status…");
  });

  it("keeps multi-line output previews single-line", () => {
    const details = describeToolFailure(toolResult("line one\nline two\n\nCommand exited with code 130"));
    expect(details.exitCode).toBe(130);
    expect(details.outputPreview).toBe("line one · line two");
  });

  it("leaves genuine errors (no exit-code suffix) as null exitCode", () => {
    const details = describeToolFailure(
      toolResult('Traceback (most recent call last):\nKeyError: "boom"'),
    );
    expect(details.exitCode).toBeNull();
  });

  it("bounds the output preview", () => {
    const longBody = "x".repeat(500);
    const details = describeToolFailure(toolResult(`${longBody}\n\nCommand exited with code 1`));
    expect(details.exitCode).toBe(1);
    expect(details.outputPreview.length).toBeLessThanOrEqual(121);
    expect(details.outputPreview.endsWith("…")).toBe(true);
  });
});

describe("formatToolFailureLine", () => {
  it("renders bash exit-code failures compactly", () => {
    const line = formatToolFailureLine("bash", toolResult("diff a b\n\nCommand exited with code 1"));
    expect(line).toBe("-# bash → exit 1 · diff a b");
  });

  it("renders exit-code failures without a preview when output is empty", () => {
    const line = formatToolFailureLine("bash", toolResult("Command exited with code 2"));
    expect(line).toBe("-# bash → exit 2");
  });

  it("keeps the full ❌ rendering for genuine errors", () => {
    const line = formatToolFailureLine(
      "bash",
      toolResult('Traceback: KeyError "boom"'),
    );
    expect(line).toBe('-# ❌ bash failed: Traceback: KeyError "boom"');
  });
});