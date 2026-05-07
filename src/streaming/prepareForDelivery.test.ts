import { describe, expect, test } from "bun:test";
import { prepareForDelivery } from "./prepareForDelivery.ts";

describe("prepareForDelivery — basic shape", () => {
  test("empty input → empty result", () => {
    const result = prepareForDelivery("");
    expect(result.rendered).toBe("");
    expect(result.blocks).toEqual([]);
  });

  test("plain paragraph passes through", () => {
    const result = prepareForDelivery("just a paragraph");
    expect(result.rendered).toBe("just a paragraph");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.node.type).toBe("paragraph");
  });

  test("two paragraphs become two blocks separated by a blank line", () => {
    const result = prepareForDelivery("first\n\nsecond");
    expect(result.blocks).toHaveLength(2);
    expect(result.rendered).toBe("first\n\nsecond");
  });
});

describe("prepareForDelivery — table → ASCII code block", () => {
  test("simple table renders as code block", () => {
    const result = prepareForDelivery("| a | b |\n| - | - |\n| 1 | 2 |");
    expect(result.blocks).toHaveLength(1);
    expect(result.blocks[0]!.node.type).toBe("code");
    expect(result.rendered.startsWith("```")).toBe(true);
    expect(result.rendered.endsWith("```")).toBe(true);
    // Headers and data both appear with column padding.
    expect(result.rendered).toContain("a");
    expect(result.rendered).toContain("b");
    expect(result.rendered).toContain("1");
    expect(result.rendered).toContain("2");
  });

  test("table with alignment renders aligned cells", () => {
    const result = prepareForDelivery("| left | center | right |\n| :-- | :-: | --: |\n| a | b | c |");
    // We don't assert exact spacing — just that the block is a code
    // block with the right cell content. Visual alignment is exercised
    // in the smoke test.
    expect(result.blocks[0]!.node.type).toBe("code");
    expect(result.rendered).toContain("left");
    expect(result.rendered).toContain("center");
    expect(result.rendered).toContain("right");
  });

  test("table preserves position info from original raw source", () => {
    const result = prepareForDelivery("intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nouter");
    const tableBlock = result.blocks.find((b) => b.node.type === "code");
    expect(tableBlock).toBeDefined();
    // rawStart should land near "| a" in the original source, not 0.
    expect(tableBlock!.rawStart).toBeGreaterThanOrEqual(7);
    expect(tableBlock!.rawEnd).toBeLessThanOrEqual(40);
  });

  test("table cells with inline formatting strip the formatting in the ASCII version", () => {
    const result = prepareForDelivery("| **bold** | *italic* |\n| - | - |\n| 1 | 2 |");
    // The code-block content should NOT contain `**` or `*` markers.
    expect(result.rendered).not.toContain("**bold**");
    expect(result.rendered).toContain("bold");
    expect(result.rendered).toContain("italic");
  });

  test("wide tables fold long-prose cells onto multiple lines, preserving column alignment", () => {
    const result = prepareForDelivery(
      "| Name | Description |\n" +
        "| --- | --- |\n" +
        "| Alpha | This is a long description of the alpha thing that goes on and on |\n" +
        "| Beta | Another long description that should fold |",
    );
    // Look for the leading-blank continuation pattern: a row that starts
    // with the column-1 width worth of spaces followed by ` │ `. That's
    // how we render a wrapped continuation line.
    const lines = result.rendered.split("\n");
    const continuationLine = lines.find((l) => /^ {2,}│ /.test(l));
    expect(continuationLine).toBeDefined();
  });

  test("folded table stays within the target render width on every line", () => {
    const result = prepareForDelivery(
      "| Domain | Price | Vibe |\n" +
        "| --- | --- | --- |\n" +
        "| spacepollux.com | $14 | Perfect — sounds like a retro homepage, space/computer kid energy |\n" +
        "| polluxcity.com | $14 | \"Welcome to Pollux City\" — very geocities neighborhood energy |",
    );
    const lines = result.rendered.split("\n").filter((l) => !l.startsWith("```"));
    for (const line of lines) {
      // Target is 64 chars; allow 1 char of slop for separator-string tweaks.
      expect(line.length).toBeLessThanOrEqual(65);
    }
  });

  test("naturally narrow tables don't get folded when they fit", () => {
    const result = prepareForDelivery("| a | b | c |\n| - | - | - |\n| 1 | 2 | 3 |\n| 4 | 5 | 6 |");
    // No row should have a leading-blank continuation pattern.
    const lines = result.rendered.split("\n");
    const continuationLine = lines.find((l) => /^ {2,}│ /.test(l));
    expect(continuationLine).toBeUndefined();
  });

  test("rows have no trailing whitespace", () => {
    const result = prepareForDelivery(
      "| Domain | Vibe |\n| --- | --- |\n| short.com | A long enough description to force folding behavior to kick in |",
    );
    const lines = result.rendered.split("\n");
    for (const line of lines) {
      expect(line).toBe(line.trimEnd());
    }
  });
});

