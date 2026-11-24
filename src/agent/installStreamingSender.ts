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
 * Replaces `installEnvelopeEnforcement`. In stream mode the "envelope" is the
 * assistant text stream itself; raw text IS the visible reply.
 *
 * In `CHAT_MODE=tools` assistant text is not the delivery path any more — replies
 * go through `send_message` (see `createSendMessageDelivery.ts`) — so no
 * dispatcher is opened for text. What still belongs here in that mode:
 *
 * - **turn errors** are surfaced the same way (they are harness output, not
 *   assistant prose, and silence would look like a hung agent);
 * - **agent_end** still closes anything left open;
 * - **stray text** — assistant prose in a mode where prose goes nowhere — is
 *   posted to the debug channel rather than dropped. Dropping it would make a
 *   model that forgot to call a tool look like it never answered.
 */
import type { Client } from "discord.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DiscordSender } from "../io/createDiscordSender.ts";
import { postDebugLine } from "../io/postDebugLine.ts";
import type { StreamingDispatcher } from "../streaming/createStreamingDispatcher.ts";
import type { ChatMode } from "./chatMode.ts";

/** How much stray prose reaches the log channel — the point is that it exists, not its full text. */
const strayTextLimit = 1600;

export function installStreamingSender(args: {
  session: AgentSession;
  sender: DiscordSender;
  /**
   * Returns the Discord message ID the FIRST streamed message of this
   * run should reply-thread under, or undefined for synthetic wakes
   * (restart prompts, !clear notices) with no real user message target.
   */
  getReplyTarget: () => string | undefined;
  /** Delivery path for assistant text. See `agent/chatMode.ts`. */
  mode: ChatMode;
  /** Only used to post stray tools-mode prose to the debug channel. */
  client: Client;
  channelId: string;
}): void {
  const { session, sender, getReplyTarget, mode, client, channelId } = args;

  /** Tools-mode prose that nobody will read unless we log it. */
  async function postStrayText(text: string): Promise<void> {
    const body =
      text.length > strayTextLimit ? `${text.slice(0, strayTextLimit)}… (truncated)` : text;
    await postDebugLine({
      client,
      content: `-# 💬 stray tools-mode text in <#${channelId}> — NOT delivered to the user\n${body}`,
    });
  }

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
      if (mode === "tools") {
        // No text dispatcher in this mode: the streamed reply path is
        // `send_message`'s argument stream (createSendMessageDelivery.ts).
        if (ame.type === "text_end" && ame.content.trim().length > 0) {
          void postStrayText(ame.content).catch((error) =>
            console.error("[stream] stray-text log failed:", error),
          );
        }
        return;
      }
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
