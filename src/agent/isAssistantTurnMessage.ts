/**
 * The shape of `turn_end.message` when the turn was an assistant turn. The
 * pi event types are wide; this narrow shape captures only what the harness
 * inspects (stop reason, tool calls, raw text content for fallback).
 */
export interface AssistantTurnMessage {
  role: "assistant";
  stopReason?: string;
  errorMessage?: string;
  content: { type: string; name?: string; text?: string }[];
}

export function isAssistantTurnMessage(value: unknown): value is AssistantTurnMessage {
  if (value === null || typeof value !== "object") return false;
  if (!("role" in value) || value.role !== "assistant") return false;
  if (!("content" in value) || !Array.isArray(value.content)) return false;
  return true;
}
