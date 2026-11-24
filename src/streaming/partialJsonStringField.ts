/**
 * Read one string field out of a JSON object that is still being streamed.
 *
 * The harness sees tool-call arguments as a growing JSON *text* prefix
 * (`toolcall_delta` carries the next chunk of `{"text":"…"}`), so the reply
 * cannot wait for `JSON.parse` — there is no complete document until
 * `toolcall_end`. This module does the tolerant read: walk the prefix, find the
 * named top-level field, and decode its string value as far as it goes.
 *
 * Design rules:
 *
 * - **Never throw.** A malformed buffer is a value (`malformed: true`), not an
 *   exception — the caller decides to fall back to posting on completion.
 * - **Monotonic.** For a growing prefix the returned `value` only ever grows
 *   (never shrinks, never rewrites its prefix), so a caller can diff it and
 *   append the suffix to a live message. Two things could break that and are
 *   handled explicitly: an escape sequence split across deltas (held back until
 *   it is complete) and a UTF-16 surrogate pair split across deltas (the high
 *   half is held back until its low half arrives).
 * - **Faithful.** Escapes are decoded exactly as `JSON.parse` would, including
 *   `\uXXXX`. Anything the reader cannot decode is reported as malformed rather
 *   than guessed at; the caller then relies on the authoritative
 *   `toolCall.arguments` from `toolcall_end`.
 *
 * This is used for the live typing effect only — the delivered message is always
 * finalised from the authoritative parsed arguments, so a partial read can be
 * corrected but never becomes the final content.
 */

export interface PartialStringField {
  /** Decoded value so far. `null` when the field has not started yet. */
  value: string | null;
  /** True once the value's closing quote was seen (the value is final). */
  complete: boolean;
  /** True when the buffer cannot be read as a JSON object prefix. */
  malformed: boolean;
}

/** Convenience constructor for "nothing to say yet". */
const notYet: PartialStringField = { value: null, complete: false, malformed: false };

export function readPartialStringField(json: string, field: string): PartialStringField {
  let index = 0;

  const skipWhitespace = (): void => {
    while (index < json.length && isJsonWhitespace(json[index]!)) index++;
  };
  const truncated = (): PartialStringField => ({ value: null, complete: false, malformed: false });
  const malformed = (): PartialStringField => ({ value: null, complete: false, malformed: true });

  skipWhitespace();
  if (index >= json.length) return notYet;
  if (json[index] !== "{") return malformed();
  index++;

  while (true) {
    skipWhitespace();
    if (index >= json.length) return truncated();
    if (json[index] === "}") return { value: null, complete: false, malformed: false };
    if (json[index] === ",") {
      index++;
      continue;
    }
    if (json[index] !== '"') return malformed();

    const key = readJsonString(json, index);
    if (key.malformed) return malformed();
    // A key that is still being written is not a field yet — including when the
    // partial key already matches, since we cannot know the real name until the
    // closing quote lands.
    if (!key.complete) return truncated();
    index = key.nextIndex;

    skipWhitespace();
    if (index >= json.length) return truncated();
    if (json[index] !== ":") return malformed();
    index++;

    skipWhitespace();
    if (index >= json.length) return truncated();

    if (key.value === field) {
      if (json[index] !== '"') {
        // The field exists but is not a string — the caller's schema rejects it
        // at execution time; for streaming this is simply unreadable.
        return malformed();
      }
      const value = readJsonString(json, index);
      if (value.malformed) return malformed();
      return {
        value: trimTrailingHighSurrogate(value.value, value.complete),
        complete: value.complete,
        malformed: false,
      };
    }

    const skipped = skipJsonValue(json, index);
    if (skipped.kind === "malformed") return malformed();
    if (skipped.kind === "truncated") return truncated();
    index = skipped.nextIndex;
  }
}

interface JsonStringRead {
  value: string;
  complete: boolean;
  malformed: boolean;
  /** Index just past the closing quote when complete. */
  nextIndex: number;
}

/**
 * Read the JSON string that starts at `start` (which must be `"`).
 *
 * Truncation is not an error: the decoded prefix comes back with
 * `complete: false`. A bad escape or a raw control character is an error.
 */
function readJsonString(json: string, start: number): JsonStringRead {
  let index = start + 1;
  let value = "";
  while (index < json.length) {
    const character = json[index]!;
    if (character === '"') {
      return { value, complete: true, malformed: false, nextIndex: index + 1 };
    }
    if (character === "\\") {
      const escape = readEscape(json, index);
      if (escape.kind === "incomplete") {
        return { value, complete: false, malformed: false, nextIndex: json.length };
      }
      if (escape.kind === "invalid") {
        return { value, complete: false, malformed: true, nextIndex: index };
      }
      value += escape.text;
      index = escape.nextIndex;
      continue;
    }
    if (character.charCodeAt(0) < 0x20) {
      // Raw control characters are invalid inside a JSON string (a real newline
      // from the model means the JSON is broken, not that the reply has one).
      return { value, complete: false, malformed: true, nextIndex: index };
    }
    value += character;
    index++;
  }
  return { value, complete: false, malformed: false, nextIndex: index };
}

type EscapeRead =
  | { kind: "decoded"; text: string; nextIndex: number }
  | { kind: "incomplete" }
  | { kind: "invalid" };

