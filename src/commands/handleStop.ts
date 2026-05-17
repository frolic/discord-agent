/**
 * `!stop` — abort the agent's current run on this channel. Pi cancels
 * any in-flight tool call and the streaming dispatcher closes; the next
 * user message starts a fresh turn. Session history is untouched.
 */
import type { CommandHandler } from "./common.ts";

export const handleStop: CommandHandler = async (context) => {
  context.pool.abort(context.channelId);
  await context.react("🛑");
};
