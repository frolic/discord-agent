/**
 * `!clear` — abort, drop the warm pool entry, and clear the on-disk
 * session for this channel (the pool decides whether that means delete
 * or archive). Wakes the fresh session with a harness notice so the
 * agent knows its history was wiped — it can call the `history` tool
 * if it wants Discord-side context.
 */
import { harnessContextClearedPrompt } from "../agent/prompts.ts";
import type { CommandHandler } from "./common.ts";

export const handleClear: CommandHandler = async (context) => {
  await context.pool.clear(context.channelId);
  await context.react("🗑️");
  context.pool.wakeUp(context.channelId, harnessContextClearedPrompt).catch((error) =>
    console.error(`[commands/clear] post-clear wakeUp failed for ${context.channelId}:`, error),
  );
};
