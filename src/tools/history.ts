/**
 * Read recent messages from a Discord channel/thread. Defaults to the
 * channel that woke the agent, but can target any channel the bot has
 * read permission on via the `channel_id` parameter — Discord's own
 * permission model is the gate, so the tool simply forwards whatever
 * channel ID the agent supplies and lets the API reject if disallowed.
 */
import type { Client } from "discord.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { formatMessage } from "../formatMessage.ts";

export function createHistoryTool(args: { client: Client; channelId: string }) {
  const { client, channelId: defaultChannelId } = args;
  return defineTool({
    name: "history",
    label: "read channel history",
    description:
      "Fetch messages from a Discord channel/thread, oldest-first. Defaults to the current channel; pass channel_id to read elsewhere (the bot must have read permission, Discord enforces). Cursor modes (mutually exclusive — only set one): `before` walks older, `after` walks newer (this is what catchup hints point you at), `id` returns just that one message (use this to look up a specific message by ID — e.g., the target of an `in_reply_to=…` you saw in a formatted line). Don't fetch more than ~300 messages without checking in with the user.",
    parameters: Type.Object({
      limit: Type.Optional(
        Type.Number({
          minimum: 1,
          maximum: 100,
          description: "how many messages to fetch (default 50, max 100). Ignored when `id` is set.",
        }),
      ),
      before: Type.Optional(
        Type.String({
          description: "message ID — fetch messages older than this (exclusive). Omit for the most recent.",
        }),
      ),
      after: Type.Optional(
        Type.String({
          description:
            "message ID — fetch messages newer than this (exclusive). Used for catchup: harness wake-up notices include the cursor (`history(after=…)`) so you can read anything that arrived during downtime.",
        }),
      ),
      id: Type.Optional(
        Type.String({
          description:
            "message ID — fetch just this one message. Use to look up the target of an `in_reply_to=…` field, or any other message you have an ID for but haven't seen the contents of. Returns one formatted line, or an error if the message doesn't exist / the bot can't read it.",
        }),
      ),
      channel_id: Type.Optional(
        Type.String({
          description:
            "Discord channel/thread ID to read. Omit to read the channel that woke this conversation. Use to peek at related rooms when the bot has read access there.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const targetChannelId = params.channel_id ?? defaultChannelId;
      const channel = await client.channels.fetch(targetChannelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`channel ${targetChannelId} is not a text channel`);
      }

      // `client.user` is populated by the time tools run (login completes
      // before tools are registered). If it's missing, that's a bug — fail
      // loudly rather than rendering messages with an empty self-id.
      if (!client.user) throw new Error("client.user not set — login did not complete");
      const selfUserId = client.user.id;

      // Single-message lookup: dispatch to `messages.fetch(id)` directly —
      // one round-trip, returns just the target. The agent doesn't need
      // to know about Discord's `around` quirk; the tool just exposes a
      // clean `id=<x>` shape.
      if (params.id) {
        const message = await channel.messages.fetch(params.id);
        return {
          content: [{ type: "text", text: formatMessage(message, selfUserId) }],
          details: { count: 1, oldestId: message.id, channelId: targetChannelId },
        };
      }

      const fetched = await channel.messages.fetch({
        limit: params.limit ?? 50,
        before: params.before,
        after: params.after,
      });

      // Discord returns newest-first; reverse for chronological reading.
      const chronological = [...fetched.values()].reverse();
      const lines = chronological.map((message) => formatMessage(message, selfUserId));
      const text = lines.length > 0 ? lines.join("\n") : "(no messages in this range)";

      return {
        content: [{ type: "text", text }],
        details: {
          count: lines.length,
          oldestId: chronological.at(0)?.id,
          channelId: targetChannelId,
        },
      };
    },
  });
}
