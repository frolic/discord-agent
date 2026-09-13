/**
 * Render the debug-channel failure line for a failed tool result.
 *
 * Expecting a shell command to exit non-zero is a normal occurrence —
 * `grep` with no match, `diff` on differing files, `gh pr checks` while
 * checks are still pending. For the `bash` tool those show up as an
 * errored result whose message is `... Command exited with code N`
 * (`appendStatus` in pi's shell tool appends that suffix). Rendering
 * every one of those as `❌ bash failed: <full text>` makes the debug
 * channel look like the environment is on fire when it is just the
 * model shelling out and getting a conventional non-zero exit.
 *
 * When the result matches the exit-code pattern, emit a compact line:
 *
 *     bash → exit 1 · <bounded preview of the command's own output>
 *
 * Genuine failures — random exceptions, invalid arguments, tracebacks —
 * do not match the pattern and still render as a full `❌ <tool> …` line.
 */
import { truncate } from "./truncate.ts";
import { sanitizeBackticks } from "./sanitizeBackticks.ts";

const outputPreviewLimit = 120;

/** `…Command exited with code N` — the suffix pi's shell tools append. */
const exitCodePattern = /(?:Command exited with|Finished with|exit)(?: code)?\s*[:=]?\s*(\d+)/i;

export interface ToolFailureDetails {
  /** Exit code when the failure is a conventional non-zero shell exit. */
  exitCode: number | null;
  /** The full flattened error text (single-line, sanitized). */
  errorText: string;
  /** Shell output before the exit-code suffix, bounded and single-line. */
  outputPreview: string;
}

/**
 * Classify a failed tool result.
 *
 * `exitCode: null` means the failure is a genuine error (exception,
 * invalid args, …) and the caller should keep the standard ❌ rendering.
 */
export function describeToolFailure(result: unknown): ToolFailureDetails {
  const raw = extractRawText(result);
  const flattened = raw.replace(/\s*\n+\s*/g, " · ").replace(/( · )+$/, "");
  const match = flattened.match(exitCodePattern);

  if (!match) {
    return { exitCode: null, errorText: flattened, outputPreview: "" };
  }

  const exitCodeRaw: string | undefined = match[1];
  const exitCode = exitCodeRaw ? parseInt(exitCodeRaw, 10) : 0;
  const exitIndex = match.index;
  const bodyText: string = exitIndex !== undefined ? flattened.slice(0, exitIndex) : "";
  const preview = sanitizeBackticks(truncate(bodyText.replace(/( · )+$/, "").trimEnd(), outputPreviewLimit));
  return { exitCode, errorText: flattened, outputPreview: preview };
}

/**
 * One-line debug-channel rendering for a failed tool result. Bash
 * exit-code failures get a compact `bash → exit N` line; everything else
 * keeps the existing `❌ <tool> failed: …` shape.
 */
export function formatToolFailureLine(toolName: string, result: unknown): string {
  const details = describeToolFailure(result);
  if (details.exitCode !== null) {
    const previewTag = details.outputPreview.length > 0 ? ` · ${details.outputPreview}` : "";
    return `-# ${toolName} → exit ${details.exitCode}${previewTag}`;
  }
  return `-# ❌ ${toolName} failed: ${details.errorText}`;
}

function extractRawText(result: unknown): string {
  if (typeof result !== "object" || result === null) return "";
  const content = (result as { content?: unknown }).content;
  if (!Array.isArray(content)) return "";
  for (const part of content) {
    if (typeof part !== "object" || part === null) continue;
    const text = (part as { text?: unknown }).text;
    if (typeof text === "string" && text.length > 0) return text;
  }
  return "";
}