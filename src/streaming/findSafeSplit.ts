/**
 * Markdown-aware message splitter for streaming Discord messages.
 *
 * As assistant text streams in we accumulate it in a buffer and edit a single
 * Discord message. When the buffer outgrows what one Discord message can hold,
 * we need to seal the message and continue in a new one — but the seal point
 * has to fall on a markdown boundary, never inside a fenced code block, list,
 * blockquote, table, or any other formatting that would render broken if
 * split mid-construct.
 *
 * The "seal" is potentially a rollback: the displayed message may already
 * contain more text than the seam allows (we showed it optimistically as it
 * streamed). After the split we re-edit the previous message down to `keep`
 * and post `carryOver` as the new message. The discord-side caller handles
 * those two writes; this function is pure.
 *
 * # Seam policy
 *
 * 1. **Paragraph seam** (preferred) — a run of two-or-more newlines with
 *    `keep` ending on a non-empty paragraph and `carryOver` starting on a
 *    non-empty paragraph, both outside any open fenced code block. List
 *    runs, blockquote runs, and table rows have no blank lines between
 *    items, so a paragraph seam never falls inside one.
 *
 * 2. **Line seam outside code** (fallback, force only) — any newline
 *    outside a fenced code block. Used only when the buffer has no
 *    paragraph seam and we MUST split (caller passed `force: true`,
 *    typically because the buffer is past the hard limit or streaming
 *    has ended).
 *
 * 3. **Word-boundary cut** (fallback, force only) — last whitespace
 *    boundary at or before the hard limit. Last resort before mid-word
 *    truncation.
 *
 * 4. **Hard cut at hardLimit** — the absolute fallback. Mid-word, possibly
 *    mid-fence; the result is ugly but the bytes fit.
 *
 * Inline marks (`**bold**`, `*italic*`, `__underline__`, `~~strike~~`,
 * `||spoiler||`, single-backtick inline code) are not tracked — well-formed
 * markdown closes them within a paragraph, so a paragraph seam never falls
 * inside one. If the upstream content leaves them open across a paragraph
 * break, the markdown is already broken before we touch it.
 */

export interface SplitOptions {
  /**
   * Try to seal at a paragraph seam at-or-before this position. Picked to
   * leave headroom under the hard limit so the surrounding edits can run
   * without racing the next delta past the cap.
   */
  softLimit: number;
  /**
   * The split's `keep` must never exceed this many characters. Discord's
   * per-message cap is 2000; production callers should pass ~1990 to leave
   * a margin for trailing whitespace trimming and provider drift.
   */
  hardLimit: number;
  /**
   * When true, the function MUST return a split (cascading through line and
   * word fallbacks down to a hard cut). When false, returns null if no
   * paragraph seam exists at-or-before softLimit — the caller should keep
   * accumulating deltas and try again.
   */
  force?: boolean;
}

export interface SplitResult {
  /** Content for the current Discord message. ≤ hardLimit chars. */
  keep: string;
  /** Content to start the next Discord message with. May be empty. */
  carryOver: string;
}

/**
 * Find a safe split point in `text` per the policy above. Returns null only
 * when `force` is false AND no paragraph seam exists ≤ softLimit. Whitespace
 * around the seam is trimmed so neither side has stray leading/trailing
 * blank lines.
 */
export function findSafeSplit(text: string, options: SplitOptions): SplitResult | null {
  const { softLimit, hardLimit, force = false } = options;
  if (text.length === 0) return null;

  const seams = collectSeams(text);

  const paragraph = pickLatestAtOrBefore(seams.paragraphsOutsideCode, softLimit);
  if (paragraph !== null) return splitAt(text, paragraph);

  if (!force) return null;

  // Forced fallbacks — try to land somewhere that at least respects line
  // structure and stays outside an open fenced code block.
  const lineOut = pickLatestAtOrBefore(seams.linesOutsideCode, hardLimit);
  if (lineOut !== null && lineOut > 0) return splitAt(text, lineOut);

  const word = lastWordBoundaryAtOrBefore(text, hardLimit);
  if (word !== null && word > 0) return splitAt(text, word);

  // Absolute fallback: hard cut at the limit. May fall mid-fence; the
  // streaming caller will reopen the fence on the next message if needed.
  const cut = Math.min(hardLimit, text.length);
  return splitAt(text, cut);
}

interface Seams {
  paragraphsOutsideCode: number[];
  linesOutsideCode: number[];
}

