import { describe, expect, test } from "bun:test";
import { chunkRendered } from "./chunkRendered.ts";
import { prepareForDelivery } from "./prepareForDelivery.ts";

describe("chunkRendered — basic shape", () => {
  test("empty input returns empty array", () => {
    const prep = prepareForDelivery("");
    expect(chunkRendered(prep, { hardLimit: 100 })).toEqual([]);
  });

  test("content under hardLimit yields one chunk", () => {
    const prep = prepareForDelivery("just a paragraph");
    expect(chunkRendered(prep, { hardLimit: 100 })).toEqual(["just a paragraph"]);
  });

  test("content well under hardLimit with multiple blocks stays as one chunk", () => {
    const prep = prepareForDelivery("first\n\nsecond\n\nthird");
    const chunks = chunkRendered(prep, { hardLimit: 100 });
    expect(chunks).toEqual(["first\n\nsecond\n\nthird"]);
  });
});

describe("chunkRendered — packing across hardLimit", () => {
  test("blocks split into separate chunks at the latest boundary that fits", () => {
    const prep = prepareForDelivery("aaaa\n\nbbbb\n\ncccc\n\ndddd");
    const chunks = chunkRendered(prep, { hardLimit: 12 });
    // Each block is 4 chars; separator between two is "\n\n" (2 chars).
    // First chunk packs blocks until the next would push over 12 chars.
    // "aaaa\n\nbbbb" = 10 chars, adding "\n\ncccc" would be 16 > 12.
    expect(chunks[0]).toBe("aaaa\n\nbbbb");
    expect(chunks).toHaveLength(2);
    expect(chunks[1]).toBe("cccc\n\ndddd");
  });

  test("each chunk respects hardLimit", () => {
    const blocks = Array.from({ length: 10 }, (_, i) => `block ${i}`);
    const prep = prepareForDelivery(blocks.join("\n\n"));
    const chunks = chunkRendered(prep, { hardLimit: 30 });
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(30);
    }
  });
});

