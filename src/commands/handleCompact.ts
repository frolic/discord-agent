/**
 * `!compact` — manually trigger pi's context compaction on the channel's
 * session. Reacts 🗜️ if a new compaction started, ⏳ if skipped (no warm
 * session, or one is already in flight). Auto-compaction also runs at
 * pi's threshold — this command is the on-demand path.
 */
import type { CommandHandler } from "./common.ts";

export const handleCompact: CommandHandler = async (context) => {
  const started = context.pool.compact(context.channelId);
  await context.react(started ? "🗜️" : "⏳");
};
