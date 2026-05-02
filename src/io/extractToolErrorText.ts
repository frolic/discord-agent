/**
 * Pull a human-readable error message out of a failed tool's
 * `AgentToolResult`. The pi convention is `{ content: [{ type: "text",
 * text: "..." }], isError: true }`, with the message in the first text
 * part — but we accept the whole object as `unknown` and walk it
 * defensively so a malformed result still produces *some* line in the
 * debug channel rather than crashing the renderer.
 *
 * The returned string is always single-line: newlines collapse into
 * ` · ` separators so the caller can drop it into a Discord `-#`
 * small-text line without losing the small-text formatting on
 * subsequent lines (Discord's `-#` only applies per-line).
 */
import { isPlainObject } from "./isPlainObject.ts";

const fallbackMessage = "(no error message)";
const errorMessageCharLimit = 500;

export function extractToolErrorText(result: unknown): string {
  const raw = pickText(result) ?? fallbackMessage;
  // Collapse runs of whitespace + newlines into a single ` · ` separator.
  // Trim trailing separators if the input ends on a newline.
  const flattened = raw.replace(/\s*\n+\s*/g, " · ").replace(/( · )+$/, "");
  return flattened.length > errorMessageCharLimit
    ? `${flattened.slice(0, errorMessageCharLimit)}…`
    : flattened;
}

function pickText(result: unknown): string | null {
  if (!isPlainObject(result)) return null;
  const content = result.content;
  if (!Array.isArray(content)) return null;
  for (const part of content) {
    if (!isPlainObject(part)) continue;
    if (part.type !== "text") continue;
    if (typeof part.text === "string" && part.text.length > 0) return part.text;
  }
  return null;
}
