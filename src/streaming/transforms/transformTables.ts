/**
 * Convert GFM `table` nodes to fenced `code` blocks with ASCII alignment.
 *
 * Discord doesn't render markdown tables — the pipes show literally. The
 * agent writes standard GFM tables (the natural format for any LLM) and
 * we render them as monospace boxes inside a triple-backtick block, which
 * Discord renders correctly with column alignment intact.
 *
 * Long-prose cells are folded inside the table: when natural column
 * widths would push the total render past Discord's code-block render
 * width, we shrink the widest columns and word-wrap their content onto
 * multiple visual lines per row. The continuation lines keep column
 * alignment by leaving the other columns blank. Without this folding,
 * Discord's word-wrap would break the long cell out of its column and
 * push it to the left margin, destroying the table shape.
 *
 * Inline formatting inside cells is stripped: a code block doesn't
 * interpret markdown, so `**bold**` would show as literal asterisks. We
 * extract plain-text content from each cell.
 *
 * Alignment from the GFM separator row (`:--`, `:-:`, `--:`) maps to
 * left/center/right padding within each column.
 */
import type { Code, PhrasingContent, RootContent, Table } from "mdast";

type Align = "left" | "right" | "center" | null | undefined;

/**
 * Target total render width for the code block, in monospace columns.
 * Discord's fenced-code render width is roughly 75-80 chars on desktop
 * with the channel sidebar visible, narrower on mobile. 70 leaves margin
 * for both. Tables that fit naturally under this stay un-folded; ones
 * that exceed it get column-shrunk + word-wrapped.
 */
const targetTotalWidth = 64;
/** Minimum column width during shrink. Below this, content barely reads. */
const minColumnWidth = 4;
/** Width of the column separator string. ` │ ` = 3 chars. */
const separatorWidth = 3;
const columnSeparator = " │ ";
const separatorJoiner = "─┼─";

export function tableToCode(table: Table): Code {
  const rows = table.children.map((row) => row.children.map((cell) => cellToText(cell.children)));
  const align = table.align ?? [];

  if (rows.length === 0 || (rows[0]?.length ?? 0) === 0) {
    return makeEmptyCode(table);
  }

  const numCols = rows[0]!.length;
  const naturalWidths = computeNaturalWidths(rows, numCols);
  const widths = allocateColumnWidths(naturalWidths, numCols);

  const lines: string[] = [];
  const [header, ...body] = rows;
  if (header) {
    lines.push(...formatRow(header, widths, align));
    lines.push(formatSeparator(widths, align));
  }
  for (const row of body) {
    lines.push(...formatRow(row, widths, align));
  }

  return {
    type: "code",
    lang: null,
    meta: null,
    value: lines.join("\n"),
    position: table.position,
  };
}

function makeEmptyCode(table?: Table): Code {
  return {
    type: "code",
    lang: null,
    meta: null,
    value: "",
    position: table?.position,
  };
}

function cellToText(content: PhrasingContent[]): string {
  return content.map(phrasingToText).join("").trim();
}

function phrasingToText(node: PhrasingContent): string {
  switch (node.type) {
    case "text":
    case "inlineCode":
      return node.value;
    case "break":
      return " ";
    case "emphasis":
    case "strong":
    case "delete":
    case "link":
    case "linkReference":
      return node.children.map(phrasingToText).join("");
    case "image":
      return node.alt ?? "";
    case "imageReference":
      return node.alt ?? "";
    case "html":
      return "";
    case "footnoteReference":
      return "";
    default:
      return "";
  }
}

function computeNaturalWidths(rows: string[][], numCols: number): number[] {
  const widths: number[] = new Array(numCols).fill(0);
  for (const row of rows) {
    for (let i = 0; i < numCols; i++) {
      const cell = row[i] ?? "";
      // Natural width is the longest WORD in the cell, not the cell length.
      // We can wrap at word boundaries; the unbreakable unit is a word.
      // (For single-word cells, longest word == cell length.)
      const widest = longestWordWidth(cell);
      const fullWidth = cell.length;
      // Use the full cell length as natural — we'd ideally not wrap. But
      // floor at the longest word so shrink doesn't go below a width that
      // can't fit one word.
      widths[i] = Math.max(widths[i] ?? 0, fullWidth);
      // Track separately for the floor: longestWordWidth feeds the
      // shrink-floor below.
      void widest;
    }
  }
  // GFM separator row needs ≥ 3 chars per column to render meaningfully.
  return widths.map((w) => Math.max(w, 3));
}

function longestWordWidth(text: string): number {
  let max = 0;
  for (const word of text.split(/\s+/)) {
    if (word.length > max) max = word.length;
  }
  return max;
}

