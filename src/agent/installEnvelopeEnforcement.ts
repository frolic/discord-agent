/**
 * The "envelope tool" rule: every visible reply must come from a call to
 * `send` / `react` / `thread`. Raw assistant text is never rendered to
 * the user.
 *
 * This installs the full enforcement loop on a session — classify each
 * turn, retry once with a system-prompt nudge if the model goes silent,
 * fall back to posting the raw text with a prefix if even the retry is
 * silent, and abort the session if it gets stuck in a `send`-only loop.
 *
 * Per-run retry state (whether a retry is pending, whether one was
 * already attempted) lives inside the closure here. The runaway counter
 * has its own closure (see `createRunawayCounter`) so this module is the
 * single classifier and the counter is the single state owner.
 */
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import type { MessageSender } from "../io/createMessageSender.ts";
import { isAssistantTurnMessage, type AssistantTurnMessage } from "./isAssistantTurnMessage.ts";
import { createRunawayCounter, type RunawayCounter } from "./createRunawayCounter.ts";
import { sendFallbackForSilentTurn } from "./sendFallbackForSilentTurn.ts";
import { deliveryToolNameSet } from "./deliveryTools.ts";
import { harnessReminderSuffix, harnessReminderWithContent } from "./prompts.ts";

export function installEnvelopeEnforcement(args: {
  session: AgentSession;
  sender: MessageSender;
}): void {
  const { session, sender } = args;
  const runaway: RunawayCounter = createRunawayCounter(session);

  // Per-agent-run state. Reset on agent_start; signal flows turn_end → agent_end.
  let pendingRetry = false;
  let retryCount = 0;
  let droppedText: string | null = null;
  const maxRetries = 2;

  session.subscribe(function onSessionEvent(event) {
    if (event.type === "agent_start") {
      runaway.reset();
      pendingRetry = false;
      retryCount = 0;
      droppedText = null;
      return;
    }
    if (event.type === "turn_end") {
      if (!isAssistantTurnMessage(event.message)) return;
      classifyTurn(event.message);
      return;
    }
    if (event.type === "agent_end" && pendingRetry) {
      pendingRetry = false;
      const textToDeliver = droppedText;
      // setTimeout(0) defers until activeRun clears — agent.continue() throws otherwise.
      setTimeout(() => {
        retryWithReminder(session, textToDeliver).catch((error) =>
          console.error("[harness] reminder continue failed:", error),
        );
      }, 0);
    }
  });

  function classifyTurn(message: AssistantTurnMessage): void {
    if (message.stopReason === "error" && message.errorMessage) {
      sender
        .sendError(new Error(message.errorMessage))
        .catch((error) => console.error("[harness] sendError failed:", error));
      return;
    }
    if (message.stopReason === "aborted") return;

    const toolCalls = message.content.filter((part) => part.type === "toolCall");
    const delivered = toolCalls.some(
      (call) => call.name !== undefined && deliveryToolNameSet.has(call.name),
    );
    const calledOther = toolCalls.some(
      (call) => call.name !== undefined && !deliveryToolNameSet.has(call.name),
    );

    if (delivered) {
      runaway.recordTurn(toolCalls);
      return;
    }
    if (calledOther) {
      runaway.reset();
      return;
    }

    // Silent turn — model emitted raw text without using any tool.
    const rawText = message.content
      .filter((part) => part.type === "text")
      .map((part) => part.text ?? "")
      .join("\n")
      .trim();

    if (retryCount >= maxRetries) {
      sendFallbackForSilentTurn({ message, sender });
      return;
    }
    // Capture the dropped text so the retry prompt can include it.
    // On the first failure we have the original text; on subsequent
    // failures we keep whichever is longer (the model may have
    // regenerated a shorter stub on retry).
    if (!droppedText || rawText.length > droppedText.length) {
      droppedText = rawText;
    }
    pendingRetry = true;
    retryCount += 1;
  }
}

/**
 * Retry: drop the dangling assistant turn (continue() requires
 * last-message to be user|toolResult), splice an in-prompt nudge for this
 * single continue() call, then restore the prompt. The augmentation never
 * persists to session.jsonl — followUp() would, and that makes the model
 * apologize on retry.
 *
 * When droppedText is available, the reminder includes the model's own
 * text so it can wrap it in send() calls with proper splitting and
 * formatting instead of regenerating from scratch.
 */
async function retryWithReminder(session: AgentSession, droppedText: string | null): Promise<void> {
  const messages = session.agent.state.messages;
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return;
  session.agent.state.messages = messages.slice(0, -1);

  const suffix = droppedText && droppedText.length > 0
    ? harnessReminderWithContent(droppedText)
    : harnessReminderSuffix;

  const original = session.agent.state.systemPrompt;
  session.agent.state.systemPrompt = `${original}${suffix}`;
  try {
    await session.agent.continue();
  } finally {
    session.agent.state.systemPrompt = original;
  }
}
