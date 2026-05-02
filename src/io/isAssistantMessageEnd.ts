/**
 * Type guard for the `message_end` event payload when the message was an
 * assistant message. The pi event type is wide; this narrow shape captures
 * what the renderer reads for usage attribution.
 */
import { isPlainObject } from "./isPlainObject.ts";

interface AssistantUsage {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number;
  cost: { total: number };
}

export interface AssistantMessageEnd {
  role: "assistant";
  content?: { type: string; id?: string }[];
  usage?: AssistantUsage;
}

export function isAssistantMessageEnd(value: unknown): value is AssistantMessageEnd {
  if (!isPlainObject(value)) return false;
  return value.role === "assistant";
}
