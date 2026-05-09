/**
 * Convert raw streamed model markdown into a Discord-ready payload.
 *
 * The agent writes standard GFM-flavored markdown — the format any LLM
 * naturally produces — and this module translates the bits Discord
 * doesn't render into bits it does:
 *
 *   1. **`remend`** runs first on the raw string to close incomplete
 *      inline marks (mid-stream `**bold` becomes `**bold**` so live edits
 *      don't show literal asterisks). Configured to skip middle-of-string
 *      escapes so position offsets through the body stay byte-identical
 *      to raw — important because the dispatcher tracks raw offsets when
 *      sealing.
 *   2. **`remark` parses** the closed text into an mdast AST (with GFM
 *      tables / task lists / strikethrough).
 *   3. **Transform visitors** rewrite nodes Discord can't render:
 *      tables → ASCII code blocks, task lists → `☐`/`☑` bullets,
 *      images → masked links, raw HTML → dropped.
 *   4. **`remark-stringify`** emits each top-level block back to markdown,
 *      and we accumulate them with raw → rendered offset tracking so the
 *      streaming dispatcher can compute clean seam points by block.
 *
 * The result is a `rendered` string Discord can post directly, plus a
 * list of `BlockInfo`s carrying both the raw position (for buffer
 * truncation after sealing) and the rendered position (for picking
 * seams under the size limit).
 */
import remend from "remend";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import type { Root, RootContent } from "mdast";
import { transformTables } from "./transforms/transformTables.ts";
import { transformInlines } from "./transforms/transformInlines.ts";

export interface BlockInfo {
  /** Index into the post-`remend` raw string where this block begins. */
  rawStart: number;
  /** Index into the post-`remend` raw string where this block ends. */
  rawEnd: number;
  /** Index into the rendered string where this block's text begins. */
  renderedStart: number;
  /** Index into the rendered string where this block's text ends. */
  renderedEnd: number;
  /** Convenience: the transformed node, if a caller needs the kind. */
  node: RootContent;
}

export interface PreparedDelivery {
  /** The Discord-ready text. */
  rendered: string;
  /** One entry per top-level block, in document order. */
  blocks: BlockInfo[];
}

/**
 * remend options tuned for the streaming dispatcher. Leaving the
 * middle-of-string escapes (`singleTilde`, `comparisonOperators`) off
 * keeps remend purely a suffix-closer: characters before the unfinished
 * mark don't shift, so AST offsets map back to the raw buffer 1:1 for
 * everything except the trailing-most block.
 */
const remendOptions = {
  bold: true,
  italic: true,
  boldItalic: true,
  inlineCode: true,
  links: true,
  linkMode: "text-only" as const,
  images: true,
  strikethrough: true,
  htmlTags: true,
  setextHeadings: true,
  // Off — these modify the middle of the string and would break
  // raw-offset tracking.
  singleTilde: false,
  comparisonOperators: false,
  // Off — math is unlikely in Discord and `$` is ambiguous with currency.
  inlineKatex: false,
  katex: false,
};

const parser = unified().use(remarkParse).use(remarkGfm);

/**
 * `remark-stringify` configured for Discord-flavored output:
 * - `**bold**` (over `__bold__`, which Discord renders as underline)
 * - `*italic*` (over `_italic_`, same reason)
 * - Fenced code blocks (over indented), with backtick fences
 * - Hyphen list bullets
 *
 * `remark-gfm` is loaded on both the parser AND the stringifier. The
 * parser side recognizes GFM constructs; the stringifier side
 * registers handlers that know how to serialize them back to markdown.
 * Without it on the stringifier, AST nodes the parser produced (e.g.
 * `delete` for `~~strikethrough~~`, `table`, `footnoteDefinition`)
 * crash `mdast-util-to-markdown` with "Cannot handle unknown node".
 * Tables don't normally hit this because `transformTables` rewrites
 * them to plain `code` nodes before stringify; strikethrough does
 * because we don't transform it.
 */
const stringifier = unified()
  .use(remarkGfm)
  .use(remarkStringify, {
    emphasis: "*",
    strong: "*",
    bullet: "-",
    fence: "`",
    fences: true,
    rule: "-",
    listItemIndent: "one",
  });

export function prepareForDelivery(rawBuffer: string): PreparedDelivery {
  if (rawBuffer.length === 0) return { rendered: "", blocks: [] };

  const closed = remend(rawBuffer, remendOptions);
  const tree = parser.parse(closed) as Root;

  // Block-level transforms first so subsequent inline visitors operate on
  // the post-rewrite tree (e.g., a table that became a code block has no
  // inline children to walk into).
  tree.children = transformTables(tree.children);
  transformInlines(tree);

  const blocks: BlockInfo[] = [];
  const renderedParts: string[] = [];
  let renderedCursor = 0;

  for (let i = 0; i < tree.children.length; i++) {
    const child = tree.children[i]!;
    const text = stringifyBlock(child);
    const renderedStart = renderedCursor;
    const renderedEnd = renderedStart + text.length;
    blocks.push({
      rawStart: child.position?.start.offset ?? 0,
      rawEnd: child.position?.end.offset ?? rawBuffer.length,
      renderedStart,
      renderedEnd,
      node: child,
    });
    renderedParts.push(text);
    renderedCursor = renderedEnd;
    const next = tree.children[i + 1];
    if (next) {
      const sep = separatorBetween(child, next);
      renderedParts.push(sep);
      renderedCursor += sep.length;
    }
  }

  return { rendered: renderedParts.join(""), blocks };
}

/**
 * Pick the inter-block separator. Default is `\n\n` (one blank line —
 * needed for paragraph separation and to break lists/blockquotes out
 * of lazy continuation). Drop to `\n` when either side is a fenced
 * code block: the code block already renders with its own top/bottom
 * padding in Discord, so an explicit blank line on top of that
 * compounds visually into ~1.5x the spacing the model intended. The
 * closing fence is unambiguous, so the parser still breaks correctly
 * with just a single newline.
 */
function separatorBetween(prev: RootContent, next: RootContent): string {
  if (prev.type === "code" || next.type === "code") return "\n";
  return "\n\n";
}

function stringifyBlock(node: RootContent): string {
  // Wrap the block in a one-child tree so remark-stringify treats it as
  // its own document. The returned string includes a trailing newline
  // we strip — block separation is handled by the caller's accumulator.
  const single: Root = { type: "root", children: [node as Root["children"][number]] };
  const text = stringifier.stringify(single).replace(/\n+$/, "");
  return text;
}
