/**
 * Split a `PreparedDelivery` into one Discord message's worth of rendered
 * text per chunk, respecting markdown structure.
 *
 * The dispatcher accumulates the full stream source from the start of a
 * stream (never sliced). On each flush it re-parses everything via
 * `prepareForDelivery` and runs this chunker over the result. Discord
 * messages are derived from chunks: the first chunk goes to message 1,
 * the second to message 2, etc. Sealed messages stabilize naturally —
 * once content past a chunk boundary stops shifting, that chunk's text
 * stops changing and the dispatcher's "skip if unchanged" check avoids
 * a redundant edit.
 *
 * Chunking rules, in priority order:
 *
 *   1. **Heading-led chunks**: when a heading-like block (a real ATX
 *      heading, or a `**Bold:**`-only-line pseudo-heading) appears,
 *      finalize the current chunk first so the heading leads its own
 *      Discord message. Models structure long replies by section.
 *
 *   2. **Pack greedily within hardLimit**: keep adding blocks to the
 *      current chunk while they fit. As soon as the next block would
 *      push past hardLimit, finalize and start a new chunk with that
 *      block.
 *
 *   3. **Block-too-big handling**: when one block alone exceeds
 *      hardLimit:
 *        - **Tables** (Code nodes carrying `data.harnessTable`) split
 *          at logical row boundaries; the rendered ASCII header + sep
 *          is repeated on each piece so every Discord message reads as
 *          a complete aligned table.
 *        - **Plain code blocks** split at line boundaries with the
 *          fence closed and reopened on the same language.
 *        - **Paragraphs / lists / blockquotes** split at the latest
 *          word boundary in the rendered text.
 *
 * Inter-block separator follows `prep.rendered` — `\n` for code-adjacent
 * transitions, `\n\n` elsewhere — which is already in `prep.rendered`'s
 * substring offsets, so we just slice between block boundaries and trim
 * leading/trailing whitespace per chunk.
 */
import type { Code, RootContent } from "mdast";
import type { PreparedDelivery } from "./prepareForDelivery.ts";
import type { HarnessTableData } from "./transforms/transformTables.ts";

export interface ChunkOptions {
  /** Absolute per-message render-character cap. Discord's is 2000; production passes ~1990 to leave margin. */
  hardLimit: number;
}

/**
 * Returns one rendered string per Discord message. Each is ≤ hardLimit
 * chars and is valid markdown that Discord can render directly.
 */
export function chunkRendered(prep: PreparedDelivery, options: ChunkOptions): string[] {
  const { hardLimit } = options;
  if (prep.rendered.length === 0) return [];
  if (prep.blocks.length === 0) return [];

  const chunks: string[] = [];
  // Accumulate rendered text for the in-progress chunk. Mutated as we
  // add blocks; flushed to `chunks` when full or at heading boundaries.
  let current = "";
  // Type of the most recent block in `current` (for separator picking).
  let prevBlock: RootContent | null = null;

  function commit(): void {
    const trimmed = current.replace(/[ \t\n]+$/, "");
    if (trimmed.length > 0) chunks.push(trimmed);
    current = "";
    prevBlock = null;
  }

  for (let i = 0; i < prep.blocks.length; i++) {
    const block = prep.blocks[i]!;
    const blockText = prep.rendered.slice(block.renderedStart, block.renderedEnd);

    // Heading-led chunks: a heading-like block always starts its own
    // Discord message (when there's content already accumulated to
    // finalize). Models treat headings as section breaks; sealing on
    // those reads naturally.
    if (current.length > 0 && isHeadingLike(block.node)) {
      commit();
    }

    const sep = current.length > 0 ? separatorBetween(prevBlock!, block.node) : "";
    const candidate = current + sep + blockText;

    if (candidate.length <= hardLimit) {
      current = candidate;
      prevBlock = block.node;
      continue;
    }

    // Doesn't fit. Finalize current first, then handle this block.
    commit();

    if (blockText.length <= hardLimit) {
      current = blockText;
      prevBlock = block.node;
      continue;
    }

    // Block alone is too big. Split it across multiple chunks.
    const blockChunks = splitOversizedBlock(block.node, blockText, hardLimit);
    // First N-1 chunks go straight to output; last becomes the new
    // current so subsequent blocks can append to it if they fit.
    for (let j = 0; j < blockChunks.length - 1; j++) {
      const c = blockChunks[j]!.replace(/[ \t\n]+$/, "");
      if (c.length > 0) chunks.push(c);
    }
    current = blockChunks[blockChunks.length - 1] ?? "";
    prevBlock = block.node;
  }

  commit();
  return chunks;
}

/**
 * Split a single block whose own rendered text exceeds hardLimit.
 * Picks the right sub-strategy based on block type.
 */
function splitOversizedBlock(
  node: RootContent,
  blockText: string,
  hardLimit: number,
): string[] {
  if (node.type === "code") {
    const tableData = (node as Code & { data?: { harnessTable?: HarnessTableData } }).data
      ?.harnessTable;
    if (tableData) return chunkTable(tableData, hardLimit);
    return chunkCodeBlock(blockText, node.lang ?? null, hardLimit);
  }
  return chunkText(blockText, hardLimit);
}

/**
 * Chunk a transformed-table Code node at logical row boundaries,
 * repeating the header on each piece. Each piece is a complete fenced
 * code block.
 */
