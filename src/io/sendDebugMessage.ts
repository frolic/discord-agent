/**
 * Single send primitive for the debug channel. Bakes in:
 *
 *   - `SUPPRESS_EMBEDS` so URL preview cards don't clutter the log
 *     (debug entries link to Discord messages, tool args may include
 *     external URLs).
 *   - The `failIfNotExists: false` reply fallback so a deleted target
 *     message demotes the post to a regular one instead of failing.
 *   - A single catch-log path with caller-supplied context, so a failure
 *     in any debug-write logs once with enough info to find the call site.
 *
 * Returns the resulting `Message`, or `null` on send failure. Callers
 * that need the ID (for threading a follow-up reply) use `result?.id`;
 * fire-and-forget callers can ignore the return.
 */
import { MessageFlags, type Message, type SendableChannels } from "discord.js";

export async function sendDebugMessage(args: {
  channel: SendableChannels;
  content: string;
  replyTo?: string;
  /** Surfaces in the error log so the failing call site is identifiable. */
  errorContext: string;
}): Promise<Message | null> {
  const payload: Parameters<typeof args.channel.send>[0] = {
    content: args.content,
    flags: MessageFlags.SuppressEmbeds,
  };
  if (args.replyTo) {
    (payload as { reply?: { messageReference: string; failIfNotExists: false } }).reply = {
      messageReference: args.replyTo,
      failIfNotExists: false,
    };
  }
  return args.channel.send(payload).catch((error) => {
    console.error(`[debugLogger] ${args.errorContext}:`, error);
    return null;
  });
}
