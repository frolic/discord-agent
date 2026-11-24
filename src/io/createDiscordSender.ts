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
import { chunkRendered } from "../streaming/chunkRendered.ts";
import { prepareForDelivery } from "../streaming/prepareForDelivery.ts";
import { buildAttachments } from "./buildAttachments.ts";
import { fetchSendableChannel } from "./fetchSendableChannel.ts";
import {
  createStreamingDispatcher,
  type StreamingDispatcher,
} from "../streaming/createStreamingDispatcher.ts";

/** Discord's per-message cap is 2000; leave a small margin. */
const hardCharLimit = 1990;

export interface OpenStreamOptions {
  /** Discord message ID this stream's first message should reply-thread under. */
  inReplyTo?: string;
}

export interface SendTextOptions {
  /** Raw model markdown. Rendered and chunked exactly as the streamed path does. */
  text: string;
  /** Discord message ID the FIRST chunk should reply-thread under. */
  inReplyTo?: string;
}

export interface SendTextResult {
  /** IDs of the messages that landed, in order. Empty when nothing was posted. */
  messageIds: readonly string[];
  /** True when at least one chunk failed to post (the list is then incomplete). */
  partial: boolean;
}

export interface EditTextResult {
  ok: boolean;
  /** Length of the rendered payload Discord would receive. */
  renderedLength: number;
  error?: string;
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
   * Post a finished text reply as one or more messages. Same markdown rendering
   * and chunking as `openStream`, for the non-streaming delivery path (the
   * `send_message` tool when nothing was streamed).
   */
  sendText(options: SendTextOptions): Promise<SendTextResult>;
  /**
   * Replace the whole content of one already-posted message. Refuses (rather
   * than truncating) when the rendered text would exceed Discord's limit.
   */
  editText(messageId: string, text: string): Promise<EditTextResult>;
  /**
   * Delete a message this bot posted. Only used to clean up a superseded
   * streamed preview.
   */
  deleteMessage(messageId: string): Promise<void>;
  /**
   * Surface an unexpected error directly to the user channel. Used when
   * the agent loop throws outside a normal turn.
   */
  sendError(error: unknown): Promise<void>;
  /**
   * Post a harness-authored progress line ("still running · 45s"). Comes from
   * the progress watchdog, not from the model, so it works in both chat modes
   * and cannot be swallowed by a forgotten `send_message`.
   */
  sendWatchdogNote(args: { toolName: string; elapsedSeconds: number }): Promise<void>;
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

  async function sendWatchdogNote(args: {
    toolName: string;
    elapsedSeconds: number;
  }): Promise<void> {
    const minutes = Math.floor(args.elapsedSeconds / 60);
    const elapsed =
      minutes >= 1 ? `${minutes}m${String(args.elapsedSeconds % 60).padStart(2, "0")}s` : `${args.elapsedSeconds}s`;
    await enqueue(() => postMessage({ content: `-# ⏳ \`${args.toolName}\` still running · ${elapsed}` }));
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

  async function sendText(options: SendTextOptions): Promise<SendTextResult> {
    const chunks = chunkRendered(prepareForDelivery(options.text), { hardLimit: hardCharLimit });
    const messageIds: string[] = [];
    for (const [index, chunk] of chunks.entries()) {
      const message = await enqueue(() =>
        postMessage({ content: chunk, inReplyTo: index === 0 ? options.inReplyTo : undefined }),
      );
      if (!message) return { messageIds, partial: true };
      messageIds.push(message.id);
    }
    return { messageIds, partial: false };
  }

  async function editText(messageId: string, text: string): Promise<EditTextResult> {
    const rendered = prepareForDelivery(text).rendered;
    if (rendered.trim().length === 0) {
      return { ok: false, renderedLength: 0, error: "refusing to edit a message to empty content" };
    }
    if (rendered.length > hardCharLimit) {
      return {
        ok: false,
        renderedLength: rendered.length,
        error: `rendered content is ${rendered.length} chars, over the ${hardCharLimit} char limit — send it as a new message instead`,
      };
    }
    await enqueue(() => editMessage(messageId, rendered));
    return { ok: true, renderedLength: rendered.length };
  }

  async function deleteMessage(messageId: string): Promise<void> {
    await enqueue(async () => {
      const channel = await getChannel();
      if (!channel) return;
      await channel.messages.delete(messageId).catch((error) => {
        console.error(`[sender] delete message ${messageId} failed:`, error);
      });
    });
  }

  function openStream(options: OpenStreamOptions): StreamingDispatcher {
    let isFirstPost = true;
    return createStreamingDispatcher({
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
      deleteMessage,
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

  return { openStream, sendText, editText, deleteMessage, attach, sendError, sendWatchdogNote };
}
