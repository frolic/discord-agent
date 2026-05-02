/**
 * Build the "· 6.8k/128k → 340 · $0.0012" suffix for a tool call's debug
 * line in the debug channel. Returns "" when no usage was recorded for
 * that tool call (sibling tool calls in a batch share the cost — only
 * the first one in the batch carries the usage display).
 */
import type { CallUsageDisplay } from "./CallUsageDisplay.ts";

export function formatToolUsage(
  toolCallId: string,
  toolToUsage: Map<string, CallUsageDisplay>,
): string {
  const usage = toolToUsage.get(toolCallId);
  if (!usage) return "";
  if (!usage.costStr) return ` · ${usage.tokensStr}`;
  return ` · ${usage.tokensStr} · ${usage.costStr}`;
}
