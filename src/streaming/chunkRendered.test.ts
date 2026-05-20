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

describe("chunkRendered — heading-led chunks", () => {
  test("heading starts a new chunk even when the previous chunk has room", () => {
    const prep = prepareForDelivery("intro paragraph\n\n## Section\n\nbody");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    // Even though everything fits comfortably in one chunk, the heading
    // gets its own message.
    expect(chunks.length).toBeGreaterThanOrEqual(2);
    expect(chunks[0]).toBe("intro paragraph");
    expect(chunks[1]!.startsWith("## Section")).toBe(true);
  });

  test("bold-only-line acts as a heading boundary", () => {
    const prep = prepareForDelivery("intro\n\n**Section title**\n\nbody");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks[0]).toBe("intro");
    expect(chunks[1]!.startsWith("**Section title**")).toBe(true);
  });

  test("first block being heading-like doesn't trigger an empty chunk", () => {
    const prep = prepareForDelivery("## Section\n\nbody");
    const chunks = chunkRendered(prep, { hardLimit: 200 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]!.startsWith("## Section")).toBe(true);
  });

  test("trailing heading-like block does NOT split (regression: streaming orphan)", () => {
    // Mid-stream snapshot: the model has emitted "Para.\n\n**Skill file**"
    // and is about to continue " at `path` — more content" on the next
    // delta. At THIS moment the bold-only paragraph parses as
    // heading-like, but if we split now we'd post a Discord message
    // containing just "**Skill file**" — and once the next delta makes
    // the paragraph multi-child (and no longer heading-like), re-chunking
    // produces ONE chunk but messages.length is already 2 → orphaned
    // standalone "**Skill file**" message stuck in Discord. Defer the
    // split decision until the heading has a block after it.
    const prep = prepareForDelivery("Done. Here's the summary:\n\n**Skill file**");
    const chunks = chunkRendered(prep, { hardLimit: 1990 });
    expect(chunks).toHaveLength(1);
    expect(chunks[0]).toBe("Done. Here's the summary:\n\n**Skill file**");
  });

  test("heading-like block in the middle still splits (rule still works when complete)", () => {
    // Once the heading is followed by content, the split fires correctly:
    // the trailing-block deferral was specifically about in-flight
    // streaming, not about disabling the rule.
    const prep = prepareForDelivery(
      "Done. Here's the summary:\n\n**Skill file** at `path` — documents the flow.\n\nMore content after.",
    );
    const chunks = chunkRendered(prep, { hardLimit: 1990 });
    // First paragraph "**Skill file** at ..." is no longer heading-like
    // (multi-child); whole thing packs as one chunk.
    expect(chunks).toHaveLength(1);
  });

  test("heading mid-stream then completed: chunk count is monotonic", () => {
    // Simulate the streaming sequence that caused the original bug:
    // before the fix, the mid-stream snapshot would yield 2 chunks and
    // the completed snapshot would yield 1 — leaving the second
    // message orphaned. After the fix, both snapshots yield 1 chunk.
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
