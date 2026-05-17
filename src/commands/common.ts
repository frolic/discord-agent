/**
 * Shared types for `!command` handlers. Each handler accepts a
 * `CommandContext` that bundles the message, the channel ID, the pool
 * (for state-changing ops), the tracker (for restart bookkeeping), and a
 * pre-bound `react` helper. Handlers return `Promise<void>` and are
 * expected to throw on unexpected failures — the router doesn't catch.
 */
import type { Message } from "discord.js";
import type { AgentPool } from "../createAgentPool.ts";
import type { ActiveTracker } from "../active/createActiveTracker.ts";

export interface CommandContext {
  /** Full normalized command text, e.g. `"!compact"` or `"!stop now"`. */
  command: string;
  message: Message;
  channelId: string;
  pool: AgentPool;
  tracker: ActiveTracker;
  /**
   * React to the triggering message with an emoji. Errors are logged and
   * swallowed — a failed reaction shouldn't take down the command.
   */
  react: (emoji: string) => Promise<unknown>;
}

export type CommandHandler = (context: CommandContext) => Promise<void>;