/** Decode the escape sequence starting at `start` (which must be `\`). */
function readEscape(json: string, start: number): EscapeRead {
  if (start + 1 >= json.length) return { kind: "incomplete" };
  const marker = json[start + 1]!;
  switch (marker) {
    case '"':
      return { kind: "decoded", text: '"', nextIndex: start + 2 };
    case "\\":
      return { kind: "decoded", text: "\\", nextIndex: start + 2 };
    case "/":
      return { kind: "decoded", text: "/", nextIndex: start + 2 };
    case "b":
      return { kind: "decoded", text: "\b", nextIndex: start + 2 };
    case "f":
      return { kind: "decoded", text: "\f", nextIndex: start + 2 };
    case "n":
      return { kind: "decoded", text: "\n", nextIndex: start + 2 };
    case "r":
      return { kind: "decoded", text: "\r", nextIndex: start + 2 };
    case "t":
      return { kind: "decoded", text: "\t", nextIndex: start + 2 };
    case "u": {
      const unit = readHexCodeUnit(json, start);
      if (unit.kind !== "decoded") return unit;
      const isHighSurrogate = unit.codeUnit >= 0xd800 && unit.codeUnit <= 0xdbff;
      if (!isHighSurrogate) {
        return { kind: "decoded", text: String.fromCharCode(unit.codeUnit), nextIndex: unit.nextIndex };
      }
      // A high surrogate is only meaningful with a following low surrogate. If
      // the next escape is a `\u` that hasn't finished arriving, hold the whole
      // pair back so the live message never shows half an emoji.
      const nextMarker = json[unit.nextIndex];
      const nextUnitMarker = json[unit.nextIndex + 1];
      if (nextMarker === "\\" && nextUnitMarker === "u") {
        const low = readHexCodeUnit(json, unit.nextIndex);
        if (low.kind === "incomplete") return { kind: "incomplete" };
        if (low.kind === "decoded" && low.codeUnit >= 0xdc00 && low.codeUnit <= 0xdfff) {
          const combined = String.fromCharCode(unit.codeUnit, low.codeUnit);
          return { kind: "decoded", text: combined, nextIndex: low.nextIndex };
        }
      }
      return { kind: "decoded", text: String.fromCharCode(unit.codeUnit), nextIndex: unit.nextIndex };
    }
    default:
      return { kind: "invalid" };
  }
}

type CodeUnitRead =
  | { kind: "decoded"; codeUnit: number; nextIndex: number }
  | { kind: "incomplete" }
  | { kind: "invalid" };

/** Decode `\uXXXX` at `start` (which must point at the backslash). */
function readHexCodeUnit(json: string, start: number): CodeUnitRead {
  const digits = json.slice(start + 2, start + 6);
  if (digits.length < 4) {
    // Could still be arriving — unless what we do have is already not hex.
    return /^[0-9a-fA-F]*$/.test(digits) ? { kind: "incomplete" } : { kind: "invalid" };
  }
  if (!/^[0-9a-fA-F]{4}$/.test(digits)) return { kind: "invalid" };
  return { kind: "decoded", codeUnit: Number.parseInt(digits, 16), nextIndex: start + 6 };
}

/**
 * Drop a high surrogate sitting at the end of an incomplete value: it is half of
 * a character whose other half may still be arriving, and emitting it would put
 * a lone surrogate in a Discord message.
 */
function trimTrailingHighSurrogate(value: string, complete: boolean): string {
  if (complete || value.length === 0) return value;
  const last = value.charCodeAt(value.length - 1);
  if (last >= 0xd800 && last <= 0xdbff) return value.slice(0, -1);
  return value;
}

type SkipResult =
  | { kind: "ok"; nextIndex: number }
  | { kind: "truncated" }
  | { kind: "malformed" };

/** Skip a JSON value we do not care about, tolerating a truncated tail. */
function skipJsonValue(json: string, start: number): SkipResult {
  const first = json[start];
  if (first === '"') {
    const read = readJsonString(json, start);
    if (read.malformed) return { kind: "malformed" };
    if (!read.complete) return { kind: "truncated" };
    return { kind: "ok", nextIndex: read.nextIndex };
  }
  if (first === "{" || first === "[") {
    let depth = 0;
    let index = start;
    while (index < json.length) {
      const character = json[index]!;
      if (character === '"') {
        const read = readJsonString(json, index);
        if (read.malformed) return { kind: "malformed" };
        if (!read.complete) return { kind: "truncated" };
        index = read.nextIndex;
        continue;
      }
      if (character === "{" || character === "[") depth++;
      if (character === "}" || character === "]") {
        depth--;
        if (depth === 0) return { kind: "ok", nextIndex: index + 1 };
      }
      index++;
    }
    return { kind: "truncated" };
  }
  // Number / true / false / null: runs to the next structural character.
  let index = start;
  while (index < json.length) {
    const character = json[index]!;
    if (character === "," || character === "}" || character === "]") {
      return { kind: "ok", nextIndex: index };
    }
    if (isJsonWhitespace(character)) return { kind: "ok", nextIndex: index };
    index++;
  }
  return { kind: "truncated" };
}

function isJsonWhitespace(character: string): boolean {
  return character === " " || character === "\t" || character === "\n" || character === "\r";
}