describe("prepareForDelivery — task lists", () => {
  test("checked task gets ☑ prefix; unchecked gets ☐", () => {
    const result = prepareForDelivery("- [x] done\n- [ ] todo");
    expect(result.rendered).toContain("☑");
    expect(result.rendered).toContain("☐");
    expect(result.rendered).not.toContain("[x]");
    expect(result.rendered).not.toContain("[ ]");
  });
});

describe("prepareForDelivery — images and HTML", () => {
  test("inline image becomes masked link", () => {
    const result = prepareForDelivery("see ![cat](https://example.com/cat.png) here");
    expect(result.rendered).toContain("[cat](https://example.com/cat.png)");
    expect(result.rendered).not.toContain("![cat]");
  });

  test("raw HTML is dropped", () => {
    const result = prepareForDelivery("Use <b>bold</b> there.");
    expect(result.rendered).not.toContain("<b>");
    expect(result.rendered).not.toContain("</b>");
    expect(result.rendered).toContain("bold");
  });
});

describe("prepareForDelivery — partial input (mid-stream)", () => {
  test("mid-bold gets closed by remend", () => {
    const result = prepareForDelivery("Some **bold tex");
    // After remend the bold mark should be closed somewhere in the
    // rendered output; either fully closed or escaped to literal `*`s.
    // Either way, the user shouldn't see `**bold tex` literally.
    expect(result.rendered).not.toMatch(/\*\*bold tex$/);
  });

  test("unclosed code fence parses as a code block spanning to EOF", () => {
    const result = prepareForDelivery("Here:\n\n```ts\nconst x = 1");
    expect(result.blocks).toHaveLength(2);
    expect(result.blocks[0]!.node.type).toBe("paragraph");
    expect(result.blocks[1]!.node.type).toBe("code");
  });

  test("partial table parses as one block (so seam-finding can roll back to before it)", () => {
    const result = prepareForDelivery("| a | b |\n| - | - |\n| 1");
    // Whatever the parser does with the half row, the result should be
    // exactly one block (the partial table) so the dispatcher's rollback
    // logic targets the right boundary.
    expect(result.blocks).toHaveLength(1);
  });
});

describe("prepareForDelivery — raw → rendered offset mapping", () => {
  test("blocks past a transformed table still have correct raw offsets", () => {
    const raw = "intro\n\n| a | b |\n| - | - |\n| 1 | 2 |\n\nouter";
    const result = prepareForDelivery(raw);
    const outerBlock = result.blocks[result.blocks.length - 1]!;
    expect(outerBlock.node.type).toBe("paragraph");
    // The "outer" paragraph in raw starts after the table. Verify the
    // raw position is near end-of-string, not somewhere in the middle.
    expect(raw.slice(outerBlock.rawStart, outerBlock.rawEnd).includes("outer")).toBe(true);
  });
});
