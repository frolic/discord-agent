import { describe, expect, test } from "bun:test";
import { findSafeSplit } from "./findSafeSplit.ts";

const opts = (overrides: Partial<{ softLimit: number; hardLimit: number; force: boolean }> = {}) => ({
  softLimit: 50,
  hardLimit: 100,
  force: false,
  ...overrides,
});

describe("findSafeSplit — null cases", () => {
  test("empty buffer returns null", () => {
    expect(findSafeSplit("", opts())).toBeNull();
  });

  test("no paragraph seam, !force, returns null even past softLimit", () => {
    const text = "a".repeat(80);
    expect(findSafeSplit(text, opts({ softLimit: 50, hardLimit: 100, force: false }))).toBeNull();
  });

  test("paragraph seams all past softLimit and !force returns null", () => {
    // Long paragraph then a break far past softLimit.
    const text = "x".repeat(80) + "\n\n" + "y".repeat(10);
    expect(findSafeSplit(text, opts({ softLimit: 50, hardLimit: 200 }))).toBeNull();
  });
});

describe("findSafeSplit — paragraph seams", () => {
  test("simple two-paragraph split", () => {
    const text = "para1\n\npara2";
    const result = findSafeSplit(text, opts({ softLimit: 20 }));
    expect(result).toEqual({ keep: "para1", carryOver: "para2" });
  });

  test("picks latest paragraph seam at-or-before softLimit", () => {
    const text = "p1\n\np2\n\np3\n\np4";
    const result = findSafeSplit(text, opts({ softLimit: 11 }));
    // Seams at offsets after each blank: p2 starts at 4, p3 at 8, p4 at 12.
    // softLimit=11 → latest seam ≤ 11 is the one before p4 (offset 8 → keep "p1\n\np2\n\np3" → trim to "p1\n\np2\n\np3"... wait that's > 11. Let me recheck.
    // Actually: positions in collectSeams are the START OF NEXT LINE after the blank.
    // "p1\n\np2\n\np3\n\np4" indices:
    //   p1\n  → 0,1,2
    //   \n    → 3 (blank line at offset 3..3)
    //   p2\n  → 4,5,6
    //   \n    → 7 (blank line)
    //   p3\n  → 8,9,10
    //   \n    → 11 (blank line)
    //   p4    → 12,13
    // Paragraph seams pushed at 4, 8, 12.
    // Latest ≤ 11 → 8 → keep="p1\n\np2\n" (trimmed → "p1\n\np2"), carry="\np3\n\np4" (trimmed → "p3\n\np4")
    expect(result?.keep).toBe("p1\n\np2");
    expect(result?.carryOver).toBe("p3\n\np4");
  });

  test("multiple consecutive blank lines collapse cleanly", () => {
    const text = "a\n\n\n\nb";
    const result = findSafeSplit(text, opts({ softLimit: 10 }));
    expect(result).toEqual({ keep: "a", carryOver: "b" });
  });

  test("CRLF line endings split cleanly because String.trim() strips \\r", () => {
    // The state machine splits on \n only, but the per-line .trim() check
    // for blank-line detection drops \r so the run "...\r\n\r\n..." reads
    // as "non-blank line, blank line" — same shape as LF input.
    const text = "para1\r\n\r\npara2";
    const result = findSafeSplit(text, opts({ softLimit: 20 }));
    expect(result?.keep).toBe("para1");
    expect(result?.carryOver).toBe("para2");
  });
});

