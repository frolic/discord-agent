/**
 * The router owns ALL inbound Discord events that should reach the agent.
 * Centralizing the wake-or-ignore decision means there's exactly one
 * place to change wake semantics: today single-player (any human message
 * wakes), tomorrow possibly multiplayer (mention/reply/role gates per
 * channel).
 *
 * Two event sources:
 * - `messageCreate` — fresh user messages. May be commands (`!stop`,
 *   `!compact`, `!clear`, `!restart`) which the harness handles directly
 *   without involving the agent. The catchup cursor (`lastSeenMessageId`)
 *   advances on every received message so post-restart recovery has a
 *   usable `history(after=…)` hint.
 * - `messageUpdate` — user edits, treated as steering. The edited
 *   message flows through `pool.handle`, which lands it as a steer if
 *   the agent is mid-turn or as a fresh wake if idle (the formatted
 *   line carries `edited_at=…` either way). Filters keep this sane:
 *   bot/own edits are ignored, no-content-change updates (Discord fires
 *   these on embed loading) are dropped, edits to commands are dropped
 *   (commands are one-shot), and edits to channels without an active
 *   pool entry are skipped — an edit to a stale channel isn't steering
 *   anything.
 */
import type { Client, Message, PartialMessage } from "discord.js";
import type { AgentPool } from "./createAgentPool.ts";
import type { ActiveTracker } from "./active/createActiveTracker.ts";
import { harnessContextClearedPrompt } from "./agent/prompts.ts";
import { postDebugLine } from "./io/postDebugLine.ts";

export function installRouter(args: {
  client: Client;
  pool: AgentPool;
  tracker: ActiveTracker;
}): void {
  const { client, pool, tracker } = args;

  client.on("messageCreate", async (message) => {
    if (!client.user) return;
    if (message.author.bot) return;
    // Defensive: DM intents are off, but if a DM ever leaks through, ignore.
    if (!message.guildId) return;

    const channelId = message.channel.id;
    // Bump the catchup cursor for ANY user message we receive — including
    // commands and edits — so post-restart recovery has a usable
    // `history(after=…)` hint.
    tracker.markLastSeen(channelId, message.id);

    // Strip <@bot> mentions before matching commands.
    const text = message.content.replace(/<@!?\d+>/g, "").trim().toLowerCase();

    if (text.startsWith("!")) {
      await handleCommand({ command: text, message, channelId, pool, tracker });
      return;
    }

    await pool.handle(channelId, message);
  });

  client.on("messageUpdate", async (oldMessage, newMessage) => {
    const message = await hydrateMessage(newMessage);
    if (!message) return;
    if (!client.user) return;
    // Skip bot edits (including our own).
    if (message.author.bot) return;
    if (!message.guildId) return;
    // Discord fires messageUpdate for non-content reasons (embed/link
    // preview loading, pin state, etc.). If we can see the old content
    // and it matches the new content, it isn't a real edit — drop it.
    const oldContent = oldMessage.partial ? null : oldMessage.content;
    if (oldContent !== null && oldContent === message.content) return;
    // Edits to commands aren't re-fired — commands are one-shot.
    const text = message.content.replace(/<@!?\d+>/g, "").trim().toLowerCase();
    if (text.startsWith("!")) return;
    // Steering only makes sense when there's a live conversation in this
    // channel. An edit to a long-dormant room would otherwise spin up a
    // fresh session for what is probably a typo fix on stale history.
    if (!pool.hasActive(message.channel.id)) return;

    await pool.handle(message.channel.id, message);
  });
}

async function hydrateMessage(message: Message | PartialMessage): Promise<Message | null> {
  if (!message.partial) return message;
  return message.fetch().catch((error) => {
    console.error("[router] partial message hydrate failed:", error);
    return null;
  });
}

async function handleCommand(args: {
  command: string;
  message: Message;
  channelId: string;
  pool: AgentPool;
  tracker: ActiveTracker;
}): Promise<void> {
  const { command, message, channelId, pool, tracker } = args;
  const react = (emoji: string): Promise<unknown> =>
    message.react(emoji).catch((error) => console.error(`[router] react ${emoji} failed:`, error));

  if (command.startsWith("!stop")) {
    pool.abort(channelId);
    await react("🛑");
    return;
  }
  if (command.startsWith("!compact")) {
    const started = pool.compact(channelId);
    await react(started ? "🗜️" : "⏳");
    return;
  }
  if (command.startsWith("!clear")) {
    await pool.clear(channelId);
    await react("🗑️");
    // Wake the fresh session with a harness notice so the agent knows its
    // history was wiped — it can call the `history` tool if it wants context.
    pool.wakeUp(channelId, harnessContextClearedPrompt).catch((error) =>
      console.error(`[router] post-clear wakeUp failed for ${channelId}:`, error),
    );
    return;
  }
  if (command.startsWith("!restart")) {
    await react("🔄");
    await postDebugLine({
      client: message.client,
      content: "-# 🔴 offline — !restart",
    }).catch(() => {});
    // Mark cameFromRestart so recoverActive injects the "you just
    // restarted" harness prompt on respawn — agent posts its own
    // back-online reply instead of staying silent.
    tracker.markRestart(channelId);
    // Brief delay so the reaction lands before we exit. Supervisor
    // (systemd, Docker, wrapper script) respawns. Without a supervisor,
    // the bot will not come back.
    setTimeout(() => process.exit(0), 500);
    return;
  }
  await react("❓");
}
