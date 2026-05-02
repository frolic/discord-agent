/**
 * Render a discord.js Message as the single text line the agent sees,
 * shared between the wake path (`pool.handle`) and the `history` tool.
 *
 * Format:
 *   [user_id=<id> message_id=<id> created_at=<iso>[ edited_at=<iso>][ in_reply_to=<id>][ bot=true][ self=true][ attachments=<n>]] <username>: <content>
 *
 * Bracket = metadata; "username: content" = the human-shaped record. Field
 * order is fixed: most-stable to least-stable (user_id → message_id →
 * created_at → edited_at → in_reply_to) followed by situational flags
 * (bot, self, attachments). Anything pattern-matching these lines can
 * rely on the order.
 *
 * - `user_id`     — never changes. Use in `<@user_id>` to @-mention.
 * - `message_id`  — stable per message. Use for `react.message_id` and
 *                   `send.in_reply_to`.
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
  return `[${fields.join(" ")}] ${message.author.username}: ${message.content}`;
}
