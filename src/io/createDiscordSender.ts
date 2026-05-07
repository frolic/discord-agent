/**
 * Outbound user-channel I/O. Owns everything related to *posting messages
 * the user sees*: streamed text replies, file-attachment one-shots, and
 * error surfacing. Does NOT touch the debug channel (operational logging)
 * or the typing indicator — those live in their own modules so each
 * consumer declares only the surface it depends on.
 *
 * Streaming flow: `openStream` returns a `StreamingDispatcher` whose
 * `post`/`edit` callbacks land here, where they go through a single FIFO
 * chain shared with one-shot writes (attachments, errors). Discord's REST
 * endpoint settles concurrent requests out of order; chaining keeps the
 * displayed message monotonic.
 *
 * Replaces the previous `MessageSender` whose `send` was driven by an
 * envelope tool. Now the envelope is the assistant text stream itself.
 */
import type { AttachmentBuilder, Client, Message, SendableChannels } from "discord.js";
import { buildAttachments } from "./buildAttachments.ts";
import { fetchSendableChannel } from "./fetchSendableChannel.ts";
import {
  createStreamingDispatcher,
  type StreamingDispatcher,
} from "../streaming/createStreamingDispatcher.ts";

/** Discord's per-message cap is 2000; leave a small margin. */
const hardCharLimit = 1990;
/** Try to seal at a paragraph seam by this size. Picked to leave room for
 * the seal-edit itself plus a delta racing in during the seal. */
const softCharLimit = 1700;

export interface OpenStreamOptions {
  /** Discord message ID this stream's first message should reply-thread under. */
  inReplyTo?: string;
}

export interface AttachOptions {
  content?: string;
  files: string[];
  inReplyTo?: string;
}

export interface AttachResult {
  success: boolean;
  messageId: string | undefined;
}

export interface DiscordSender {
  /**
   * Open a streaming dispatcher for one logical text block. Closing it
   * (`end()`) flushes the buffer; opening another starts a fresh chain
   * of Discord messages with no reply-thread to the original target.
   */
  openStream(options: OpenStreamOptions): StreamingDispatcher;
  /**
   * Post a one-shot message with file attachments. Used by the `attach`
   * tool — text streaming covers the common case so this is for files.
   */
  attach(options: AttachOptions): Promise<AttachResult>;
  /**
   * Surface an unexpected error directly to the user channel. Used when
   * the agent loop throws outside a normal turn.
   */
  sendError(error: unknown): Promise<void>;
}

export function createDiscordSender(args: { client: Client; channelId: string }): DiscordSender {
  const { client, channelId } = args;
  // Single FIFO chain across all writes so the user-visible order matches
  // emit order even when streaming + attachments interleave.
  let writeChain: Promise<unknown> = Promise.resolve();

  function getChannel(): Promise<SendableChannels | null> {
    return fetchSendableChannel(client, channelId);
  }

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const result = writeChain.then(operation);
    writeChain = result.catch((error) =>
      console.error("[sender] write chain settled with error:", error),
    );
    return result;
  }

  async function postMessage(args: {
    content?: string;
    files?: AttachmentBuilder[];
    inReplyTo?: string;
  }): Promise<Message | null> {
    const channel = await getChannel();
    if (!channel) return null;
    const trimmed = args.content?.slice(0, hardCharLimit);
    if ((!trimmed || trimmed.length === 0) && (!args.files || args.files.length === 0)) {
      return null;
    }
    const payload: Parameters<typeof channel.send>[0] = {
      files: args.files ?? [],
    };
    if (trimmed && trimmed.length > 0) (payload as { content?: string }).content = trimmed;
    if (args.inReplyTo) {
      (payload as { reply?: { messageReference: string; failIfNotExists: false } }).reply = {
        messageReference: args.inReplyTo,
        failIfNotExists: false,
      };
    }
    return channel.send(payload).catch((error) => {
      console.error("[sender] message send failed:", error);
      return null;
    });
  }

  async function editMessage(messageId: string, content: string): Promise<void> {
    const channel = await getChannel();
    if (!channel) return;
    const trimmed = content.slice(0, hardCharLimit);
    const message = await channel.messages.fetch(messageId).catch((error) => {
      console.error(`[sender] fetch message ${messageId} failed:`, error);
      return null;
    });
    if (!message) return;
    await message.edit({ content: trimmed }).catch((error) => {
      console.error(`[sender] edit message ${messageId} failed:`, error);
    });
  }

  function openStream(options: OpenStreamOptions): StreamingDispatcher {
    let isFirstPost = true;
    return createStreamingDispatcher({
      softLimit: softCharLimit,
      hardLimit: hardCharLimit,
      post: async (content) => {
        const message = await enqueue(() =>
          postMessage({
            content,
            inReplyTo: isFirstPost ? options.inReplyTo : undefined,
          }),
        );
        isFirstPost = false;
        if (!message) return null;
        return { messageId: message.id };
      },
      edit: async (messageId, content) => {
        await enqueue(() => editMessage(messageId, content));
      },
    });
  }

  async function attach(options: AttachOptions): Promise<AttachResult> {
    const builders = await buildAttachments(options.files);
    const message = await enqueue(() =>
      postMessage({ content: options.content, files: builders, inReplyTo: options.inReplyTo }),
    );
    return { success: message !== null, messageId: message?.id };
  }

  async function sendError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error);
    const text = `**agent error**: ${message.slice(0, 1900)}`;
    await enqueue(() => postMessage({ content: text }));
  }

  return { openStream, attach, sendError };
}