describe("chunkRendered — no proactive heading splits", () => {
  test("heading inline with body content stays in one chunk when everything fits", () => {
    // Splits are size-driven, not structure-driven. A heading appearing
    // mid-buffer is NOT a reason to start a new chunk on its own — only
    // overflow is. Inline markdown rendering of the heading still gives
    // visual section structure within the single Discord message.
    const prep = prepareForDelivery("intro paragraph\n\n## Section\n\nbody");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("intro paragraph\n\n## Section\n\nbody");
  });

  test("bold-only-line is NOT a proactive split target when content fits", () => {
    const prep = prepareForDelivery("intro\n\n**Section title**\n\nbody");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("intro\n\n**Section title**\n\nbody");
  });

  test("first block being heading-like doesn't trigger an empty chunk", () => {
    const prep = prepareForDelivery("## Section\n\nbody");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startsWith("## Section")).toBe(true);
  });

  test("trailing heading-like block stays packed (no orphan during streaming)", () => {
    // Mid-stream snapshot: model has emitted "Para.\n\n**Skill file**"
    // and is about to continue. Old behavior posted a Discord message
    // containing just "**Skill file**", which then got orphaned when
    // the next delta made the paragraph multi-child (re-chunking
    // produced 1 chunk but messages.length was 2). New behavior: no
    // proactive split at all → mid-stream stays as 1 chunk.
    const prep = prepareForDelivery("Done. Here's the summary:\n\n**Skill file**");
    const chunks = chunkRendered(prep, { hardLimit: 1990 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Done. Here's the summary:\n\n**Skill file**");
  });

  test("heading mid-stream then completed: chunk count is monotonic", () => {
    // The original orphan bug came from chunk count regressing (2 → 1)
    // between flushes. With size-only splitting, the chunk count is
    // monotonic non-decreasing by construction.
    const midStream = prepareForDelivery("Done.\n\n**Skill file**");
    const completed = prepareForDelivery(
      "Done.\n\n**Skill file** at `path` — content\n- bullet one\n- bullet two",
    );
    const midChunks = chunkRendered(midStream, { hardLimit: 1990 });
    const completedChunks = chunkRendered(completed, { hardLimit: 1990 });
    expect(midChunks.length).toBeLessThanOrEqual(completedChunks.length);
    expect(midChunks).toHaveLength(1);
    expect(completedChunks).toHaveLength(1);
  });
});

describe("chunkRendered — heading-keep on overflow", () => {
  test("heading-then-block at the overflow boundary carries the heading forward", () => {
    // Setup: a body big enough that the next chunk has room only for a
    // heading + a small block, not for the heading + body + next-block.
    // The about-to-commit chunk has the heading as its trailing block;
    // the heading should be lifted off and packed with the new block in
    // the next chunk, NOT left orphaned at the end of message N.
    const body = "a".repeat(180);
    const prep = prepareForDelivery(`${body}\n\n## Section\n\nbody after`);
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    // First chunk should be JUST the long body (no heading clinging to
    // its end). Heading + body-after go in chunk 2.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(body);
    expect(chunks[1]).toBe("## Section\n\nbody after");
  });

  test("bold-only-line heading also gets carried forward on overflow", () => {
    const body = "a".repeat(180);
    const prep = prepareForDelivery(`${body}\n\n**Section title**\n\nbody after`);
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(body);
    expect(chunks[1]).toBe("**Section title**\n\nbody after");
  });

  test("multiple stacked headings all get carried forward together", () => {
    // body + heading1 + heading2 + body-after → split at the body
    // boundary, heading1 + heading2 both go with body-after.
    const body = "a".repeat(180);
    const prep = prepareForDelivery(`${body}\n\n## A\n\n## B\n\nbody after`);
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(body);
    expect(chunks[1]).toBe("## A\n\n## B\n\nbody after");
  });

  test("orphan-or-empty edge case: don't pop if the current chunk would be empty", () => {
    // Run starts with just a heading; the next block (a long body) by
    // itself doesn't fit in a chunk that also contains the heading.
    // Popping would leave the current chunk empty — refuse to pop, accept
    // the orphan rather than loop or emit nothing.
    const body = "a".repeat(195);
    const prep = prepareForDelivery(`## Section\n\n${body}`);
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    // "## Section" + "\n\n" + body = 10 + 2 + 195 = 207 > 200, so they
    // can't share a chunk. With no preceding block to commit, the
    // heading alone commits as chunk 1; body goes to chunk 2.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe("## Section");
    expect(chunks[1]).toBe(body);
  });

  test("don't pop if carried heading + new block would themselves overflow", () => {
    // Current run = [intro, heading]. Next block doesn't fit even with
    // the heading lifted (heading + new block exceeds hardLimit). Keep
    // the heading where it is and split at the block boundary instead.
    const heading = "## " + "h".repeat(50);
    const block = "b".repeat(190);
    const prep = prepareForDelivery(`intro\n\n${heading}\n\n${block}`);
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    // heading.length = 53, block.length = 190, sep = 2 → 245 > 200.
    // Can't pop the heading without overflowing next chunk. Heading stays
    // with intro in chunk 1, block alone in chunk 2.
    expect(chunks).toHaveLength(2);
    expect(chunks[0]).toBe(`intro\n\n${heading}`);
    expect(chunks[1]).toBe(block);
  });
});

describe("chunkRendered — separator picking", () => {
  test("non-code block transitions use blank-line separators between blocks within a chunk", () => {
    const prep = prepareForDelivery("first\n\nsecond");
    const chunks = chunkRendered(prep, { hardLimit: 100 });
    expect(chunks[0]).toBe("first\n\nsecond");
  });

  test("code-adjacent transitions use single-newline separators within a chunk", () => {
    const prep = prepareForDelivery("intro\n\n```\ncode\n```\n\nouter");
    const chunks = chunkRendered(prep, { hardLimit: 100 });
    // prepareForDelivery already emits single-newline separators around
    // code blocks; chunkRendered should preserve that within a chunk.
    expect(chunks[0]).toBe("intro\n```\ncode\n```\nouter");
  });
});

describe("chunkRendered — table chunking with header repeat", () => {
  test("oversized table chunks at row boundaries with the header on every chunk", () => {
    const rows = Array.from({ length: 30 }, (_, i) => `| item-${i} | description-${i} | value-${i} |`);
    const raw = "| name | desc | value |\n| - | - | - |\n" + rows.join("\n");
    const prep = prepareForDelivery(raw);
    const chunks = chunkRendered(prep, { hardLimit: 200 });

    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.startsWith("```")).toBe(true);
      expect(c.endsWith("```")).toBe(true);
      // Header column names appear in every chunk.
      expect(c).toContain("name");
      expect(c).toContain("desc");
      expect(c).toContain("value");
      // Each chunk respects hardLimit.
      expect(c.length).toBeLessThanOrEqual(200);
    }
  });

  test("table that needs 3+ chunks keeps the header on every chunk", () => {
    const rows = Array.from({ length: 60 }, (_, i) => `| ${i} | r${i} |`);
    const raw = "| n | row |\n| - | - |\n" + rows.join("\n");
    const prep = prepareForDelivery(raw);
    const chunks = chunkRendered(prep, { hardLimit: 150 });
    expect(chunks.length).toBeGreaterThanOrEqual(3);
    for (const c of chunks) {
      expect(c).toContain("n");
      expect(c).toContain("row");
      expect(c.length).toBeLessThanOrEqual(150);
    }
  });

  test("small tables that fit don't trigger chunking", () => {
    const prep = prepareForDelivery("| a | b |\n| - | - |\n| 1 | 2 |\n| 3 | 4 |");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startsWith("```")).toBe(true);
  });
});

describe("chunkRendered — code block chunking", () => {
  test("a single code block too big for one message splits at line boundaries with fence reopened on the same lang", () => {
    const codeLines = Array.from({ length: 30 }, (_, i) => `const variable_${i} = ${i};`);
    const raw = "```ts\n" + codeLines.join("\n") + "\n```";
    const prep = prepareForDelivery(raw);
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.startsWith("```ts")).toBe(true);
      expect(c.endsWith("```")).toBe(true);
      expect(c.length).toBeLessThanOrEqual(200);
    }
  });
});

describe("chunkRendered — text chunking", () => {
  test("a single huge paragraph splits at word boundaries", () => {
    const text = "word ".repeat(60).trim();
    const prep = prepareForDelivery(text);
    const chunks = chunkRendered(prep, { hardLimit: 100 });
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(100);
      // Should end on a complete word.
      expect(c.endsWith("word")).toBe(true);
    }
  });

  test("a paragraph with no word boundaries hard-cuts at hardLimit", () => {
    const text = "x".repeat(150);
    const prep = prepareForDelivery(text);
    const chunks = chunkRendered(prep, { hardLimit: 50 });
    expect(chunks.length).toBe(3);
    for (const c of chunks) {
      expect(c.length).toBeLessThanOrEqual(50);
    }
  });
});
