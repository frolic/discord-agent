/**
 * Inline-level transforms applied alongside the block-level rewrites.
 *
 * - **Task lists**: GFM parses `- [ ]` / `- [x]` as `listItem.checked`.
 *   Discord doesn't render that natively, so we prepend `☐` / `☑` to the
 *   item's first paragraph and clear the `checked` flag (so stringify
 *   doesn't re-emit the bracket syntax).
 * - **Images**: Discord doesn't render inline image markdown, so
 *   `![alt](url)` becomes a masked link `[alt](<url>)` — preserves the
 *   click-through and the alt text without showing broken inline-image
 *   markup.
 * - **HTML**: dropped wholesale. Discord renders raw HTML literally, which
 *   is uglier than just removing the tags.
 *
 * Each transform walks the AST top-down and returns when done.
 */
import type {
  BlockContent,
  Image,
  ImageReference,
  Link,
  List,
  ListItem,
  Paragraph,
  PhrasingContent,
  Root,
  RootContent,
} from "mdast";

const checkedMarker = "☑ ";
const uncheckedMarker = "☐ ";

export function transformInlines(tree: Root): void {
  walk(tree.children);
}

type AnyParent = Root | RootContent | BlockContent | PhrasingContent | ListItem;

function walk(nodes: Array<RootContent | BlockContent | ListItem | PhrasingContent>): void {
  for (let i = 0; i < nodes.length; i++) {
    const node = nodes[i]!;
    // Replacements first (these mutate the array index in place).
    if (node.type === "image") {
      nodes[i] = imageToLink(node);
      continue;
    }
    if (node.type === "imageReference") {
      nodes[i] = imageReferenceToText(node);
      continue;
    }
    if (node.type === "html") {
      // Drop HTML by overwriting with an empty text node — gets stringified
      // as nothing; safer than splicing the array mid-iteration.
      nodes[i] = { type: "text", value: "" } as PhrasingContent;
      continue;
    }
    if (node.type === "list") {
      transformTaskListMarkers(node);
    }
    // Recurse into children for compound nodes.
    if ("children" in node && Array.isArray((node as { children?: unknown[] }).children)) {
      walk((node as AnyParent & { children: Array<RootContent | BlockContent | ListItem | PhrasingContent> }).children);
    }
  }
}

function imageToLink(image: Image): Link {
  const text = image.alt ?? image.title ?? image.url;
  return {
    type: "link",
    url: image.url,
    title: image.title ?? null,
    children: [{ type: "text", value: text }],
  };
}

function imageReferenceToText(node: ImageReference): PhrasingContent {
  // No URL available without a definition lookup; just keep the alt as text.
  return { type: "text", value: node.alt ?? "" };
}

function transformTaskListMarkers(list: List): void {
  for (const item of list.children) {
    if (typeof item.checked !== "boolean") continue;
    const marker = item.checked ? checkedMarker : uncheckedMarker;
    item.checked = null;
    prependToFirstParagraph(item, marker);
  }
}

function prependToFirstParagraph(item: ListItem, marker: string): void {
  const firstChild = item.children[0];
  if (firstChild && firstChild.type === "paragraph") {
    prependText(firstChild, marker);
    return;
  }
  // No paragraph as first child (rare — e.g., a checked item containing
  // only a list). Wrap an empty paragraph at the front so the marker has
  // somewhere to live.
  const para: Paragraph = { type: "paragraph", children: [{ type: "text", value: marker }] };
  item.children.unshift(para);
}

function prependText(paragraph: Paragraph, prefix: string): void {
  const first = paragraph.children[0];
  if (first && first.type === "text") {
    first.value = prefix + first.value;
    return;
  }
  paragraph.children.unshift({ type: "text", value: prefix });
}
