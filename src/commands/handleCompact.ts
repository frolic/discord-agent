/**
 * `!compact` — manually trigger pi's context compaction on the channel's
 * session. Reacts 🗜️ if a new compaction started, ⏳ if skipped (no warm
 * session, or one is already in flight). Auto-compaction also runs at
 * pi's threshold — this command is the on-demand path.
 */
import type { CommandHandler } from "./common.ts";

export const handleCompact: CommandHandler = async (context) => {
  const session = context.pool.session(context.channelId);
  // No warm session means nothing to compact, and acquiring an entry just
  // to compact it would be pointless. Concurrent compactions on the same
  // session orphan pi's `_compactionAbortController` and run two LLM
  // summaries in parallel (earendil-works/pi#4203), so skip if one is
  // already in flight.
  const started = Boolean(session && !session.isCompacting);
  if (started) {
    // Pi can still throw "Already compacted" if the last session entry is
    // already a compaction — fire-and-forget but catch to avoid an
    // unhandled rejection.
    session?.compact().catch((error) => {
      console.error(`[commands/compact] compact ${context.channelId} failed:`, error);
    });
  }
  await context.react(started ? "🗜️" : "⏳");
};
