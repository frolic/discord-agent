/**
 * `!stop` — abort the agent's current run on this channel. Pi cancels
 * any in-flight tool call and the streaming dispatcher closes; the next
 * user message starts a fresh turn. Session history is untouched.
 */
import type { CommandHandler } from "./common.ts";

export const handleStop: CommandHandler = async (context) => {
  // Signal pi's abort controller on the warm session. No-op if no entry
  // exists for this channel — abort with nothing to abort is fine.
  context.pool.session(context.channelId)?.abort();
  await context.react("🛑");
};
