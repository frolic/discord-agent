/**
 * Wire a session's assistant text deltas to a streaming Discord dispatcher.
 *
 * One dispatcher per text content block — each new contentIndex starts a
 * fresh dispatcher (and a fresh chain of Discord messages). This means:
 *
 *   - text → tool → text produces two distinct Discord message chains
 *     visually, with the tool call sitting between them as a logical
 *     pause.
 *   - The FIRST text block of an agent run threads its initial message
 *     under the user message that woke the agent (when known); later
 *     blocks don't, so a multi-step turn doesn't repeat the reply badge.
 *
 * Replaces `installEnvelopeEnforcement`. The "envelope" is now the
 * assistant text stream itself; raw text IS the visible reply.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DiscordSender } from "../io/createDiscordSender.ts";
import type { StreamingDispatcher } from "../streaming/createStreamingDispatcher.ts";

export function installStreamingSender(args: {
  session: AgentSession;
  sender: DiscordSender;
  /**
   * Returns the Discord message ID the FIRST streamed message of this
   * run should reply-thread under, or undefined for synthetic wakes
   * (restart prompts, !clear notices) with no real user message target.
   */
  getReplyTarget: () => string | undefined;
}): void {
  const { session, sender, getReplyTarget } = args;

  let currentDispatcher: StreamingDispatcher | null = null;
  let currentContentIndex: number | null = null;
  // Reset on agent_start; cleared once the first text-block dispatcher
  // opens so subsequent blocks don't repeat the reply badge.
  let isFirstTextOfRun = true;
  // Serialize closes so a draining `end()` settles before the next
  // dispatcher's first post lands on the shared writeChain.
  let closeChain: Promise<unknown> = Promise.resolve();

  function closeCurrent(): void {
    if (!currentDispatcher) return;
    const dispatcher = currentDispatcher;
    currentDispatcher = null;
    currentContentIndex = null;
    closeChain = closeChain
      .then(() => dispatcher.end())
      .catch((error) => console.error("[stream] dispatcher close failed:", error));
  }

  function openForBlock(contentIndex: number): StreamingDispatcher {
    closeCurrent();
    const inReplyTo = isFirstTextOfRun ? getReplyTarget() : undefined;
    isFirstTextOfRun = false;
    const dispatcher = sender.openStream({ inReplyTo });
    currentDispatcher = dispatcher;
    currentContentIndex = contentIndex;
    return dispatcher;
  }

  session.subscribe((event) => {
    if (event.type === "agent_start") {
      isFirstTextOfRun = true;
      return;
    }
    if (event.type === "agent_end") {
      closeCurrent();
      return;
    }
    if (event.type === "message_end") {
      closeCurrent();
      return;
    }
    if (event.type === "turn_end") {
      const message = event.message;
      if (
        typeof message === "object" &&
        message !== null &&
        "role" in message &&
        message.role === "assistant"
      ) {
        const stopReason = (message as { stopReason?: string }).stopReason;
        const errorMessage = (message as { errorMessage?: string }).errorMessage;
        if (stopReason === "error" && errorMessage) {
          // Log to journal too — the channel-side "agent error" line is
          // easy to miss (no debug-channel copy, no stderr) so operators
          // digging into `journalctl -u …` after the fact see nothing.
          // Include provider/model for post-mortem: 401/403s here almost
          // always trace back to a specific provider's credential or a
          // stale models.json format (e.g. the pi 0.79→0.84 config-value
          // syntax change).
          const provider = (message as { provider?: string }).provider;
          const model = (message as { model?: string }).model;
          const modelTag = provider || model ? ` [${provider ?? "?"}/${model ?? "?"}]` : "";
          console.error(`[stream] agent turn errored${modelTag}: ${errorMessage}`);
          sender
            .sendError(new Error(errorMessage))
            .catch((error) => console.error("[stream] sendError failed:", error));
        }
      }
      return;
    }
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      if (ame.type === "text_delta") {
        const dispatcher =
          currentContentIndex === ame.contentIndex && currentDispatcher
            ? currentDispatcher
            : openForBlock(ame.contentIndex);
        dispatcher.append(ame.delta);
      } else if (ame.type === "text_end") {
        if (currentContentIndex === ame.contentIndex) closeCurrent();
      } else if (ame.type === "error") {
        // Close any open dispatcher so already-streamed content flushes;
        // turn_end will surface the error message itself.
        closeCurrent();
      }
    }
  });
}
