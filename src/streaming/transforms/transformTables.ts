/**
 * Convert GFM `table` nodes to fenced `code` blocks with ASCII alignment.
 *
 * Discord doesn't render markdown tables — the pipes show literally. The
 * agent writes standard GFM tables (the natural format for any LLM) and
 * we render them as monospace boxes inside a triple-backtick block, which
 * Discord *does* render correctly with column alignment intact.
 *
 * Inline formatting inside cells is stripped: a code block doesn't
 * interpret markdown, so `**bold**` would show as literal asterisks. We
 * extract plain-text content from each cell and pad with spaces.
 *
 * Alignment from the GFM separator row (`:--`, `:-:`, `--:`) maps to
 * left/center/right padding within each column.
 */
import type { Code, PhrasingContent, RootContent, Table } from "mdast";

type Align = "left" | "right" | "center" | null | undefined;

export function tableToCode(table: Table): Code {
  const rows = table.children.map((row) => row.children.map((cell) => cellToText(cell.children)));
  const align = table.align ?? [];
  const widths = computeColumnWidths(rows);
  const lines: string[] = [];

  if (rows.length === 0) {
    return makeEmptyCode(table);
  }

  const [header, ...body] = rows;
  if (header) {
    lines.push(formatRow(header, widths, align));
    lines.push(formatSeparator(widths, align));
  }
  for (const row of body) {
    lines.push(formatRow(row, widths, align));
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

function computeColumnWidths(rows: string[][]): number[] {
  const widths: number[] = [];
  for (const row of rows) {
    for (let i = 0; i < row.length; i++) {
      const cell = row[i] ?? "";
      const len = cell.length;
      widths[i] = Math.max(widths[i] ?? 0, len);
    }
  }
  // GFM separator row needs at least 3 chars per column to render a valid
  // separator (`---`, `:--`, etc.). Match that floor here.
  return widths.map((w) => Math.max(w, 3));
}

function formatRow(cells: string[], widths: number[], align: Align[]): string {
  const padded = widths.map((w, i) => padCell(cells[i] ?? "", w, align[i]));
  return padded.join(" │ ");
}

function formatSeparator(widths: number[], align: Align[]): string {
  return widths.map((w, i) => separatorFor(w, align[i])).join("─┼─");
}

function separatorFor(width: number, align: Align): string {
  // Match the column data-width with hyphens, decorated by alignment markers
  // so the visual hint survives without depending on Discord's renderer.
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
 * In-place visitor: replace every Table at any depth in the tree with the
 * corresponding Code block. Returns the mutated nodes array.
 */
export function transformTables(children: RootContent[]): RootContent[] {
  return children.map((child) => {
    if (child.type === "table") return tableToCode(child) as RootContent;
    return child;
  });
}