describe("findSafeSplit — fenced code blocks", () => {
  test("paragraph seam INSIDE code block is suppressed; rolls back to before fence open", () => {
    const text = "intro\n\n```ts\nconst x = 1;\n\nconst y = 2;\n```\n\noutro";
    // The blank line inside the code block (between the two consts) is
    // INSIDE the fence — must not be a paragraph seam.
    // Seams should be: 7 (between intro and code), and the position after
    // closing fence. With softLimit < the second seam, we pick 7.
    const result = findSafeSplit(text, opts({ softLimit: 30, hardLimit: 200 }));
    expect(result?.keep).toBe("intro");
    expect(result?.carryOver.startsWith("```ts")).toBe(true);
  });

  test("seam after closing fence is preferred when softLimit allows", () => {
    const text = "intro\n\n```ts\nconst x = 1;\n```\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    // Two paragraph seams: before code, after code. Latest wins.
    expect(result?.keep).toBe("intro\n\n```ts\nconst x = 1;\n```");
    expect(result?.carryOver).toBe("outro");
  });

  test("rollback past open fence when no paragraph after", () => {
    // Buffer mid-stream: code block opened but not yet closed. softLimit
    // exceeded inside the code block. Only safe seam is before the code.
    const text = "intro\n\n```ts\n" + "const x = 1;\n".repeat(20);
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 500 }));
    expect(result?.keep).toBe("intro");
    expect(result?.carryOver.startsWith("```ts")).toBe(true);
  });

  test("tilde fences work like backtick fences", () => {
    const text = "intro\n\n~~~ts\nconst x = 1;\n\nconst y = 2;\n~~~\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 30, hardLimit: 200 }));
    expect(result?.keep).toBe("intro");
    expect(result?.carryOver.startsWith("~~~ts")).toBe(true);
  });

  test("longer closing fence (≥ opener) closes the block", () => {
    // Open with 3, close with 5 — CommonMark allows this.
    const text = "intro\n\n```\nbody\n`````\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    expect(result?.keep).toBe("intro\n\n```\nbody\n`````");
    expect(result?.carryOver).toBe("outro");
  });

  test("shorter closing fence (< opener) does NOT close the block", () => {
    // Open with 4, attempt close with 3 — block stays open through it.
    const text = "intro\n\n````\nbody\n```\nmore\n````\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 500 }));
    // The 3-tick line is inside the still-open 4-tick fence. The 4-tick
    // line at the end closes it. Paragraph seam before code AND after.
    expect(result?.keep).toBe("intro\n\n````\nbody\n```\nmore\n````");
    expect(result?.carryOver).toBe("outro");
  });

  test("mismatched fence char does NOT close the block", () => {
    const text = "intro\n\n```ts\n~~~\n```\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    // ~~~ inside ```ts code shouldn't close.
    expect(result?.keep).toBe("intro\n\n```ts\n~~~\n```");
    expect(result?.carryOver).toBe("outro");
  });

  test("closing fence with trailing non-whitespace does NOT close", () => {
    const text = "intro\n\n```\nbody\n``` extra\n```\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    expect(result?.keep).toBe("intro\n\n```\nbody\n``` extra\n```");
    expect(result?.carryOver).toBe("outro");
  });

  test("up to 3 leading spaces still counts as a fence line", () => {
    const text = "intro\n\n   ```ts\nbody\n   ```\n\nouter";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    expect(result?.keep).toBe("intro\n\n   ```ts\nbody\n   ```");
    expect(result?.carryOver).toBe("outer");
  });

  test("4+ leading spaces is NOT a fence line (indented code block, ignored)", () => {
    // We don't recognize indented code blocks specifically. A 4-space
    // "fence" line is just text, so the fence state is unchanged.
    const text = "intro\n\n    ```ts\nbody\n```\n\nouter";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    // The 4-space line is plain text. The next ``` is still a fence opener
    // (opens code). After "outer" there's a paragraph break, but nothing
    // closes the fence. So the only safe seam is before the fence.
    // Lines:
    //   "intro" → seam, then blank → para seam at offset 7
    //   "    ```ts" → not a fence (4-space prefix), plain line
    //   "body" → plain
    //   "```" → fence opener (3 backticks, valid)
    //   "" blank inside code
    //   "outer" inside code
    // Paragraph seam after code? code never closes → no.
    expect(result?.keep).toBe("intro");
  });
});

