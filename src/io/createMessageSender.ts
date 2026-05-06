/**
 * Outbound user-channel I/O. Owns everything related to *posting messages
 * the user sees*: the `send` tool's actual write path, error surfacing,
 * and the silent-turn fallback. Does NOT touch the debug channel (operational
 * logging) or the typing indicator — those are in their own modules so
 * each consumer can declare exactly the surface it depends on.
 *
 * Sends are serialized through a FIFO chain so multi-message replies
 * arrive in order even when several are dispatched concurrently —
 * Discord's REST will return success out of order otherwise. The chain
 * swallows upstream errors so a single failed send doesn't permanently
 * break delivery for the channel.
 */
import type { Client, Message, SendableChannels } from "discord.js";
import { buildAttachments } from "./buildAttachments.ts";
import { buildSendPayload } from "./buildSendPayload.ts";
import { fetchSendableChannel } from "./fetchSendableChannel.ts";

/** Discord's per-message character cap is 2000; we leave a small margin. */
const hardCharLimit = 1990;

interface SendResult {
  success: boolean;
  messageId?: string;
  length: number;
}

interface SendOptions {
  text: string;
  files?: string[];
  /** Discord message ID to thread this reply under via `message.reply()`. */
  inReplyTo?: string;
}

export interface MessageSender {
  /** Send `text` (and optional file attachments) to the user channel as one or more Discord messages. Returns the last sent message's ID. */
  send(options: SendOptions): Promise<SendResult>;
  /** Surface an unexpected error directly to the user channel. Used when the agent loop throws outside a normal turn. */
  sendError(error: unknown): Promise<void>;
  /** Last-resort: post raw assistant text with a "[harness fallback]" prefix when the model refused to use the `send` tool even after a retry. */
  sendFallback(rawText: string): Promise<void>;
}

export function createMessageSender(args: { client: Client; channelId: string }): MessageSender {
  const { client, channelId } = args;
  let sendChain: Promise<unknown> = Promise.resolve();

  function getChannel(): Promise<SendableChannels | null> {
    return fetchSendableChannel(client, channelId);
  }

  async function doSend(options: SendOptions): Promise<SendResult> {
    const { text, files = [], inReplyTo } = options;
    const channel = await getChannel();
    if (!channel) return { success: false, length: text.length };

    const attachments = await buildAttachments(files);
    const content = text.trim().slice(0, hardCharLimit);
    if (content.length === 0 && attachments.length === 0) {
      return { success: false, length: 0 };
    }

    const sentMessage = await channel
      .send(buildSendPayload({ content, attachments, isFirstSection: true, inReplyTo }))
      .catch((error) => {
        console.error("[sender] message send failed:", error);
        return null;
      });

    return {
      success: sentMessage !== null,
      messageId: sentMessage?.id,
      length: text.length,
    };
  }

  function send(options: SendOptions): Promise<SendResult> {
    const result = sendChain.then(() => doSend(options));
    // Catch on the chain reference so an upstream failure doesn't break
    // serialization. The original `result` is returned so the caller still
    // observes the error (and logs it via doSend), so just swallow here.
    sendChain = result.catch((error) =>
      console.error("[sender] send chain settled with error:", error),
    );
    return result;
  }

  async function sendError(error: unknown): Promise<void> {
    const channel = await getChannel();
    if (!channel) return;
    const message = error instanceof Error ? error.message : String(error);
    const text = `**agent error**: ${message.slice(0, 1900)}`;
    await channel
      .send({ content: text })
      .catch((error) => console.error("[sender] error send failed:", error));
  }

  async function sendFallback(rawText: string): Promise<void> {
    const note = "*[harness fallback: model didn't use the `send` tool]*";
    await send({ text: `${note}\n${rawText}` });
  }

  return { send, sendError, sendFallback };
}
