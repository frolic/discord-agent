/**
 * `!restart` — exit the bot process so the supervisor (systemd, Docker,
 * wrapper script) respawns with current source. Marks `cameFromRestart`
 * on the channel so `recoverActive` injects a "you just restarted" notice
 * on respawn — the agent posts its own back-online reply instead of
 * staying silent. Without a supervisor the bot will not come back.
 */
import { postDebugLine } from "../io/postDebugLine.ts";
import type { CommandHandler } from "./common.ts";

const restartGracePeriodMs = 500;

export const handleRestart: CommandHandler = async (context) => {
  await context.react("🔄");
  await postDebugLine({
    client: context.message.client,
    content: "-# 🔴 offline — !restart",
  }).catch(() => {});
  context.tracker.markRestart(context.channelId);
  // Brief delay so the reaction lands before we exit. Supervisor respawns.
  setTimeout(() => process.exit(0), restartGracePeriodMs);
};
