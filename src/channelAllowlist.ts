/**
 * Channel allowlist — which channels may wake the agent.
 *
 * By default (`DISCORD_CHANNEL_ALLOWLIST` unset) the harness is
 * single-player: any non-bot message in any channel or thread the bot can
 * see wakes it. That's fine for a one-user deployment but it means the bot
 * answers in every room it was ever invited to, including rooms you only
 * wanted it to *read*.
 *
 * Setting the env var to a comma/whitespace-separated list of channel ids
 * narrows participation to exactly those channels: messages anywhere else
 * are dropped before they reach the pool (no session, no catchup cursor
 * advance, no commands).
 *
 * Threads inherit their parent channel — a thread under an allowed channel
 * is allowed (that's where the conversation actually lives), and a thread
 * under any other channel is not.
 *
 * Pure functions, no discord.js import, so the routing decision is testable
 * without a client.
 */

/** Parse the env var into a deduplicated list of channel ids. */
export function parseChannelAllowlist(raw: string | undefined): readonly string[] {
  if (!raw) return [];
  const ids = raw
    .split(/[\s,]+/)
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);
  return [...new Set(ids)];
}

/**
 * Is a message in this channel (or thread) allowed to wake the agent?
 *
 * An empty allowlist means "no restriction" — the historical behaviour.
 * `parentChannelId` is the owning channel for a thread, `null` otherwise.
 */
export function isChannelAllowed(args: {
  allowlist: readonly string[];
  channelId: string;
  parentChannelId?: string | null;
}): boolean {
  const { allowlist, channelId, parentChannelId } = args;
  if (allowlist.length === 0) return true;
  if (allowlist.includes(channelId)) return true;
  if (parentChannelId) return allowlist.includes(parentChannelId);
  return false;
}
