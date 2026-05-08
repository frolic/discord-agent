import { describe, expect, test } from "bun:test";
import type { Image, List, ListItem, Paragraph, Root } from "mdast";
import { transformInlines } from "./transformInlines.ts";

function root(children: Root["children"]): Root {
  return { type: "root", children };
}

function paragraph(children: Paragraph["children"]): Paragraph {
  return { type: "paragraph", children };
}

function listItem(checked: boolean | null | undefined, text: string): ListItem {
  return {
    type: "listItem",
    checked: checked ?? null,
    spread: false,
    children: [paragraph([{ type: "text", value: text }])],
  };
}

describe("transformInlines — task lists", () => {
  test("checked task gets ☑ prefix; the listItem.checked flag clears", () => {
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      start: null,
      children: [listItem(true, "done thing")],
    };
    const tree = root([list]);
    transformInlines(tree);
    const item = (tree.children[0]! as List).children[0]!;
    expect(item.checked).toBeNull();
    const para = item.children[0]! as Paragraph;
    const firstText = para.children[0] as { type: "text"; value: string };
    expect(firstText.value.startsWith("☑ ")).toBe(true);
    expect(firstText.value).toContain("done thing");
  });

  test("unchecked task gets ☐ prefix", () => {
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      start: null,
      children: [listItem(false, "todo thing")],
    };
    const tree = root([list]);
    transformInlines(tree);
    const item = (tree.children[0]! as List).children[0]!;
    const para = item.children[0]! as Paragraph;
    const firstText = para.children[0] as { type: "text"; value: string };
    expect(firstText.value.startsWith("☐ ")).toBe(true);
  });

  test("non-task list items (checked === null) are left alone", () => {
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      start: null,
      children: [listItem(null, "regular bullet")],
    };
    const tree = root([list]);
    transformInlines(tree);
    const item = (tree.children[0]! as List).children[0]!;
    const para = item.children[0]! as Paragraph;
    const firstText = para.children[0] as { type: "text"; value: string };
    expect(firstText.value).toBe("regular bullet"); // no marker added
  });
});

describe("transformInlines — images", () => {
  test("inline image becomes a masked link", () => {
    const image: Image = {
      type: "image",
      url: "https://example.com/cat.png",
      alt: "a cat",
      title: null,
    };
    const tree = root([paragraph([{ type: "text", value: "see " }, image])]);
    transformInlines(tree);
    const para = tree.children[0]! as Paragraph;
    const second = para.children[1] as { type: string; url?: string; children?: Array<{ value: string }> };
    expect(second.type).toBe("link");
    expect(second.url).toBe("https://example.com/cat.png");
    expect(second.children?.[0]?.value).toBe("a cat");
  });

  test("image with no alt falls back to title, then to url", () => {
    const imageNoAlt: Image = {
      type: "image",
      url: "https://example.com/x.png",
      alt: null,
      title: "fallback title",
    };
    const tree = root([paragraph([imageNoAlt])]);
    transformInlines(tree);
    const para = tree.children[0]! as Paragraph;
    const link = para.children[0] as { children: Array<{ value: string }> };
    expect(link.children[0]!.value).toBe("fallback title");
  });
});

describe("transformInlines — html stripping", () => {
  test("html nodes get replaced with empty text (rendered as nothing)", () => {
    const tree = root([
      paragraph([
        { type: "text", value: "before " },
        { type: "html", value: "<b>" },
        { type: "text", value: "after" },
      ]),
    ]);
    transformInlines(tree);
    const para = tree.children[0]! as Paragraph;
    const types = para.children.map((c) => c.type);
    expect(types).not.toContain("html");
  });
});

describe("transformInlines — recursion into nested children", () => {
  test("walks into list items so a checked item containing an image still rewrites the image", () => {
    // A checked task list item whose first paragraph contains only an
    // image. The visitor should:
    //   1. Prepend the ☐ marker to the paragraph (since the first child
    //      isn't a text node, it inserts a new text node at index 0).
    //   2. Recurse into the paragraph and replace the image with a link.
    // Final order: [marker text, link]. The image is gone either way.
    const image: Image = {
      type: "image",
      url: "https://example.com/x.png",
      alt: "x",
      title: null,
    };
    const list: List = {
      type: "list",
      ordered: false,
      spread: false,
      start: null,
      children: [
        {
          type: "listItem",
          checked: false,
          spread: false,
          children: [paragraph([image])],
        },
      ],
    };
    const tree = root([list]);
    transformInlines(tree);
    const item = (tree.children[0]! as List).children[0]!;
    const para = item.children[0]! as Paragraph;
    const types = para.children.map((c) => c.type);
    expect(types).toContain("link");
    expect(types).not.toContain("image");
  });
});
