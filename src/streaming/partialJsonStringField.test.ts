import { describe, expect, test } from "bun:test";
import { readPartialStringField } from "./partialJsonStringField.ts";

/** Feed `json` to the reader in `size`-character chunks, as the delta stream does. */
function readAsStream(chunks: string[]): string[] {
  const seen: string[] = [];
  let buffer = "";
  for (const chunk of chunks) {
    buffer += chunk;
    const read = readPartialStringField(buffer, "text");
    expect(read.malformed).toBe(false);
    // The reader is re-run over the whole buffer each delta, so an unchanged
    // value simply means "nothing new to append" — the caller diffs it.
    if (read.value !== null && read.value !== seen.at(-1)) seen.push(read.value);
  }
  return seen;
}

describe("readPartialStringField — plain text", () => {
  test("complete value", () => {
    const read = readPartialStringField('{"text":"hello there"}', "text");
    expect(read).toEqual({ value: "hello there", complete: true, malformed: false });
  });

  test("truncated tail returns what has arrived", () => {
    const read = readPartialStringField('{"text":"hello wor', "text");
    expect(read.value).toBe("hello wor");
    expect(read.complete).toBe(false);
    expect(read.malformed).toBe(false);
  });

  test("nothing yet while the key is still being written", () => {
    expect(readPartialStringField("{", "text").value).toBeNull();
    expect(readPartialStringField('{"te', "text").value).toBeNull();
    expect(readPartialStringField('{"text"', "text").value).toBeNull();
    expect(readPartialStringField('{"text":', "text").value).toBeNull();
  });

  test("empty string value is a value, not 'nothing yet'", () => {
    const read = readPartialStringField('{"text":""}', "text");
    expect(read.value).toBe("");
    expect(read.complete).toBe(true);
  });

  test("leading whitespace and a following member", () => {
    const read = readPartialStringField('{"text":"hi","in_reply_to":"42"}', "text");
    expect(read.value).toBe("hi");
    expect(read.complete).toBe(true);
  });
});

describe("readPartialStringField — escaping", () => {
  test("embedded escaped quotes", () => {
    const read = readPartialStringField('{"text":"he said \\"hi\\" loudly"}', "text");
    expect(read.value).toBe('he said "hi" loudly');
    expect(read.complete).toBe(true);
  });

  test("escaped quotes mid-stream do not end the value", () => {
    const read = readPartialStringField('{"text":"he said \\"hi', "text");
    expect(read.value).toBe('he said "hi');
    expect(read.complete).toBe(false);
  });

  test("backslashes decode and a trailing half-escape is held back", () => {
    const read = readPartialStringField('{"text":"C:\\\\Users\\\\me"}', "text");
    expect(read.value).toBe("C:\\Users\\me");

    // A lone backslash at the very end: the escape hasn't arrived yet.
    const held = readPartialStringField('{"text":"done\\', "text");
    expect(held.value).toBe("done");
    expect(held.malformed).toBe(false);

    // Half an escape: still held back, still not an error.
    const half = readPartialStringField('{"text":"done\\u00', "text");
    expect(half.value).toBe("done");
    expect(half.malformed).toBe(false);
  });

  test("escaped newlines appearing mid-stream", () => {
    expect(readPartialStringField('{"text":"line one\\', "text").value).toBe("line one");
    expect(readPartialStringField('{"text":"line one\\n', "text").value).toBe("line one\n");
    expect(readPartialStringField('{"text":"line one\\nline two', "text").value).toBe(
      "line one\nline two",
    );
    expect(readPartialStringField('{"text":"a\\tb\\rc\\bd\\fe"}', "text").value).toBe(
      "a\tb\rc\bd\fe",
    );
  });

  test("unicode escapes: complete, emoji pair, and a held first half", () => {
    expect(readPartialStringField('{"text":"caf\\u00e9"}', "text").value).toBe("café");
    expect(readPartialStringField('{"text":"hi \\ud83d\\ude00"}', "text").value).toBe("hi 😀");
    // First half of a surrogate pair with its partner still in flight.
    expect(readPartialStringField('{"text":"hi \\ud83d', "text").value).toBe("hi ");
    expect(readPartialStringField('{"text":"hi \\ud83d\\ud', "text").value).toBe("hi ");
    // Partner arrived: the whole emoji appears at once.
    expect(readPartialStringField('{"text":"hi \\ud83d\\ude00"}', "text").value).toBe("hi 😀");
  });

  test("a raw emoji split across deltas is never half-emitted", () => {
    const emoji = "😀";
    const high = emoji.slice(0, 1);
    const low = emoji.slice(1);
    const seen = readAsStream(['{"text":"hi ', high, low, '"}']);
    expect(seen).toEqual(["hi ", "hi 😀"]);
  });

  test("invalid escape is malformed, not guessed at", () => {
    expect(readPartialStringField('{"text":"a\\qb"}', "text").malformed).toBe(true);
    expect(readPartialStringField('{"text":"a\\u12g4"}', "text").malformed).toBe(true);
  });

  test("raw control character inside the string is malformed", () => {
    expect(readPartialStringField('{"text":"a\nb"}', "text").malformed).toBe(true);
  });
});