describe("findSafeSplit — softLimit / hardLimit interaction", () => {
  test("paragraph seam past softLimit but within hardLimit is NOT taken (force=false)", () => {
    const text = "a".repeat(60) + "\n\n" + "b".repeat(10);
    // Paragraph seam at offset 62 (after the two newlines).
    // softLimit=50, hardLimit=100, force=false → no clean seam ≤ 50 → null.
    expect(findSafeSplit(text, opts({ softLimit: 50, hardLimit: 100, force: false }))).toBeNull();
  });

  test("force=true falls back to line seam past softLimit", () => {
    const text = "a".repeat(60) + "\nb".repeat(20);
    const result = findSafeSplit(text, opts({ softLimit: 50, hardLimit: 100, force: true }));
    // No paragraph seam. linesOutsideCode: at every \n. Latest ≤ 100 wins.
    expect(result).not.toBeNull();
    expect(result!.keep.length).toBeLessThanOrEqual(100);
    expect(result!.keep.endsWith("a") || result!.keep.endsWith("b")).toBe(true);
  });

  test("force=true with no line breaks falls back to word boundary", () => {
    const text = "word ".repeat(30); // 150 chars, spaces but no newlines
    const result = findSafeSplit(text, opts({ softLimit: 50, hardLimit: 100, force: true }));
    expect(result).not.toBeNull();
    expect(result!.keep.length).toBeLessThanOrEqual(100);
    // Word-boundary cut: keep ends mid-string but on a word boundary.
    expect(result!.keep.endsWith("word")).toBe(true);
  });

  test("force=true with no boundaries hard-cuts at hardLimit", () => {
    const text = "x".repeat(150);
    const result = findSafeSplit(text, opts({ softLimit: 50, hardLimit: 100, force: true }));
    expect(result).not.toBeNull();
    expect(result!.keep.length).toBe(100);
    expect(result!.carryOver.length).toBe(50);
  });

  test("paragraph seam picked is the LATEST one within softLimit", () => {
    const text = "a\n\nb\n\nc\n\nd\n\ne";
    // Paragraph seams at: 3 (b), 6 (c), 9 (d), 12 (e).
    const result = findSafeSplit(text, opts({ softLimit: 9 }));
    // Latest ≤ 9 is 9 → keep = "a\n\nb\n\nc\n\n" → trim → "a\n\nb\n\nc"
    expect(result?.keep).toBe("a\n\nb\n\nc");
    expect(result?.carryOver).toBe("d\n\ne");
  });
});

describe("findSafeSplit — block formatting (lists, blockquotes, headings)", () => {
  test("list runs without blank lines stay together", () => {
    const text = "intro\n\n- one\n- two\n- three\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    // Two paragraph seams: before list, after list.
    expect(result?.keep).toBe("intro\n\n- one\n- two\n- three");
    expect(result?.carryOver).toBe("outro");
  });

  test("rolling back past a list keeps the list intact in the new message", () => {
    // Long list, no good seam near the end → roll back to before the list.
    const text = "intro\n\n" + Array.from({ length: 30 }, (_, i) => `- item${i}`).join("\n");
    const result = findSafeSplit(text, opts({ softLimit: 100, hardLimit: 500 }));
    expect(result?.keep).toBe("intro");
    expect(result?.carryOver.startsWith("- item0")).toBe(true);
  });

  test("blockquote runs stay together", () => {
    const text = "intro\n\n> line one\n> line two\n> line three\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    expect(result?.keep).toBe("intro\n\n> line one\n> line two\n> line three");
    expect(result?.carryOver).toBe("outro");
  });

  test("headings split cleanly at paragraph boundaries around them", () => {
    const text = "intro\n\n## Section\n\nbody\n\n## Next\n\nmore";
    const result = findSafeSplit(text, opts({ softLimit: 30, hardLimit: 200 }));
    // Seams at "## Section" start, "body" start, "## Next" start, "more" start.
    expect(result?.keep.endsWith("body") || result?.keep.endsWith("Section")).toBe(true);
    expect(result?.carryOver.length).toBeGreaterThan(0);
  });

  test("table-like content (line-prefix '|') stays together if no blank line breaks it", () => {
    // Discord doesn't render markdown tables, but the user asked for these
    // not to be split mid-table. Lines with '|' look "table-like"; without
    // blank lines between rows, paragraph-seam rule keeps them together.
    const text = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\noutro";
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 200 }));
    expect(result?.keep).toBe("intro\n\n| a | b |\n| - | - |\n| 1 | 2 |");
    expect(result?.carryOver).toBe("outro");
  });
});

