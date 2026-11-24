/**
 * `edit_message` — rewrite one message this bot already posted.
 *
 * The tools-mode equivalent of "let me correct that": the model has the message
 * IDs back from `send_message`, so a wrong figure or a typo becomes an in-place
 * edit instead of a second message that talks over the first.
 *
 * Refusals are explicit rather than silent: too-long content and other people's
 * messages both come back as errors the model can act on, because a truncated or
 * half-applied edit reads as a lie about what the agent said.
 */
import type { Client } from "discord.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DiscordSender } from "../io/createDiscordSender.ts";

export function createEditMessageTool(args: {
  client: Client;
  channelId: string;
  sender: DiscordSender;
}) {
  const { client, channelId, sender } = args;
  return defineTool({
    name: "edit_message",
    label: "edit message",
    description: `Replace the whole content of a message the bot already posted in this channel. Use it to correct something you got wrong rather than posting a correction as a new message.

Only messages this bot authored can be edited, and the new text must fit one Discord message (2000 characters, rendered). For more than that, send a new message instead.`,
    parameters: Type.Object({
      message_id: Type.String({
        description:
          "Discord message ID to edit — one returned by `send_message`, or an existing bot message from `history` (look for `self=true`).",
      }),
      text: Type.String({
        description: "The new full body of the message. It replaces the old content entirely.",
      }),
    }),
    execute: async (_toolCallId, params) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased()) {
        throw new Error(`channel ${channelId} is not a text channel`);
      }
      const target = await channel.messages.fetch(params.message_id).catch((error) => {
        console.error(`[edit_message] fetch ${params.message_id} failed:`, error);
        return null;
      });
      if (!target) throw new Error(`message ${params.message_id} not found in this channel`);

      if (!client.user) throw new Error("client.user not set — login did not complete");
      if (target.author.id !== client.user.id) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: message ${params.message_id} was authored by someone else — only this bot's own messages can be edited.`,
            },
          ],
          details: { messageId: params.message_id, renderedLength: 0 },
          isError: true,
          terminate: false,
        };
      }

      const result = await sender.editText(params.message_id, params.text);
      if (!result.ok) {
        return {
          content: [{ type: "text", text: `Rejected: ${result.error}` }],
          details: { messageId: params.message_id, renderedLength: result.renderedLength },
          isError: true,
          terminate: false,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `edited message ${params.message_id} (${result.renderedLength} chars)`,
          },
        ],
        details: { messageId: params.message_id, renderedLength: result.renderedLength },
        terminate: false,
      };
    },
  });
}
