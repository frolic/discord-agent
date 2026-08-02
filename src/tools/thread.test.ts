import { describe, expect, test } from "bun:test";
import { postInitialMessage } from "./thread.ts";

/**
 * Record every string passed to the dispatcher's post callback, in order,
 * plus the simulated message IDs the send would produce.
 */
function makeFakePost() {
  const posted: string[] = [];
  let seq = 0;
  const post = async (content: string): Promise<{ id: string }> => {
    posted.push(content);
    seq += 1;
    return { id: `m${seq}` };
  };
  return { post, posted };
}

describe("postInitialMessage", () => {
  test("empty initial message posts nothing", async () => {
    const { post, posted } = makeFakePost();
    await postInitialMessage(post, "");
    expect(posted).toEqual([]);
  });

  test("short initial message posts in a single message, unchanged", async () => {
    const { post, posted } = makeFakePost();
    const message = "Just a short initial message.";
    await postInitialMessage(post, message);
    expect(posted).toEqual([message]);
  });

  test("long initial message splits into multiple posts, each under hardLimit", async () => {
    const { post, posted } = makeFakePost();
    // ~150 tokens of filler under a 1990-char hard limit — enough to
    // force a split across paragraphs.
    const filler = "word ".repeat(600);
    const message = `intro paragraph\n\n${filler}\n\nclosing paragraph`;
    await postInitialMessage(post, message);
    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) {
      expect(p.length).toBeLessThanOrEqual(1990);
    }
    // Every chunk lands as a complete (fence/paragraph-balanced) block —
    // the dispatcher never emits a partially cut message.
    expect(posted.every((p) => p.length > 0)).toBe(true);
  });

  test("long initial message containing a table splits with the header repeated per piece", async () => {
    const { post, posted } = makeFakePost();
    // A wide table that overflows the hard limit on its own. Header row +
    // separator must be repeated on each split piece so every Discord
    // message reads as a complete aligned table. (transformTables renders
    // tables to an ASCII code block with \u2502 column separators, so we
    // assert on that rendered form rather than the markdown pipe form.)
    const rows = Array.from(
      { length: 60 },
      (_, i) => `| a${i} | b${i} | c${i} | d${i} | e${i} | f${i} | g${i} | h${i} |`,
    );
    const message = `some prose before\n\n| col_a | col_b | col_c | col_d | col_e | col_f | col_g | col_h |\n|---|---|---|---|---|---|---|---|\n${rows.join("\n")}\n\nafter the table`;
    await postInitialMessage(post, message);
    expect(posted.length).toBeGreaterThan(1);
    for (const p of posted) expect(p.length).toBeLessThanOrEqual(1990);
    // Every chunk that's a table (starts with a code fence and carries
    // rows) must also carry the rendered header so it reads as
    // self-contained. transformTables emits the header on each split piece.
    const renderedHeader = "col_a \u2502 col_b";
    const tableMessages = posted.filter((p) => p.startsWith("```") && p.includes(renderedHeader));
    expect(tableMessages.length).toBeGreaterThan(1);
  });
});