describe("findSafeSplit — whitespace & trimming", () => {
  test("trims trailing whitespace on keep", () => {
    const text = "para1   \n\npara2";
    const result = findSafeSplit(text, opts({ softLimit: 20 }));
    expect(result?.keep).toBe("para1");
  });

  test("trims leading whitespace on carryOver", () => {
    const text = "para1\n\n   para2";
    const result = findSafeSplit(text, opts({ softLimit: 20 }));
    expect(result?.carryOver).toBe("para2");
  });

  test("preserves internal whitespace", () => {
    const text = "para1 word1  word2\n\npara2 word3";
    const result = findSafeSplit(text, opts({ softLimit: 20 }));
    expect(result?.keep).toBe("para1 word1  word2");
  });
});

describe("findSafeSplit — edge cases", () => {
  test("doc starting with paragraph break does not record a seam at offset 0", () => {
    const text = "\n\npara1";
    const result = findSafeSplit(text, opts({ softLimit: 50 }));
    expect(result).toBeNull();
  });

  test("doc ending with trailing blank lines: latest seam keeps everything", () => {
    // Trailing blank lines create a paragraph seam after the last paragraph.
    // The latest-within-softLimit policy picks that seam, leaving carryOver
    // empty after trim. This is the right behavior — the splitter says
    // "everything fits in one message; nothing to carry."
    const text = "para1\n\npara2\n\n";
    const result = findSafeSplit(text, opts({ softLimit: 200 }));
    expect(result?.keep).toBe("para1\n\npara2");
    expect(result?.carryOver).toBe("");
  });

  test("only paragraph seam at exact softLimit boundary is included", () => {
    // "a\n\nb" — paragraph seam at offset 3.
    const text = "a\n\nb";
    expect(findSafeSplit(text, opts({ softLimit: 3 }))?.keep).toBe("a");
    expect(findSafeSplit(text, opts({ softLimit: 2 }))).toBeNull();
  });

  test("force=true on text under hardLimit still splits if any seam exists", () => {
    const text = "para1\n\npara2";
    const result = findSafeSplit(text, opts({ softLimit: 5, hardLimit: 100, force: true }));
    expect(result?.keep).toBe("para1");
    expect(result?.carryOver).toBe("para2");
  });

  test("realistic-ish: long prose with code block at the end (rollback case)", () => {
    const prose = Array.from({ length: 8 }, (_, i) => `Sentence number ${i} of the prose.`).join(" ");
    // Single long paragraph (no blank lines) followed by a code block.
    const text = `${prose}\n\n\`\`\`ts\nconst x = 42;\n\`\`\``;
    // softLimit small enough that we can't fit the code block — but the
    // paragraph seam between prose and code IS within softLimit.
    const result = findSafeSplit(text, opts({ softLimit: prose.length + 5, hardLimit: 1000 }));
    expect(result?.keep).toBe(prose);
    expect(result?.carryOver).toBe("```ts\nconst x = 42;\n```");
  });

  test("realistic: stream is mid-code-block when limit hit, must roll back", () => {
    // Common shape: a streaming response whose code block isn't closed yet.
    const prefix = "Here's the implementation:\n\n";
    const code = "```ts\n" + "// long code line\n".repeat(50);
    const text = prefix + code;
    const result = findSafeSplit(text, opts({ softLimit: 200, hardLimit: 1000 }));
    // Only safe seam: between prefix and the open code fence.
    expect(result?.keep).toBe(prefix.trim());
    expect(result?.carryOver.startsWith("```ts")).toBe(true);
  });
});
