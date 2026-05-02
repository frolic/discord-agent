/**
 * "6.8k/128k → 340" — the per-tool-call token line shown as a suffix on
 * the audit-trail entry the renderer posts to the log channel. Format:
 *
 *   <total-context>/<context-window> → <output>
 *
 * `total-context` is `input + cacheRead` — the actual amount of context
 * the model received this call, which is what you want to watch creep
 * toward the window cap. The raw `input` (uncached portion only) is
 * misleading on its own and is dropped from the display; cost suffix is
 * appended separately by the caller.
 *
 * If the model's `contextWindow` is unknown (older provider snapshots,
 * etc.), falls back to bare total context with no `/cap`.
 */
import { formatTokens } from "./formatTokens.ts";

export function formatTokenLine(
  usage: { input: number; output: number; cacheRead: number },
  contextWindow?: number,
): string {
  const totalContext = usage.input + usage.cacheRead;
  const contextPart = contextWindow
    ? `${formatTokens(totalContext)}/${formatTokens(contextWindow)}`
    : formatTokens(totalContext);
  return `${contextPart} → ${formatTokens(usage.output)}`;
}