describe("readPartialStringField — other members", () => {
  test("skips a string member before the target", () => {
    const read = readPartialStringField('{"in_reply_to":"123","text":"after"}', "text");
    expect(read.value).toBe("after");
    expect(read.complete).toBe(true);
  });

  test("skips number / boolean / nested members before the target", () => {
    expect(readPartialStringField('{"n":42,"b":true,"text":"ok"}', "text").value).toBe("ok");
    expect(readPartialStringField('{"o":{"a":[1,2,{"b":"}"}]},"text":"ok"}', "text").value).toBe(
      "ok",
    );
  });

  test("a member still arriving before the target reports nothing yet", () => {
    expect(readPartialStringField('{"n":42,"te', "text").value).toBeNull();
    expect(readPartialStringField('{"o":{"a":[1,2', "text").value).toBeNull();
  });

  test("field absent, and non-string field", () => {
    const absent = readPartialStringField('{"in_reply_to":"1"}', "text");
    expect(absent.value).toBeNull();
    expect(absent.malformed).toBe(false);
    expect(readPartialStringField('{"text":12}', "text").malformed).toBe(true);
  });

  test("not an object at all is malformed", () => {
    expect(readPartialStringField("[1,2,3]", "text").malformed).toBe(true);
    expect(readPartialStringField('"plain"', "text").malformed).toBe(true);
    expect(readPartialStringField('{"text" "x"}', "text").malformed).toBe(true);
  });
});

describe("readPartialStringField — streaming behaviour", () => {
  test("value only ever grows, and never rewrites its prefix", () => {
    const chunks = ['{"text"', ':"Gro', "wing ", 'reply', ' with \\"qu', 'otes\\"', '"}'];
    let previous = "";
    for (const value of readAsStream(chunks)) {
      expect(value.startsWith(previous)).toBe(true);
      expect(value.length).toBeGreaterThanOrEqual(previous.length);
      previous = value;
    }
    expect(previous).toBe('Growing reply with "quotes"');
  });

  test("a nasty payload survives being fed one character at a time", () => {
    const original = 'line one\nline two\ttabbed "quoted" C:\\path\\to — 50% 😀 done';
    const json = JSON.stringify({ text: original });
    const seen = readAsStream([...json]);
    expect(seen.length).toBeGreaterThan(0);
    expect(seen.at(-1)).toBe(original);
  });

  test("empty buffer and whitespace-only buffer report nothing yet", () => {
    expect(readPartialStringField("", "text")).toEqual({
      value: null,
      complete: false,
      malformed: false,
    });
    expect(readPartialStringField("   ", "text").value).toBeNull();
  });
});
