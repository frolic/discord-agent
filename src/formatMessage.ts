/**
 * Render a discord.js Message as the text the agent sees, shared between
 * the wake path (`pool.handle`) and the `history` tool.
 *
 * Header format (always one line):
 *   [user_id=<id> message_id=<id> created_at=<iso>[ edited_at=<iso>][ in_reply_to=<id>][ bot=true][ self=true][ attachments=<n>]] <username>: <content>
 *
 * If the message has attachments, one extra line per attachment follows
 * the header, listing mime type and CDN URL:
 *   attachment[<i>] (<mime>): <url>
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
 * - `attachments=<n>` — number of files. URLs follow on `attachment[i]`
 *                   lines. Image attachments are *also* passed through
 *                   as image content in the visible context (so the model
 *                   can "see" them); for non-image attachments the URL
 *                   is the only way to access the file — use `bash curl`
 *                   to fetch when relevant.
 *
 * `selfUserId` is passed in (rather than read from a global) so the
 * function stays pure — the only Discord state it touches is what's on
 * the Message object.
 */
import type { Message } from "discord.js";

export function formatMessage(message: Message, selfUserId: string): string {
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

  // Append one URL line per attachment so the agent can fetch non-image
  // files via `bash curl`. Listing image attachments too keeps the shape
  // uniform; the agent can reference originals when it needs to (the
  // visible image content is sufficient for "seeing" them).
  const attachmentLines = [...message.attachments.values()]
    .map((attachment, index) => {
      const mime = attachment.contentType ?? "application/octet-stream";
      return `attachment[${index}] (${mime}): ${attachment.url}`;
    })
    .join("\n");

  return `${header}\n${attachmentLines}`;
}
