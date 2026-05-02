/**
 * After the silent-turn limit is hit, give up on the harness-reminder retry
 * and just deliver the model's raw text via the sender's fallback path.
 * This is a last resort — the user gets a "[harness fallback: …]" prefix
 * so they know the model didn't use the proper delivery tool.
 */
import type { MessageSender } from "../io/createMessageSender.ts";
import type { AssistantTurnMessage } from "./isAssistantTurnMessage.ts";

export function sendFallbackForSilentTurn(args: {
  message: AssistantTurnMessage;
  sender: MessageSender;
}): void {
  const rawText = args.message.content
    .filter((part) => part.type === "text")
    .map((part) => part.text ?? "")
    .join("\n")
    .trim();
  if (rawText.length === 0) return;
  args.sender
    .sendFallback(rawText)
    .catch((error) => console.error("[harness] sendFallback failed:", error));
}
