/**
 * Exit the bot process so a supervisor (systemd, Docker, wrapper script)
 * restarts it. Used after the agent edits its own source code, or as a
 * recovery hatch when state is stuck.
 *
 * Acks the user via a 🔄 reaction on their most recent message — directly
 * through the Discord client, NOT via the agent's `react` tool.
 * That keeps the ack out of pi's session log, so when the agent resumes
 * it doesn't see a stale "I'm restarting" message that confuses follow-up
 * generation.
 *
 * Calls `markRestart` (sets pending + cameFromRestart) BEFORE exiting. On
 * the next boot, `recoverActive` sees `cameFromRestart` and injects the
 * `harnessRestartPrompt` so the agent posts its own back-online reply
 * instead of the harness speaking for it.
 *
 * If no supervisor is in place, the bot will NOT come back. The user-side
 * equivalent is the `!restart` command in the router.
 */
import type { Client } from "discord.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { ActiveTracker } from "../active/createActiveTracker.ts";
import { postDebugLine } from "../io/postDebugLine.ts";

export const restartAckEmoji = "🔄";

export function createRestartSelfTool(args: {
  client: Client;
  channelId: string;
  tracker: ActiveTracker;
}) {
  const { client, channelId, tracker } = args;
  return defineTool({
    name: "restart_self",
    label: "restart self",
    description:
      "Exit the bot process. The supervisor (systemd, Docker, wrapper script) will respawn with current source. Use after editing your own framework code, or as a recovery hatch if state is stuck. WARNING: if no supervisor is running, the bot will not come back. Do NOT write a confirmation message before calling this — the harness automatically reacts 🔄 to the user's message as the ack, and any streamed text would race the process exit.",
    // Sequential execution + terminate: true means a parallel-emitted second
    // call is dropped before it runs — the framework halts after the first
    // result. Without this, two parallel calls both fire execute() and both
    // schedule process exits; only one ever takes effect, but the redundant
    // call still pollutes session history.
    executionMode: "sequential",
    parameters: Type.Object({
      reason: Type.Optional(
        Type.String({
          description: "What changed and why; logged for ops visibility.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      console.log(`[restart_self] requested${params.reason ? `: ${params.reason}` : ""}`);
      await ackViaReaction(client, channelId).catch((error) =>
        console.error("[restart_self] reaction ack failed:", error),
      );
      const reasonSuffix = params.reason ? ` — ${params.reason}` : "";
      await postDebugLine({
        client,
        content: `-# 🔴 offline — restart_self${reasonSuffix}`,
      }).catch(() => {});
      // Tag pending + cameFromRestart so recoverActive injects the
      // "you just restarted" harness prompt on respawn.
      tracker.markRestart(channelId);
      // Brief delay so the tool result flushes through the chain before exit.
      setTimeout(() => process.exit(0), 1000);
      return {
        content: [{ type: "text", text: "restart scheduled — exiting in 1s" }],
        details: {},
        terminate: true,
      };
    },
  });
}

async function ackViaReaction(client: Client, channelId: string): Promise<void> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || channel.isDMBased()) return;
  const recent = await channel.messages.fetch({ limit: 20 });
  const lastUserMessage = [...recent.values()].find((entry) => !entry.author.bot);
  if (!lastUserMessage) return;
  await lastUserMessage.react(restartAckEmoji);
}
