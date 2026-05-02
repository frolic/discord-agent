/**
 * Resolve a channel ID to a SendableChannels (DM, guild text, thread, etc.)
 * — caches first, falls back to a network fetch. Returns null if the
 * channel is missing or not sendable, so callers can no-op cleanly when
 * the bot's been kicked or the channel was deleted.
 */
import type { Client, SendableChannels } from "discord.js";

export async function fetchSendableChannel(
  client: Client,
  channelId: string,
): Promise<SendableChannels | null> {
  const cached = client.channels.cache.get(channelId);
  if (cached?.isSendable()) return cached;
  const fetched = await client.channels.fetch(channelId).catch((error) => {
    console.error(`[discord] channels.fetch ${channelId} failed:`, error);
    return null;
  });
  if (fetched?.isSendable()) return fetched;
  return null;
}
