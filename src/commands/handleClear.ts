/**
 * `!clear` — abort any in-flight run, drop the warm pool entry, gzip the
 * on-disk session into the archive dir, then wake a fresh session with a
 * harness notice so the agent knows its history was wiped (it can call
 * the `history` tool if it wants Discord-side context).
 *
 * The full sequence lives here, not behind a `pool.clear()` wrapper —
 * each step is composing pool primitives + tracker + the archive helper.
 * If a new !command needs to clear too, it composes the same way.
 */
import { harnessContextClearedPrompt } from "../agent/prompts.ts";
import { sessionPathFor } from "../createAgentPool.ts";
import { archiveSession } from "./archiveSession.ts";
import type { CommandHandler } from "./common.ts";

export const handleClear: CommandHandler = async (context) => {
  const { pool, tracker, channelId } = context;
  // Stop pi mid-flight + drop warm bookkeeping. Order: abort first so the
  // running turn doesn't append more lines after we've decided to clear.
  pool.session(channelId)?.abort();
  pool.dropEntry(channelId);
  tracker.clearChannel(channelId);
  // Archive the JSONL — keeps prior conversations on disk for debugging.
  // Bubbles any I/O failure (other than ENOENT, which is the "no session
  // yet" no-op): leaving the channel half-cleared with the source file
  // intact would silently resume the old session on the next message.
  const archivePath = await archiveSession(sessionPathFor(channelId), channelId);
  if (archivePath) {
    console.log(`[commands/clear] archived session for ${channelId} → ${archivePath}`);
  }
  await context.react("🗑️");
  pool.wakeUp(channelId, harnessContextClearedPrompt).catch((error) =>
    console.error(`[commands/clear] post-clear wakeUp failed for ${channelId}:`, error),
  );
};
