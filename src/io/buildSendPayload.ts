/**
 * Build the per-section payload for `channel.send`. Attachments piggyback on
 * the first section because Discord allows attachments only on send, not
 * edit — splitting them across sections would lose them on retries. The
 * Discord-reply target also rides only on the first section, so a multi-
 * part reply doesn't repeat the threaded-reply badge on every continuation.
 *
 * `failIfNotExists: false` means a stale or deleted target message demotes
 * the reply to a regular message instead of failing the whole send.
 *
 * Empty content is allowed when files are present (attachment-only message).
 */
import type { AttachmentBuilder } from "discord.js";

interface SendPayload {
  content?: string;
  files: AttachmentBuilder[];
  reply?: {
    messageReference: string;
    failIfNotExists: false;
  };
}

export function buildSendPayload(args: {
  content: string;
  attachments: AttachmentBuilder[];
  isFirstSection: boolean;
  inReplyTo?: string;
}): SendPayload {
  const payload: SendPayload = {
    files: args.isFirstSection ? args.attachments : [],
  };
  if (args.content.length > 0) {
    payload.content = args.content;
  }
  if (args.isFirstSection && args.inReplyTo) {
    payload.reply = {
      messageReference: args.inReplyTo,
      failIfNotExists: false,
    };
  }
  return payload;
}
