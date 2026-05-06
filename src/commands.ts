/**
 * Shared command handler bodies, dispatched by `installSlashCommands` on
 * `interactionCreate`. Lives in its own module so the command set is
 * declarative and the dispatch surface stays thin.
 */
import type { Client } from "discord.js";
import type { AgentPool } from "./createAgentPool.ts";
import type { ActiveTracker } from "./active/createActiveTracker.ts";
import { harnessContextClearedPrompt } from "./agent/prompts.ts";
import { postDebugLine } from "./io/postDebugLine.ts";

/**
 * Reply contract: emoji feedback delivered by the surface. For slash
 * commands, this is an ephemeral interaction reply with the emoji as
 * content.
 */
export type CommandReply = (emoji: string) => Promise<unknown>;

export interface CommandContext {
  channelId: string;
  client: Client;
  pool: AgentPool;
  tracker: ActiveTracker;
  reply: CommandReply;
}

export type CommandName = "stop" | "compact" | "clear" | "restart";

export const commandDefinitions: ReadonlyArray<{
  name: CommandName;
  description: string;
}> = [
  { name: "stop", description: "Abort whatever the agent is currently doing" },
  { name: "compact", description: "Compact the current session (pi context compaction)" },
  { name: "clear", description: "Clear this channel's session history and start fresh" },
  { name: "restart", description: "Restart the bot process (supervisor respawns)" },
];

export async function runCommand(name: CommandName, ctx: CommandContext): Promise<void> {
  switch (name) {
    case "stop":
      ctx.pool.abort(ctx.channelId);
      await ctx.reply("🛑");
      return;

    case "compact": {
      const started = ctx.pool.compact(ctx.channelId);
      await ctx.reply(started ? "🗜️" : "⏳");
      return;
    }

    case "clear":
      await ctx.pool.clear(ctx.channelId);
      await ctx.reply("🗑️");
      // Wake the fresh session with a harness notice so the agent knows its
      // history was wiped — it can call the `history` tool if it wants context.
      ctx.pool.wakeUp(ctx.channelId, harnessContextClearedPrompt).catch((error) =>
        console.error(`[commands] post-clear wakeUp failed for ${ctx.channelId}:`, error),
      );
      return;

    case "restart":
      await ctx.reply("🔄");
      await postDebugLine({
        client: ctx.client,
        content: "-# 🔴 offline — /restart",
      }).catch(() => {});
      // Mark cameFromRestart so recoverActive injects the "you just
      // restarted" harness prompt on respawn — agent posts its own
      // back-online reply instead of staying silent.
      ctx.tracker.markRestart(ctx.channelId);
      // Brief delay so the reply lands before we exit. Supervisor
      // (systemd, Docker, wrapper script) respawns. Without a supervisor,
      // the bot will not come back.
      setTimeout(() => process.exit(0), 500);
      return;
  }
}
