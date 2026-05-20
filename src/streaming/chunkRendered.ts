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
 *   1. **Size-driven packing**: keep adding top-level blocks to the
 *      current chunk while they fit. The trigger for splitting is
 *      *always* hardLimit overflow — never structure. Short replies
 *      stay as one message regardless of how many headings they
 *      contain; inline rendering of bold/heading already shows section
 *      structure within a single message.
 *
 *   2. **Heading-keep on split**: when a block doesn't fit and we have
 *      to start a new chunk, lift any trailing heading-like blocks off
 *      the about-to-commit chunk and carry them into the next chunk
 *      with the new block. A heading at the end of message N with its
 *      body at the start of message N+1 reads worse than the heading
 *      sitting with its body in message N+1. We stop lifting if doing
 *      so would empty the current chunk, or if the carried heading +
 *      new block would itself overflow.
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
 * The chunk count is monotonic non-decreasing across re-flushes by
 * construction: the only way to add a chunk is overflow on a block
 * that wasn't there last flush. No proactive structural split mechanism
 * exists, so transient mid-stream parse states (a `**Bold**` paragraph
 * that hasn't completed its line yet) can't cause a chunk-count
 * regression that would orphan a previously-posted Discord message.
 *
 * Inter-block separator handling: when consecutive blocks land in the
 * same chunk, we slice `prep.rendered` directly — that string already
 * has the right separator (`\n` for code-adjacent, `\n\n` elsewhere)
 * because `prepareForDelivery` placed it. The chunker doesn't re-pick
 * separators; the source of truth is the rendered string itself.
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
  // The current chunk is a contiguous range of block indices. Slicing
  // prep.rendered from the first block's renderedStart to the last
  // block's renderedEnd gives the chunk text — including the
  // inter-block separators that prepareForDelivery already placed.
  // Tracking as an index array (rather than offset pointers) makes
  // "pop trailing headings" trivial.
  let runIndices: number[] = [];

  function commitRun(): void {
    if (runIndices.length === 0) return;
    const first = prep.blocks[runIndices[0]!]!;
    const last = prep.blocks[runIndices[runIndices.length - 1]!]!;
    const text = prep.rendered.slice(first.renderedStart, last.renderedEnd).replace(/[ \t\n]+$/, "");
    if (text.length > 0) chunks.push(text);
    runIndices = [];
  }

  function commitString(s: string): void {
    const trimmed = s.replace(/[ \t\n]+$/, "");
    if (trimmed.length > 0) chunks.push(trimmed);
  }

  for (let i = 0; i < prep.blocks.length; i++) {
    const block = prep.blocks[i]!;

    // What does extending the current run to include this block look like?
    const candidateStart =
      runIndices.length === 0
        ? block.renderedStart
        : prep.blocks[runIndices[0]!]!.renderedStart;
    const candidateLen = block.renderedEnd - candidateStart;

    if (candidateLen <= hardLimit) {
      runIndices.push(i);
      continue;
    }

    // Doesn't fit. If THIS block alone exceeds hardLimit, commit the
    // current run and hand the block off to the oversized-block splitter
    // (tables / code / word-boundary).
    const blockLen = block.renderedEnd - block.renderedStart;
    if (blockLen > hardLimit) {
      commitRun();
      const blockText = prep.rendered.slice(block.renderedStart, block.renderedEnd);
      const subChunks = splitOversizedBlock(block.node, blockText, hardLimit);
      for (const sc of subChunks) commitString(sc);
      continue;
    }

    // Block fits standalone but pushes the current run over hardLimit.
    // We're about to split. Apply the heading-keep rule: lift any
    // trailing heading-like blocks off the about-to-commit chunk and
    // carry them into the next chunk with this block. A heading at the
    // end of message N with its body starting message N+1 reads worse
    // than the heading sitting with its body in N+1.
    //
    // Stop lifting if (a) doing so would empty the current chunk
    // (better to ship a chunk-with-trailing-heading than no chunk at
    // all, which would loop), or (b) the carried heading + new block
    // would itself overflow (the section is fundamentally bigger than
    // a Discord message; just split at the block boundary).
    const carried: number[] = [];
    while (runIndices.length > 1) {
      const tailIdx = runIndices[runIndices.length - 1]!;
      const tailBlock = prep.blocks[tailIdx]!;
      if (!isHeadingLike(tailBlock.node)) break;
      // Would popping this heading make the next chunk overflow?
      // If yes, leave the heading in the current chunk.
      const nextChunkSize = block.renderedEnd - tailBlock.renderedStart;
      if (nextChunkSize > hardLimit) break;
      runIndices.pop();
      carried.unshift(tailIdx);
    }

    commitRun();
    runIndices = [...carried, i];
  }

  commitRun();
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
