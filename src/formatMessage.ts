/**
 * Render a discord.js Message as the text the agent sees, shared between
 * the wake path (`pool.handle`) and the `history` tool.
 *
 * Header format (always one line):
 *   [user_id=<id> message_id=<id> created_at=<iso>[ edited_at=<iso>][ in_reply_to=<id>][ bot=true][ self=true][ attachments=<n>]] <username>: <content>
 *
 * For non-image attachments, one extra line per attachment follows the
 * header so the agent can fetch them via `bash curl`:
 *   attachment[<i>] (<mime>): <url>
 *
 * Image attachments are *not* listed in the header by default — they're
 * passed natively via `PromptOptions.images` on the wake path
 * (`collectImageAttachments` → pi-ai image content blocks). Listing image
 * URLs in the prompt text on top of that would be redundant: the model
 * already sees the image directly in its visible context. The
 * `includeImageUrls` option flips this back on for the `history` tool —
 * past messages aren't re-fetched with their image content re-injected,
 * so the URL is the only reference the agent has to past images.
 *
 * The header keeps a fixed field order — most-stable to least-stable
 * (user_id → message_id → created_at → edited_at → in_reply_to), then
 * situational flags (bot, self, attachments). Bracket = metadata;
 * "username: content" = the human-shaped record. Attachment URLs are
 * appended as plain lines (no leading bracket) so they don't get mistaken
 * for metadata.
 *
 * - `user_id`     — never changes. Use in `<@user_id>` to @-mention.
 * - `message_id`  — stable per message. Use for `react.message_id` and
 *                   `attach.in_reply_to`.
 * - `created_at`  — when the message was originally sent.
 * - `edited_at`   — when the user last edited it. Present iff edited; its
 *                   presence (combined with a content delta from the same
 *                   `message_id` earlier in history) is how the agent
 *                   recognizes an edit-as-steering event.
 * - `in_reply_to` — the message_id this message is a Discord reply to.
 *                   Lets the agent trace reply chains. The target may
 *                   already be in session history; if not, the agent can
 *                   fetch it with `history(around=<id>, limit=1)`.
 * - `bot=true`    — author is any bot account.
 * - `self=true`   — author is *this* bot. Implies `bot=true`. Lets the
 *                   agent tell its own past replies apart from other
 *                   bots' messages, since `bot=true` alone collapses the
 *                   two.
 * - `attachments=<n>` — number of files. Non-image URLs follow on
 *                   `attachment[i]` lines; image attachments are passed
 *                   separately as native image content on the wake path
 *                   (see `collectImageAttachments`).
 *
 * `selfUserId` is passed in (rather than read from a global) so the
 * function stays pure — the only Discord state it touches is what's on
 * the Message object.
 */
import type { Message } from "discord.js";

export interface FormatMessageOptions {
  /**
   * Include URL lines for image attachments in the rendered output.
   *
   * - Wake/steer path (default `false`): images flow through
   *   `PromptOptions.images` as native image content blocks. The model
   *   sees the image directly; the URL would be redundant noise.
   * - `history` tool (`true`): past messages aren't re-injected with
   *   their image content, so the URL is the only handle the agent has
   *   to image attachments from earlier messages. The agent can `bash
   *   curl` if it needs the bytes.
   *
   * Non-image attachment URLs are always included regardless — there's
   * no native delivery channel for them.
   */
  includeImageUrls?: boolean;
}

export function formatMessage(
  message: Message,
  selfUserId: string,
  options: FormatMessageOptions = {},
): string {
  const fields: string[] = [
    `user_id=${message.author.id}`,
    `message_id=${message.id}`,
    `created_at=${new Date(message.createdTimestamp).toISOString()}`,
  ];
  if (message.editedTimestamp !== null) {
    fields.push(`edited_at=${new Date(message.editedTimestamp).toISOString()}`);
  }
  if (message.reference?.messageId) {
    fields.push(`in_reply_to=${message.reference.messageId}`);
  }
  if (message.author.bot) fields.push("bot=true");
  if (message.author.id === selfUserId) fields.push("self=true");
  if (message.attachments.size > 0) fields.push(`attachments=${message.attachments.size}`);

  const header = `[${fields.join(" ")}] ${message.author.username}: ${message.content}`;
  if (message.attachments.size === 0) return header;

  // Skip images by default — they come through the native PromptOptions.images
  // channel on the wake path and don't need to be referenced as URLs in the
  // prompt text. Override via `includeImageUrls` for paths that don't
  // re-inject image content (e.g., the `history` tool).
  const renderableAttachments = [...message.attachments.values()]
    .map((attachment, index) => ({ attachment, index }))
    .filter(({ attachment }) => {
      if (!attachment.contentType?.startsWith("image/")) return true;
      return options.includeImageUrls === true;
    });
  if (renderableAttachments.length === 0) return header;

  const attachmentLines = renderableAttachments
    .map(({ attachment, index }) => {
      const mime = attachment.contentType ?? "application/octet-stream";
      return `attachment[${index}] (${mime}): ${attachment.url}`;
    })
    .join("\n");

  return `${header}\n${attachmentLines}`;
}