/**
 * Assign final column widths. If the natural widths fit under the target
 * total, return them as-is (no folding). Otherwise greedily shrink the
 * currently-widest column by 1 until the total fits, never going below
 * the floor (longest unbreakable word, or `minColumnWidth`, whichever is
 * larger). The widest-first heuristic preserves narrow columns intact —
 * only prose columns lose width.
 */
function allocateColumnWidths(naturals: number[], numCols: number): number[] {
  const budget = targetTotalWidth - separatorWidth * (numCols - 1);
  const widths = [...naturals];
  if (sum(widths) <= budget) return widths;

  // Floors keep us from shrinking a column to where its longest word
  // can't fit.
  const floors = widths.map((w) => Math.min(w, minColumnWidth));

  while (sum(widths) > budget) {
    let widestIdx = -1;
    let widestVal = -1;
    for (let i = 0; i < numCols; i++) {
      if (widths[i]! > floors[i]! && widths[i]! > widestVal) {
        widestVal = widths[i]!;
        widestIdx = i;
      }
    }
    if (widestIdx === -1) break; // every column at floor; can't shrink more
    widths[widestIdx] = (widths[widestIdx] ?? 0) - 1;
  }
  return widths;
}

function sum(values: number[]): number {
  let total = 0;
  for (const v of values) total += v;
  return total;
}

/**
 * Format a row, returning one or more visual lines. Cells whose content
 * exceeds their column width fold onto subsequent lines; continuation
 * lines have empty padding in unwrapped columns so column alignment is
 * preserved across the fold.
 */
function formatRow(cells: string[], widths: number[], align: Align[]): string[] {
  const wrapped = widths.map((w, i) => wrapCellLines(cells[i] ?? "", w));
  const visualRowCount = Math.max(1, ...wrapped.map((lines) => lines.length));
  const lines: string[] = [];
  for (let vr = 0; vr < visualRowCount; vr++) {
    const padded = widths.map((w, i) => {
      const text = wrapped[i]?.[vr] ?? "";
      return padCell(text, w, align[i]);
    });
    // Drop trailing whitespace — pad-on-the-right for the final column
    // serves no visual purpose (nothing follows it) and bloats every
    // line by the column's width.
    lines.push(padded.join(columnSeparator).replace(/[ \t]+$/, ""));
  }
  return lines;
}

function formatSeparator(widths: number[], align: Align[]): string {
  return widths.map((w, i) => separatorFor(w, align[i])).join(separatorJoiner);
}

function separatorFor(width: number, align: Align): string {
  // Match column width with hyphens, decorated by alignment markers so
  // the visual hint survives without depending on Discord's renderer.
  if (align === "center") {
    return `:${"─".repeat(Math.max(0, width - 2))}:`;
  }
  if (align === "right") {
    return `${"─".repeat(Math.max(0, width - 1))}:`;
  }
  if (align === "left") {
    return `:${"─".repeat(Math.max(0, width - 1))}`;
  }
  return "─".repeat(width);
}

function padCell(text: string, width: number, align: Align): string {
  if (text.length >= width) return text;
  const pad = width - text.length;
  if (align === "right") return " ".repeat(pad) + text;
  if (align === "center") {
    const left = Math.floor(pad / 2);
    const right = pad - left;
    return " ".repeat(left) + text + " ".repeat(right);
  }
  return text + " ".repeat(pad);
}

/**
 * Word-wrap `text` to a series of lines each ≤ `width` chars. Wraps at
 * whitespace; words longer than `width` get hard-cut so a runaway URL or
 * identifier doesn't break the column shape.
 */
function wrapCellLines(text: string, width: number): string[] {
  if (text.length === 0) return [""];
  if (text.length <= width) return [text];
  const lines: string[] = [];
  let current = "";
  const words = text.split(/\s+/);
  for (let word of words) {
    if (word.length === 0) continue;
    // Hard-cut very long words to avoid breaking out of the column.
    while (word.length > width) {
      if (current.length > 0) {
        lines.push(current);
        current = "";
      }
      lines.push(word.slice(0, width));
      word = word.slice(width);
    }
    if (current.length === 0) {
      current = word;
    } else if (current.length + 1 + word.length <= width) {
      current = `${current} ${word}`;
    } else {
      lines.push(current);
      current = word;
    }
  }
  if (current.length > 0) lines.push(current);
  return lines;
}

/**
 * In-place visitor: replace every Table at any depth in the tree with
 * the corresponding Code block. Returns the mutated nodes array.
 */
export function transformTables(children: RootContent[]): RootContent[] {
  return children.map((child) => {
    if (child.type === "table") return tableToCode(child) as RootContent;
    return child;
  });
}
