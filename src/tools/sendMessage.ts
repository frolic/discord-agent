/**
 * `send_message` — the only way assistant prose reaches the user channel in
 * `CHAT_MODE=tools`.
 *
 * In stream mode the reply *is* the assistant text, so no tool is needed. That
 * has a cost the tool mode is trading for: no explicit control over message
 * boundaries, and reasoning text and channel text are the same channel. In tools
 * mode `think` holds the reasoning and `send_message` holds the reply.
 *
 * Delivery has two possible owners (see `agent/chatDelivery.ts`):
 *
 * - the streamer already previewed and posted this call's text → `claimStreamed`
 *   returns the message IDs and this tool posts nothing;
 * - nothing was streamed → this tool renders and posts the text itself, chunked
 *   at Discord's limit through the same markdown pipeline the stream uses.
 *
 * Either way the model gets the message IDs back so it can `edit_message` a
 * reply it got wrong instead of posting a correction.
 */
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { ChatDelivery } from "../agent/chatDelivery.ts";
import type { DiscordSender } from "../io/createDiscordSender.ts";

export function createSendMessageTool(args: {
  sender: DiscordSender;
  delivery: ChatDelivery;
}) {
  const { sender, delivery } = args;
  return defineTool({
    name: "send_message",
    label: "send message",
    description: `Post a text message to the user in the current channel/thread. This is how you reply — assistant text outside a tool call is NOT shown to the user.

Long text is split across several Discord messages automatically at markdown-safe boundaries, so write the whole reply in one call rather than sending it in pieces. Returns the Discord message IDs, which you can pass to \`edit_message\` to correct a message in place.

Thread under the message you are answering: pass its \`in_reply_to\`. The first message of a run threads under the waking message automatically when you omit it.`,
    parameters: Type.Object({
      text: Type.String({
        description:
          "The message body, as Discord markdown. Anything you want the user to read goes here — not in assistant text, not in `think`.",
      }),
      in_reply_to: Type.Optional(
        Type.String({
          description:
            "Optional Discord message ID to thread this message under. Pull it from the `message_id=…` field of the message you're answering. Omit for the default (the message that woke this run, once).",
        }),
      ),
    }),
    execute: async (toolCallId, params) => {
      const text = params.text;
      if (text.trim().length === 0) {
        return {
          content: [{ type: "text", text: "Rejected: text is empty. Nothing to send." }],
          details: { messageIds: [] as string[], characters: 0, streamed: false },
          isError: true,
          terminate: false,
        };
      }

      const streamed = await delivery.claimStreamed(toolCallId);
      if (streamed) {
        return {
          content: [
            {
              type: "text",
              text:
                `delivered ${streamed.messageIds.length} message(s) while streaming: ` +
                `${streamed.messageIds.join(", ")}`,
            },
          ],
          details: {
            messageIds: [...streamed.messageIds],
            characters: streamed.text.length,
            streamed: true,
          },
          terminate: false,
        };
      }

      const inReplyTo = params.in_reply_to ?? delivery.takeCompletionReplyTarget();
      const result = await sender.sendText({ text, inReplyTo });
      if (result.messageIds.length === 0 || result.partial) {
        return {
          content: [
            {
              type: "text",
              text:
                result.messageIds.length === 0
                  ? "delivery failed — no message posted"
                  : `delivery partially failed: posted ${result.messageIds.join(", ")} before an error`,
            },
          ],
          details: {
            messageIds: [...result.messageIds],
            characters: text.length,
            streamed: false,
          },
          isError: true,
          terminate: false,
        };
      }
      return {
        content: [
          {
            type: "text",
            text: `delivered ${result.messageIds.length} message(s): ${result.messageIds.join(", ")}`,
          },
        ],
        details: {
          messageIds: [...result.messageIds],
          characters: text.length,
          streamed: false,
        },
        terminate: false,
      };
    },
  });
}
