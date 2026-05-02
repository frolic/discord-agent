/**
 * Generic per-arg log formatting for the debug channel: every key/value
 * pair from the model's tool call, rendered as `key=value`. Iterating
 * the params blindly (rather than per-tool whitelisting) means new tool
 * parameters surface in the log automatically.
 *
 * IDs are kept full-length on purpose — copy-pasting message/user IDs
 * out of the log into Discord URLs or follow-up tools is a real workflow.
 *
 * Format rules:
 * - strings        → `key="<sanitized, truncated to 200 chars>"`
 * - numbers/bools  → `key=<value>` (bare)
 * - arrays/objects → `key=<JSON.stringify, truncated to 200 chars>`
 * - undefined/null → omitted entirely
 *
 * Args are emitted in the order the model passed them (object insertion
 * order), so the line reads as the model wrote it.
 */
import { isPlainObject } from "./isPlainObject.ts";
import { sanitizeBackticks } from "./sanitizeBackticks.ts";
import { truncate } from "./truncate.ts";

const valueCharLimit = 200;

export function formatToolArgs(args: unknown): string {
  if (!isPlainObject(args)) return "";
  const parts: string[] = [];
  for (const [key, value] of Object.entries(args)) {
    const rendered = renderValue(value);
    if (rendered === null) continue;
    parts.push(`${key}=${rendered}`);
  }
  return parts.join(" ");
}

function renderValue(value: unknown): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "string") {
    return `"${truncate(safe(value), valueCharLimit)}"`;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    serialized = String(value);
  }
  return truncate(sanitizeBackticks(serialized), valueCharLimit);
}

function safe(value: string): string {
  return sanitizeBackticks(value).replace(/\n/g, " ");
}