function chunkTable(data: HarnessTableData, hardLimit: number): string[] {
  const { headerLines, bodyRowLines } = data;
  const fenceOpen = "```\n";
  const fenceClose = "\n```";
  const header = headerLines.join("\n");
  // Length of an empty chunk: fenceOpen + header + "\n" + fenceClose.
  // When we add a row, we add "\n" + rowLines.join("\n").
  const emptyChunkLen = fenceOpen.length + header.length + fenceClose.length;

  const chunks: string[] = [];
  let currentRows: string[][] = [];
  let currentLen = emptyChunkLen;

  for (const rowLines of bodyRowLines) {
    const rowText = rowLines.join("\n");
    const addLen = rowText.length + 1; // +1 for the newline before the row
    if (currentLen + addLen > hardLimit && currentRows.length > 0) {
      chunks.push(buildTableChunk(fenceOpen, header, fenceClose, currentRows));
      currentRows = [];
      currentLen = emptyChunkLen;
    }
    currentRows.push(rowLines);
    currentLen += addLen;
  }
  if (currentRows.length > 0) {
    chunks.push(buildTableChunk(fenceOpen, header, fenceClose, currentRows));
  }
  return chunks;
}

function buildTableChunk(
  fenceOpen: string,
  header: string,
  fenceClose: string,
  rows: string[][],
): string {
  const body = rows.map((rowLines) => rowLines.join("\n")).join("\n");
  return `${fenceOpen}${header}\n${body}${fenceClose}`;
}

/**
 * Chunk a plain (non-table) code block at line boundaries. Each chunk
 * is a fully-fenced code block in the same language.
 */
function chunkCodeBlock(blockText: string, lang: string | null, hardLimit: number): string[] {
  // blockText is the full fenced code (including its own ``` lines).
  // Strip the outer fence to get just the body, then re-fence per chunk.
  const langTag = lang ?? "";
  const fenceOpen = `\`\`\`${langTag}\n`;
  const fenceClose = "\n```";
  const body = stripFenceWrapper(blockText);
  const lines = body.split("\n");

  const chunks: string[] = [];
  const emptyLen = fenceOpen.length + fenceClose.length;
  let currentLines: string[] = [];
  let currentLen = emptyLen;
  for (const line of lines) {
    const addLen = line.length + (currentLines.length === 0 ? 0 : 1);
    if (currentLen + addLen > hardLimit && currentLines.length > 0) {
      chunks.push(`${fenceOpen}${currentLines.join("\n")}${fenceClose}`);
      currentLines = [];
      currentLen = emptyLen;
    }
    currentLines.push(line);
    currentLen += line.length + 1;
  }
  if (currentLines.length > 0) {
    chunks.push(`${fenceOpen}${currentLines.join("\n")}${fenceClose}`);
  }
  return chunks;
}

function stripFenceWrapper(blockText: string): string {
  // Strip the first line (open fence) and last line (close fence).
  const firstNl = blockText.indexOf("\n");
  const lastNl = blockText.lastIndexOf("\n");
  if (firstNl < 0 || lastNl <= firstNl) return blockText;
  return blockText.slice(firstNl + 1, lastNl);
}

/**
 * Chunk a paragraph / list / blockquote at word boundaries. Each chunk
 * is ≤ hardLimit; cuts land at whitespace where possible.
 */
function chunkText(blockText: string, hardLimit: number): string[] {
  if (blockText.length <= hardLimit) return [blockText];
  const chunks: string[] = [];
  let cursor = 0;
  while (cursor < blockText.length) {
    const remaining = blockText.length - cursor;
    if (remaining <= hardLimit) {
      chunks.push(blockText.slice(cursor));
      break;
    }
    // Find latest whitespace at or before cursor + hardLimit
    let cut = cursor + hardLimit;
    while (cut > cursor && !isWhitespace(blockText[cut - 1] ?? "")) {
      cut--;
    }
    if (cut === cursor) {
      // No whitespace found — hard cut at hardLimit.
      cut = cursor + hardLimit;
    }
    chunks.push(blockText.slice(cursor, cut).replace(/[ \t\n]+$/, ""));
    // Skip leading whitespace on the next chunk.
    while (cut < blockText.length && isWhitespace(blockText[cut] ?? "")) cut++;
    cursor = cut;
  }
  return chunks;
}

function isWhitespace(ch: string): boolean {
  return ch === " " || ch === "\t" || ch === "\n";
}

/**
 * A node the model is using as a section break. Both proper headings
 * (`## Title`) and a paragraph that's just bold text (`**Title**` on
 * its own line) qualify — the latter is a common LLM substitute when
 * the model wants section-break semantics without full heading weight.
 */
function isHeadingLike(node: RootContent): boolean {
  if (node.type === "heading") return true;
  if (
    node.type === "paragraph" &&
    node.children.length === 1 &&
    node.children[0]?.type === "strong"
  ) {
    return true;
  }
  return false;
}

/**
 * Inter-block separator. Mirrors `prepareForDelivery.separatorBetween`
 * since we re-pick separators for chunks (we don't blindly slice
 * separator chars from `prep.rendered` — they're between blocks but a
 * chunk boundary may fall there). Code-adjacent transitions get a
 * single newline (the code block's own padding handles visual gap);
 * everything else gets a blank line.
 */
function separatorBetween(prev: RootContent, next: RootContent): string {
  if (prev.type === "code" || next.type === "code") return "\n";
  return "\n\n";
}
