/**
 * Pick a safe seam in a prepared delivery payload.
 *
 * The hard part of "split this stream into Discord messages" is choosing
 * a place that won't cut a markdown construct mid-flight. Now that the
 * caller hands us a `PreparedDelivery` with explicit top-level block
 * boundaries (each block is a paragraph, code block, list, blockquote,
 * heading, etc.), seam selection is mostly bookkeeping:
 *
 *   1. The boundary BETWEEN any two top-level blocks is always safe — by
 *      construction, the first block is a complete construct and the
 *      second begins a fresh one. Pick the latest such boundary at-or-
 *      before the soft limit.
 *   2. If no clean boundary fits and the caller forces a split (buffer
 *      past hard limit, or stream has ended), fall back to within-block
 *      cuts: word boundary inside a paragraph, or close-and-reopen-fence
 *      inside a code block. Code-block splits preserve the language.
 *   3. If even that fails, hard-cut at the rendered hard limit.
 *
 * Result is expressed in BOTH rendered and raw terms — the dispatcher
 * needs the rendered slice to send to Discord and the raw slice to
 * truncate its buffer for subsequent deltas.
 */
import type { RootContent } from "mdast";
import type { PreparedDelivery } from "./prepareForDelivery.ts";

export interface SplitOptions {
  /** Try to seal at a block boundary at-or-before this rendered offset. */
  softLimit: number;
  /** The seal's `keepRendered` must never exceed this. */
  hardLimit: number;
  /** When true, MUST return a split (cascading through within-block fallbacks). */
  force?: boolean;
}

export interface SplitResult {
  /** Rendered text for the current Discord message. ≤ hardLimit chars. */
  keepRendered: string;
  /** Raw chars consumed up to and including the seam. The dispatcher slices
   *  its raw buffer at this offset so the next flush starts fresh. */
  rawConsumed: number;
}

/**
 * Find a safe split in `prep`. Returns null only when `force` is false AND
 * no block boundary lands at-or-before softLimit.
 */
export function findSafeSplit(prep: PreparedDelivery, options: SplitOptions): SplitResult | null {
  const { softLimit, hardLimit, force = false } = options;
  if (prep.rendered.length === 0) return null;

  const seamIndex = pickLatestBoundary(prep, softLimit);
  if (seamIndex !== null) {
    const seamBlock = prep.blocks[seamIndex]!;
    return {
      keepRendered: prep.rendered.slice(0, seamBlock.renderedEnd).trimEnd(),
      rawConsumed: seamBlock.rawEnd,
    };
  }

  if (!force) return null;

  // Forced fallbacks. Find the block that straddles `hardLimit`; cut
  // inside it.
  const overflowing = prep.blocks.find(
    (b) => b.renderedStart < hardLimit && b.renderedEnd > softLimit,
  );
  if (overflowing) {
    return forceSplitInsideBlock(prep, overflowing, options);
  }

  // No block straddles — buffer is short or weirdly shaped. Hard-cut.
  return hardCut(prep, hardLimit);
}

function pickLatestBoundary(prep: PreparedDelivery, softLimit: number): number | null {
  // The boundary AFTER block i is at rendered offset `blocks[i].renderedEnd`.
  // We want the latest i whose renderedEnd ≤ softLimit AND there exists at
  // least one block AFTER it (otherwise sealing here means "send everything"
  // — no carry-over needed, no split actually required).
  //
  // Prefer boundaries that land RIGHT BEFORE a heading-like block — both
  // proper ATX headings (`## Section`) and "bold-only" pseudo-headings
  // (`**Section title**` on a line by itself) that LLMs reach for. Models
  // structure long replies by section; sealing on a section break feels
  // natural, sealing in the middle of a section's content doesn't.
  let bestAny: number | null = null;
  let bestBeforeHeading: number | null = null;
  for (let i = 0; i < prep.blocks.length - 1; i++) {
    const block = prep.blocks[i]!;
    if (block.renderedEnd > softLimit) break;
    bestAny = i;
    if (isHeadingLike(prep.blocks[i + 1]!.node)) {
      bestBeforeHeading = i;
    }
  }
  return bestBeforeHeading ?? bestAny;
}

