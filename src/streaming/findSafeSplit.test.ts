import { describe, expect, test } from "bun:test";
import { findSafeSplit } from "./findSafeSplit.ts";
import { prepareForDelivery } from "./prepareForDelivery.ts";

const opts = (overrides: Partial<{ softLimit: number; hardLimit: number; force: boolean }> = {}) => ({
  softLimit: 50,
  hardLimit: 100,
  force: false,
  ...overrides,
});

describe("findSafeSplit — null cases", () => {
  test("empty payload returns null", () => {
    const prep = prepareForDelivery("");
    expect(findSafeSplit(prep, opts())).toBeNull();
  });

  test("single block past softLimit, no force → null", () => {
    // One huge paragraph, no internal seam.
    const prep = prepareForDelivery("a".repeat(80));
    expect(findSafeSplit(prep, opts({ softLimit: 50, hardLimit: 100, force: false }))).toBeNull();
  });

  test("two blocks but boundary past softLimit, no force → null", () => {
    const prep = prepareForDelivery("a".repeat(60) + "\n\nb".repeat(10));
    expect(findSafeSplit(prep, opts({ softLimit: 50, hardLimit: 200, force: false }))).toBeNull();
  });
});

describe("findSafeSplit — block boundaries", () => {
  test("two paragraphs, latest boundary picked", () => {
    const prep = prepareForDelivery("first paragraph\n\nsecond paragraph");
    const result = findSafeSplit(prep, opts({ softLimit: 50 }));
    expect(result?.keepRendered).toBe("first paragraph");
    // Carry-over starts at the second paragraph in the raw buffer.
    expect(result?.rawConsumed).toBe(15); // length of "first paragraph"
  });

  test("picks latest block boundary at-or-before softLimit", () => {
    const prep = prepareForDelivery("aaa\n\nbbb\n\nccc\n\nddd\n\neee");
    // Block ends in rendered: 3, 8, 13, 18, 23. Soft 12 → latest ≤ 12 is 8 (boundary after "bbb").
    const result = findSafeSplit(prep, opts({ softLimit: 12 }));
    expect(result?.keepRendered).toBe("aaa\n\nbbb");
  });

  test("paragraph + code block + paragraph: boundary AFTER code block is preferred when in budget", () => {
    const prep = prepareForDelivery("intro\n\n```ts\nconst x = 1;\n```\n\nouter");
    const result = findSafeSplit(prep, opts({ softLimit: 200, hardLimit: 200 }));
    expect(result?.keepRendered).toMatch(/```\s*$/);
    // Code blocks get a single-newline separator (not blank-line) since
    // Discord's code-block chrome already provides visual separation.
    expect(result?.keepRendered.startsWith("intro\n```ts")).toBe(true);
  });

  test("rollback: code block too big, must seal before its open fence", () => {
    const longCode = "```ts\n" + "const x = 1;\n".repeat(50) + "```";
    const prep = prepareForDelivery("intro paragraph\n\n" + longCode);
    const result = findSafeSplit(prep, opts({ softLimit: 100, hardLimit: 1000 }));
    expect(result?.keepRendered).toBe("intro paragraph");
    expect(result?.rawConsumed).toBeLessThan(longCode.length);
  });
});

describe("findSafeSplit — list / blockquote / heading blocks", () => {
  test("list block stays whole; seal before or after, never inside", () => {
    const prep = prepareForDelivery("intro\n\n- one\n- two\n- three\n\nouter");
    const result = findSafeSplit(prep, opts({ softLimit: 100, hardLimit: 200 }));
    // Latest boundary is after the list, so keepRendered ends with the
    // last list item.
    expect(result?.keepRendered).toMatch(/three\s*$/);
  });

  test("rollback past a long list keeps the list intact in carry-over", () => {
    const list = Array.from({ length: 30 }, (_, i) => `- item${i}`).join("\n");
    const prep = prepareForDelivery("intro\n\n" + list);
    const result = findSafeSplit(prep, opts({ softLimit: 50, hardLimit: 500 }));
    expect(result?.keepRendered).toBe("intro");
  });

  test("blockquote treated as one block", () => {
    const prep = prepareForDelivery("intro\n\n> a quote line\n> another line\n\nouter");
    const result = findSafeSplit(prep, opts({ softLimit: 200 }));
    expect(result?.keepRendered).toMatch(/another line\s*$/);
  });

  test("heading is its own block", () => {
    const prep = prepareForDelivery("intro\n\n## Section\n\nbody");
    const result = findSafeSplit(prep, opts({ softLimit: 20 }));
    // softLimit=20: only "intro" fits as a complete block. Boundaries
    // after it: rendered offset 5 (intro), 16 (heading), then body.
    // Latest ≤ 20 is offset 16 (after heading).
    expect(result?.keepRendered).toMatch(/Section\s*$/);
  });
});

describe("findSafeSplit — forced fallbacks", () => {
  test("force=true falls back to word boundary inside a single huge paragraph", () => {
    const para = "word ".repeat(40); // 200 chars, no internal block seam
    const prep = prepareForDelivery(para);
    const result = findSafeSplit(prep, opts({ softLimit: 50, hardLimit: 100, force: true }));
    expect(result).not.toBeNull();
    expect(result!.keepRendered.length).toBeLessThanOrEqual(100);
    expect(result!.keepRendered.endsWith("word")).toBe(true);
  });

  test("force=true on a single huge code block closes the fence", () => {
    const code = "```ts\n" + "x = 1\n".repeat(30); // unfinished fence
    const prep = prepareForDelivery(code);
    const result = findSafeSplit(prep, opts({ softLimit: 50, hardLimit: 100, force: true }));
    expect(result).not.toBeNull();
    expect(result!.keepRendered.endsWith("```")).toBe(true);
    expect(result!.keepRendered.length).toBeLessThanOrEqual(100);
  });

  test("force=true with no usable content hard-cuts at hardLimit", () => {
    const prep = prepareForDelivery("x".repeat(150));
    const result = findSafeSplit(prep, opts({ softLimit: 50, hardLimit: 100, force: true }));
    expect(result).not.toBeNull();
    expect(result!.keepRendered.length).toBe(100);
  });
});

describe("findSafeSplit — table transform interaction", () => {
  test("a long table renders as code block; if it doesn't fit, we roll back to before it", () => {
    const longTable =
      "| col1 | col2 |\n| - | - |\n" +
      Array.from({ length: 30 }, (_, i) => `| item${i} | desc${i} |`).join("\n");
    const prep = prepareForDelivery("intro\n\n" + longTable + "\n\nouter");
    const result = findSafeSplit(prep, opts({ softLimit: 100, hardLimit: 1000 }));
    expect(result?.keepRendered).toBe("intro");
  });

  test("a small table fits in one block boundary seal", () => {
    const prep = prepareForDelivery("intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nouter");
    const result = findSafeSplit(prep, opts({ softLimit: 200 }));
    // Latest boundary should land between table and "outer".
    expect(result?.keepRendered).toMatch(/```\s*$/);
  });
});

describe("findSafeSplit — partial-stream cases", () => {
  test("buffer mid-code-block (unclosed fence) returns rollback to before fence", () => {
    const prep = prepareForDelivery("Here:\n\n```ts\nconst x = 1\nconst y = 2");
    const result = findSafeSplit(prep, opts({ softLimit: 200, hardLimit: 1000 }));
    // Two blocks: "Here:" paragraph and the unclosed code (which remark
    // parses as a code node spanning to EOF). softLimit > "Here:".length
    // so the boundary AFTER "Here:" is picked.
    expect(result?.keepRendered).toBe("Here:");
  });

  test("buffer mid-bold (`Some **bo`): remend closes inline, single paragraph block", () => {
    const prep = prepareForDelivery("Some **bo");
    expect(prep.blocks.length).toBe(1);
    expect(prep.blocks[0]!.node.type).toBe("paragraph");
  });
});
