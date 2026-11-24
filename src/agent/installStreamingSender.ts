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
 *   **rejected**: the turn is aborted, the prose goes to the debug channel, and
 *   the channel gets one short line saying the reply was not delivered. Logging
 *   it and letting the turn continue was not enough: the model would happily
 *   write a full reply that nobody saw, look successful, and only show up as a
 *   💬 line in a channel the user isn't reading. Aborting makes the mistake
 *   unmissable to both sides — the model's next turn sees the abort, and the
 *   user sees that something was rejected instead of seeing silence.
 */
import type { Client } from "discord.js";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DiscordSender } from "../io/createDiscordSender.ts";
import { postDebugLine } from "../io/postDebugLine.ts";
import type { StreamingDispatcher } from "../streaming/createStreamingDispatcher.ts";
import type { ChatMode } from "./chatMode.ts";
import type { ChatDelivery } from "./chatDelivery.ts";

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
  /**
   * Tracks whether this run already delivered something. A model that calls
   * `send_message` and then appends "Sent." has answered; aborting it would post
   * a "reply rejected" notice for a reply the user is looking at.
   */
  chatDelivery: ChatDelivery | null;
}): void {
  const { session, sender, getReplyTarget, mode, client, channelId, chatDelivery } = args;

  // How many times this run has been caught writing prose instead of replying.
  // Reset whenever something actually gets delivered, so a model that behaves
  // for a while gets its retry budget back.
  let strayCount = 0;
  // The last rejected body, in case the retry also fails and the answer would
  // otherwise be lost.
  let lastRejectedText = "";

  /**
   * Tools-mode prose. Two very different situations share one event stream:
   *
   * - nothing has been delivered this run → the model "replied" in a channel
   *   that doesn't exist. Abort, log, tell the user something was refused.
   * - something WAS delivered → the prose is trailing chatter ("Sent.", "Done.")
   *   after a real reply. Log it; never abort a turn the user already got.
   */
  async function handleStrayText(text: string): Promise<void> {
    const body =
      text.length > strayTextLimit ? `${text.slice(0, strayTextLimit)}… (truncated)` : text;

    // Answered and *then* narrated ("Sent.", a reworded second draft). Nothing to
    // recover — log it and leave the turn alone.
    if (chatDelivery?.deliveredThisRun() === true) {
      strayCount = 0;
      await postDebugLine({
        client,
        content: `-# 💬 tools-mode chatter after delivery in <#${channelId}> — logged, not delivered\n${body}`,
      });
      return;
    }

    lastRejectedText = text;
    strayCount += 1;
    await postDebugLine({
      client,
      content: `-# 💬 REJECTED tools-mode prose in <#${channelId}> — nothing was delivered (attempt ${strayCount})\n${body}`,
    });

    // Nothing reached the user. Refusing the behaviour must not cost the answer,
    // so: abort, then make the model deliver the same reply through the tool.
    // No notice in the channel — the user should just get their answer.
    if (strayCount === 1) {
      retryDelivery();
      return;
    }

    // The retry produced prose too. Deliver what it wrote rather than losing the
    // answer; the debug channel already records that this was a fallback.
    await sender.sendText({ text: lastRejectedText }).catch((error) =>
      console.error("[stream] fallback delivery failed:", error),
    );
    await postDebugLine({
      client,
      content: `-# ⚠️ tools-mode retry failed in <#${channelId}> — delivered the prose unchanged`,
    });
  }

  /**
   * Abort the failed turn and ask the model for the same reply, this time through
   * `send_message`. Deferred out of the event handler: aborting and re-prompting
   * from inside a `message_update` callback re-enters the session mid-event.
   */
  function retryDelivery(): void {
    setTimeout(() => {
      void (async () => {
        await session
          .abort()
          .catch((error) => console.error("[stream] abort before retry failed:", error));
        await session
          .prompt(
            "HARNESS: the previous turn was aborted. You wrote the reply as assistant prose, which this mode does not deliver, so the user saw nothing. " +
              "Deliver that reply now by calling send_message with it. Do not write it as prose, do not summarise it, and do not comment on this instruction.",
          )
          .catch((error) => console.error("[stream] retry prompt failed:", error));
      })();
    }, 0);
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
      chatDelivery?.resetDelivered();
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
          void handleStrayText(ame.content).catch((error) =>
            console.error("[stream] stray-text handling failed:", error),
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