/**
 * A node the model is using as a section break. Both proper headings
 * (`## Title`) and a paragraph that's just bold text (`**Title**` on its
 * own line) qualify — the latter is a common LLM substitute for a real
 * heading when the model doesn't want full heading semantics.
 */
function isHeadingLike(node: RootContent): boolean {
  if (node.type === "heading") return true;
  if (node.type === "paragraph" && node.children.length === 1 && node.children[0]?.type === "strong") {
    return true;
  }
  return false;
}

function forceSplitInsideBlock(
  prep: PreparedDelivery,
  block: PreparedDelivery["blocks"][number],
  options: SplitOptions,
): SplitResult {
  const { hardLimit } = options;
  // For a code block, split with close-fence-and-reopen so the rendered
  // output stays valid markdown on both sides.
  if (block.node.type === "code") {
    return forceSplitCode(prep, block, hardLimit);
  }
  // Paragraphs / lists / blockquotes: fall back to a word boundary inside
  // the rendered slice.
  return forceSplitText(prep, block, hardLimit);
}

function forceSplitCode(
  prep: PreparedDelivery,
  block: PreparedDelivery["blocks"][number],
  hardLimit: number,
): SplitResult {
  const fenceClose = "\n```";
  // Aim the close so the resulting message length ≤ hardLimit.
  // Walk back from hardLimit to a newline boundary inside the rendered
  // block so we don't slice mid-line.
  const cap = Math.min(hardLimit - fenceClose.length, block.renderedEnd);
  const cutAt = lastNewlineInBlock(prep.rendered, block.renderedStart, cap);
  const keepRendered = prep.rendered.slice(0, cutAt) + fenceClose;
  // Map rendered cut → raw. Inside a fenced code block, rendered and raw
  // have the same content between fences, so the offset delta from the
  // block's render start is a good approximation of the offset delta
  // from its raw start. Caps at rawEnd so we never consume past the
  // block; the next flush re-prepares the carry-over and the open fence
  // is re-derived from the trailing raw chars.
  const renderedOffsetInBlock = cutAt - block.renderedStart;
  const rawConsumed = Math.min(block.rawStart + renderedOffsetInBlock, block.rawEnd);
  return { keepRendered, rawConsumed };
}

function forceSplitText(
  prep: PreparedDelivery,
  block: PreparedDelivery["blocks"][number],
  hardLimit: number,
): SplitResult {
  const cap = Math.min(hardLimit, block.renderedEnd);
  const cutAt = lastWordBoundary(prep.rendered, block.renderedStart, cap);
  // Map rendered cut → raw. Within a paragraph the only transforms that
  // change length are emphasis normalization (`__` → `**`, same count)
  // and image-to-link (rare), so 1:1 offset mapping is close enough for
  // the next flush to re-render cleanly.
  const renderedOffsetInBlock = cutAt - block.renderedStart;
  const rawConsumed = Math.min(block.rawStart + renderedOffsetInBlock, block.rawEnd);
  return {
    keepRendered: prep.rendered.slice(0, cutAt).trimEnd(),
    rawConsumed,
  };
}

function hardCut(prep: PreparedDelivery, hardLimit: number): SplitResult {
  const cap = Math.min(hardLimit, prep.rendered.length);
  return {
    keepRendered: prep.rendered.slice(0, cap),
    rawConsumed: cap,
  };
}

function lastNewlineInBlock(rendered: string, blockStart: number, cap: number): number {
  for (let i = cap; i > blockStart; i--) {
    if (rendered[i - 1] === "\n") return i;
  }
  return cap;
}

function lastWordBoundary(rendered: string, blockStart: number, cap: number): number {
  for (let i = cap; i > blockStart; i--) {
    const ch = rendered[i - 1];
    if (ch === " " || ch === "\t" || ch === "\n") return i;
  }
  return cap;
}