/**
 * Walk the text once, recording seam offsets. A "paragraph seam" is a
 * position where the prefix ends a paragraph and the suffix begins one,
 * with the boundary outside any fenced code block. A "line seam" is any
 * newline boundary outside a fenced code block.
 *
 * The seam offset is the index in `text` at which the carry-over begins.
 * `splitAt` then trims trailing whitespace off keep and leading whitespace
 * off carryOver so the seam itself doesn't show as a blank line.
 */
function collectSeams(text: string): Seams {
  const paragraphsOutsideCode: number[] = [];
  const linesOutsideCode: number[] = [];

  let inCode = false;
  let codeFenceChar: "`" | "~" | null = null;
  let codeFenceLen = 0;

  let lineStart = 0;
  // The virtual "before-the-text" line counts as blank so the very first
  // line of the doc never gets recorded as a paragraph seam.
  let prevLineBlank = true;
  let i = 0;

  while (i <= text.length) {
    const atEnd = i === text.length;
    const ch = atEnd ? "\n" : text[i]; // treat EOF as a final line break

    if (ch === "\n" || atEnd) {
      const lineEnd = i;
      const lineText = text.slice(lineStart, lineEnd);

      const fence = matchFenceLine(lineText);
      if (fence) {
        if (!inCode) {
          inCode = true;
          codeFenceChar = fence.char;
          codeFenceLen = fence.len;
        } else if (
          fence.char === codeFenceChar &&
          fence.len >= codeFenceLen &&
          fence.trailingIsBlank
        ) {
          inCode = false;
          codeFenceChar = null;
          codeFenceLen = 0;
        }
      }

      const isBlank = lineText.trim().length === 0;
      const seamPos = lineEnd + (atEnd ? 0 : 1); // start of next line

      // Line seam: every newline outside code is a candidate.
      if (!atEnd && !inCode) linesOutsideCode.push(seamPos);

      // Paragraph seam: this line is blank, outside code, and the previous
      // line was non-blank — i.e., the prefix just ended a paragraph. The
      // seam offset (`seamPos`) is the start of the line AFTER the blank,
      // so trimming `keep` collapses the trailing newlines cleanly.
      // Multiple consecutive blank lines collapse: only the first blank
      // line in the run gets recorded; later blanks would produce
      // equivalent results after trimming.
      if (isBlank && !inCode && !prevLineBlank) {
        paragraphsOutsideCode.push(seamPos);
      }

      prevLineBlank = isBlank;
      lineStart = lineEnd + 1;
    }
    i++;
  }

  return { paragraphsOutsideCode, linesOutsideCode };
}

interface FenceMatch {
  char: "`" | "~";
  len: number;
  /** True if everything after the fence run on this line is whitespace. */
  trailingIsBlank: boolean;
}

/**
 * Match a fenced code-block marker line. Allows up to 3 leading spaces
 * (CommonMark). The fence is at least 3 of the same character (` or ~).
 * For a closing fence we also require the line have nothing but
 * whitespace after the run; openers may carry a language hint.
 */
function matchFenceLine(line: string): FenceMatch | null {
  const match = line.match(/^ {0,3}(`{3,}|~{3,})(.*)$/);
  if (!match) return null;
  const run = match[1]!;
  const trailing = match[2] ?? "";
  return {
    char: run[0] as "`" | "~",
    len: run.length,
    trailingIsBlank: trailing.trim().length === 0,
  };
}

function pickLatestAtOrBefore(positions: number[], limit: number): number | null {
  let best: number | null = null;
  for (const pos of positions) {
    if (pos > limit) break;
    best = pos;
  }
  return best;
}

function lastWordBoundaryAtOrBefore(text: string, limit: number): number | null {
  const cap = Math.min(limit, text.length);
  for (let i = cap; i > 0; i--) {
    const ch = text[i - 1];
    if (ch === " " || ch === "\t" || ch === "\n") return i;
  }
  return null;
}

function splitAt(text: string, position: number): SplitResult {
  const rawKeep = text.slice(0, position);
  const rawCarry = text.slice(position);
  const keep = trimEnd(rawKeep);
  const carryOver = trimStart(rawCarry);
  return { keep, carryOver };
}

function trimEnd(text: string): string {
  let end = text.length;
  while (end > 0) {
    const ch = text[end - 1];
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
    end--;
  }
  return text.slice(0, end);
}

function trimStart(text: string): string {
  let start = 0;
  while (start < text.length) {
    const ch = text[start];
    if (ch !== " " && ch !== "\t" && ch !== "\n" && ch !== "\r") break;
    start++;
  }
  return text.slice(start);
}
