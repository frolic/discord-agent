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
import { harnessReminderSuffix } from "./prompts.ts";

export function installEnvelopeEnforcement(args: {
  session: AgentSession;
  sender: MessageSender;
}): void {
  const { session, sender } = args;
  const runaway: RunawayCounter = createRunawayCounter(session);

  // Per-agent-run state. Reset on agent_start; signal flows turn_end → agent_end.
  let pendingRetry = false;
  let alreadyRetried = false;

  session.subscribe(function onSessionEvent(event) {
    if (event.type === "agent_start") {
      runaway.reset();
      pendingRetry = false;
      alreadyRetried = false;
      return;
    }
    if (event.type === "turn_end") {
      if (!isAssistantTurnMessage(event.message)) return;
      classifyTurn(event.message);
      return;
    }
    if (event.type === "agent_end" && pendingRetry) {
      pendingRetry = false;
      // setTimeout(0) defers until activeRun clears — agent.continue() throws otherwise.
      setTimeout(() => {
        retryWithReminder(session).catch((error) =>
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
    if (alreadyRetried) {
      sendFallbackForSilentTurn({ message, sender });
      return;
    }
    pendingRetry = true;
    alreadyRetried = true;
  }
}

/**
 * One-shot retry: drop the dangling assistant turn (continue() requires
 * last-message to be user|toolResult), splice an in-prompt nudge for this
 * single continue() call, then restore the prompt. The augmentation never
 * persists to session.jsonl — followUp() would, and that makes the model
 * apologize on retry.
 */
async function retryWithReminder(session: AgentSession): Promise<void> {
  const messages = session.agent.state.messages;
  const lastMessage = messages[messages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return;
  session.agent.state.messages = messages.slice(0, -1);

  const original = session.agent.state.systemPrompt;
  session.agent.state.systemPrompt = `${original}${harnessReminderSuffix}`;
  try {
    await session.agent.continue();
  } finally {
    session.agent.state.systemPrompt = original;
  }
}
