/**
 * Reactions are the second valid envelope-tool delivery: when a user message
 * needs only a one-character acknowledgment, the model picks this instead of
 * the `send` tool. Like sending, it terminates the turn — if the
 * model needs follow-up work, it should call other tools BEFORE reacting.
 *
 * Behavior is a toggle: if the bot already has the given emoji on the target
 * message, the reaction is removed; otherwise it's added. This means the
 * agent can retract a reaction it placed earlier by calling the same tool
 * with the same emoji a second time — no separate "remove" tool needed.
 *
 * `message_id` is required: every message the agent receives is formatted
 * with its `message_id=…` (see `formatMessage.ts`), so there's
 * no need for an implicit "react to the latest" fallback.
 */
import type { Client } from "discord.js";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";

export function createReactTool(args: { client: Client; channelId: string }) {
  const { client, channelId } = args;
  return defineTool({
    name: "react",
    label: "react",
    description:
      "Toggle an emoji reaction on a specific message in the current channel/thread. If you've already reacted with this emoji, the reaction is removed; otherwise it's added. Use this for messages that need only a one-character acknowledgment (e.g., user says 'thanks' → react 👍), or to retract a reaction you placed earlier by calling again with the same emoji. This is an alternative to the `send` tool — pick one per turn based on whether words are needed. The target message ID comes from the `message_id=…` field of every message you see (wake prompt and `history` tool output).",
    parameters: Type.Object({
      emoji: Type.String({
        description: "Unicode emoji (e.g. 👍, ✅, ❤️) or :name: for custom server emojis",
      }),
      message_id: Type.String({
        description:
          "Discord message ID to react to. Pull this from the `message_id=…` field of the message you want to react to.",
      }),
    }),
    execute: async (_id, params) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }

      const target = await channel.messages.fetch(params.message_id).catch((error) => {
        console.error(`[react] fetch ${params.message_id} failed:`, error);
        return null;
      });
      if (!target) throw new Error(`message ${params.message_id} not found in this channel`);

      // Match the requested emoji against the message's existing reactions
      // by unicode name (👍), full toString form (<:name:id>), or raw ID.
      // Covers the three input shapes the model might emit.
      const existing = target.reactions.cache.find((reaction) =>
        reaction.emoji.name === params.emoji ||
        reaction.emoji.toString() === params.emoji ||
        reaction.emoji.id === params.emoji,
      );

      if (existing?.me) {
        // Bot already has this reaction → toggle off. `users.remove()` with
        // no argument defaults to the current bot user.
        await existing.users.remove();
        return {
          content: [{ type: "text", text: `removed ${params.emoji} from message ${params.message_id}` }],
          details: { messageId: params.message_id, emoji: params.emoji, action: "removed" },
          terminate: true,
        };
      }

      await target.react(params.emoji);
      return {
        content: [{ type: "text", text: `reacted ${params.emoji} on message ${params.message_id}` }],
        details: { messageId: params.message_id, emoji: params.emoji, action: "added" },
        terminate: true,
      };
    },
  });
}
