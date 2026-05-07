/**
 * One-shot debug-channel post for process-level events (startup, shutdown,
 * future broadcast-style notices). Intentionally separate from the
 * per-channel `DebugLogger` — those carry per-channel state (source-message
 * URL, channel link cache, compaction tracking) that doesn't apply to
 * lifecycle events. This is the simpler primitive: take a client + content,
 * post if a debug channel is configured, swallow errors so the caller
 * (e.g. a shutdown handler) isn't blocked.
 */
import { MessageFlags, type Client } from "discord.js";
import { config } from "../config.ts";
import { fetchSendableChannel } from "./fetchSendableChannel.ts";

export async function postDebugLine(args: { client: Client; content: string }): Promise<void> {
  const { client, content } = args;
  if (!config.debugChannelId) return;
  const channel = await fetchSendableChannel(client, config.debugChannelId);
  if (!channel) return;
  await channel
    .send({ content, flags: MessageFlags.SuppressEmbeds })
    .catch((error) => console.error("[debugLogger] lifecycle post failed:", error));
}
