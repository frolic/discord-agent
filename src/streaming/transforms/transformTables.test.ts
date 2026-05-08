import { describe, expect, test } from "bun:test";
import type { Table } from "mdast";
import { tableToCode, transformTables } from "./transformTables.ts";

/**
 * Build a minimal Table node for testing. Skips position info; tests that
 * care about offset propagation construct their own with a position.
 */
function table(rows: string[][], align: Array<"left" | "right" | "center" | null> = []): Table {
  return {
    type: "table",
    align,
    children: rows.map((row) => ({
      type: "tableRow",
      children: row.map((cell) => ({
        type: "tableCell",
        children: [{ type: "text", value: cell }],
      })),
    })),
  };
}

describe("tableToCode — basic rendering", () => {
  test("simple table renders as a code block with column separators", () => {
    const code = tableToCode(table([["a", "b"], ["1", "2"]]));
    expect(code.type).toBe("code");
    expect(code.lang).toBeNull();
    expect(code.value.split("\n")).toEqual([
      "a   │ b",
      "────┼────",
      "1   │ 2",
    ]);
  });

  test("min column width of 3 is enforced (so the separator row reads as `---`)", () => {
    const code = tableToCode(table([["x", "y"], ["1", "2"]]));
    const headerLine = code.value.split("\n")[0]!;
    // Each column should be padded to at least 3 chars.
    expect(headerLine.startsWith("x   ")).toBe(true);
  });

  test("preserves position info from the original Table", () => {
    const t: Table = {
      type: "table",
      align: [],
      children: [
        { type: "tableRow", children: [{ type: "tableCell", children: [{ type: "text", value: "a" }] }] },
      ],
      position: {
        start: { line: 1, column: 1, offset: 10 },
        end: { line: 1, column: 5, offset: 25 },
      },
    };
    const code = tableToCode(t);
    expect(code.position?.start.offset).toBe(10);
    expect(code.position?.end.offset).toBe(25);
  });

  test("empty table → empty code block (still carries position)", () => {
    const t: Table = { type: "table", align: [], children: [] };
    const code = tableToCode(t);
    expect(code.value).toBe("");
  });
});

describe("tableToCode — alignment markers in separator row", () => {
  test("left alignment puts `:` on the left of the separator", () => {
    const code = tableToCode(table([["a", "b"], ["1", "2"]], ["left", null]));
    const sepLine = code.value.split("\n")[1]!;
    // First column's separator chunk should start with `:`.
    expect(sepLine.startsWith(":")).toBe(true);
  });

  test("right alignment puts `:` on the right of the separator", () => {
    const code = tableToCode(table([["a", "b"], ["1", "2"]], [null, "right"]));
    const sepLine = code.value.split("\n")[1]!;
    // Second column's separator chunk should end with `:`.
    expect(sepLine.endsWith(":")).toBe(true);
  });

  test("center alignment puts `:` on both sides", () => {
    const code = tableToCode(table([["xxx", "yyy"], ["1", "2"]], ["center", null]));
    const sepLine = code.value.split("\n")[1]!;
    // First column has center markers.
    const firstSep = sepLine.split("─┼─")[0]!;
    expect(firstSep.startsWith(":")).toBe(true);
    expect(firstSep.endsWith(":")).toBe(true);
  });
});

describe("tableToCode — cell padding by alignment", () => {
  test("default (no align) is left-aligned: trailing spaces", () => {
    const code = tableToCode(table([["abc", "y"], ["1", "2"]]));
    const dataLine = code.value.split("\n")[2]!;
    expect(dataLine.startsWith("1  ")).toBe(true);
  });

  test("right alignment puts spaces on the left of the cell", () => {
    const code = tableToCode(table([["aaa", "y"], ["1", "2"]], ["right", null]));
    const dataLine = code.value.split("\n")[2]!;
    expect(dataLine.startsWith("  1")).toBe(true);
  });

  test("center alignment splits the padding", () => {
    const code = tableToCode(table([["xxxxx", "y"], ["1", "2"]], ["center", null]));
    const dataLine = code.value.split("\n")[2]!;
    // " 1   " — 2 spaces left, 2 right (or 1+3 with floor).
    expect(dataLine.startsWith("  1")).toBe(true);
  });
});

describe("tableToCode — width allocation and folding", () => {
  test("naturally narrow tables aren't folded (no continuation lines)", () => {
    const code = tableToCode(table([["a", "b", "c"], ["1", "2", "3"], ["4", "5", "6"]]));
    const lines = code.value.split("\n");
    // 3 lines: header + separator + 2 body rows. No folding.
    expect(lines.length).toBe(4);
  });

  test("a long-prose cell folds onto multiple lines, with empty other-column padding on continuations", () => {
    const longProse = "this is a long-prose cell that should fold across multiple lines";
    const code = tableToCode(table([["Name", "Description"], ["Alpha", longProse]]));
    const lines = code.value.split("\n");
    // Expect a continuation line: starts with whitespace under the Name
    // column, then the column separator, then more prose.
    const continuationLine = lines.find((l) => /^\s+│ /.test(l));
    expect(continuationLine).toBeDefined();
  });

  test("total render width is capped at the target (64)", () => {
    const longProse = "x".repeat(120); // way past target
    const code = tableToCode(table([["Name", "Description"], ["Alpha", longProse]]));
    const lines = code.value.split("\n");
    for (const line of lines) {
      // Allow 1 char of slop for separator-string variations.
      expect(line.length).toBeLessThanOrEqual(65);
    }
  });

  test("an unbreakable word longer than the target is hard-cut so it doesn't blow the column", () => {
    const longWord = "x".repeat(100);
    const code = tableToCode(table([["a", "b"], ["1", longWord]]));
    const lines = code.value.split("\n");
    // No single line should exceed the target by much.
    for (const line of lines) {
      expect(line.length).toBeLessThanOrEqual(65);
    }
  });
});

describe("tableToCode — cell text extraction", () => {
  test("strips inline formatting inside cells (code block doesn't interpret markdown)", () => {
    const t: Table = {
      type: "table",
      align: [],
      children: [
        {
          type: "tableRow",
          children: [
            {
              type: "tableCell",
              children: [
                { type: "text", value: "before " },
                {
                  type: "strong",
                  children: [{ type: "text", value: "bold" }],
                },
                { type: "text", value: " after" },
              ],
            },
          ],
        },
      ],
    };
    const code = tableToCode(t);
    expect(code.value).toContain("before bold after");
    expect(code.value).not.toContain("**");
  });

  test("inlineCode in cells contributes its raw text", () => {
    const t: Table = {
      type: "table",
      align: [],
      children: [
        {
          type: "tableRow",
          children: [
            {
              type: "tableCell",
              children: [{ type: "inlineCode", value: "foo()" }],
            },
          ],
        },
      ],
    };
    const code = tableToCode(t);
    expect(code.value).toContain("foo()");
  });
});

describe("transformTables visitor", () => {
  test("replaces every Table in a children array with a Code", () => {
    const t1 = table([["a"]]);
    const t2 = table([["b"]]);
    const para = { type: "paragraph" as const, children: [{ type: "text" as const, value: "x" }] };
    const result = transformTables([t1, para, t2]);
    expect(result[0]!.type).toBe("code");
    expect(result[1]!.type).toBe("paragraph"); // untouched
    expect(result[2]!.type).toBe("code");
  });
});
