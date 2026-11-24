/**
 * Per-message delivery reminder.
 *
 * The system prompt already says "replies are tool calls", and the model still
 * writes prose a few turns in — the instruction is hundreds of messages back by
 * then, while the newest user message is right in front of it. So the rule rides
 * along with each inbound message instead of only living in the system prompt.
 *
 * Cache safety: this is appended to the *newest* user message, which is the part
 * of the context that was never cacheable anyway. The stable prefix (system
 * prompt + earlier turns) is byte-identical, so prefix caching keeps working —
 * appending to the end of the conversation is the one place you can add text for
 * free.
 *
 * Kept short on purpose: it repeats on every message, so it costs tokens per
 * turn forever.
 */
import type { ChatMode } from "./chatMode.ts";

/** The reminder, or `""` when the mode has nothing to remind about. */
export function deliveryHint(mode: ChatMode): string {
  if (mode !== "tools") return "";
  return "\n\n[harness] Deliver the reply with `send_message`. Assistant prose is not shown to the user and will be rejected.";
}

export function withDeliveryHint(text: string, mode: ChatMode): string {
  const hint = deliveryHint(mode);
  if (hint.length === 0) return text;
  return `${text}${hint}`;
}
