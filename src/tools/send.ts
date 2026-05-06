/**
 * The envelope-tool: the agent MUST use this for every visible reply. The
 * harness ignores raw assistant text — only tool-call args become visible
 * Discord messages. The model converges on tool-only output within a few
 * turns because raw text has no observable effect.
 *
 * `terminate: endOfTurn` — the agent loop continues by default after a
 * send. The model must explicitly signal `endOfTurn: true` on its final
 * send to end the turn. This means forgetting the flag keeps the loop
 * alive (caught by the runaway counter) rather than silently dropping
 * work the user is waiting for.
 */
import { stat } from "node:fs/promises";
import { defineTool } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { MessageSender } from "../io/createMessageSender.ts";

const discordMaxAttachmentBytes = 24 * 1024 * 1024;

const discordFormattingDoc = `
# Discord formatting

Supported (use these):
- **bold**, *italic*, __underline__, ~~strikethrough~~, ||spoiler||
- \`inline code\`, triple-backtick code blocks (with optional lang hint)
- > single-line quote, >>> rest-of-message quote
- # Heading 1, ## Heading 2, ### Heading 3
- - list item, 1. numbered list
- -# subtext (small grey text — useful for footnotes/metadata)
- [label](<url>) masked links — use angle brackets to suppress the embed preview
- <@USER_ID> user mention, <#CHANNEL_ID> channel mention, <:name:id> custom emoji

# At-mentions

To ping a user, write \`<@USER_ID>\` in your text (Discord renders it as a clickable mention and notifies them). The user ID comes from the \`user_id=…\` field on every message you receive — both wake-path prompts and \`history\` tool output include it. Example: a message tagged \`[user_id=789012345 message_id=… created_at=…] alice: hey\` can be replied to with \`thanks <@789012345>\`. Don't use the username — only the numeric \`user_id\` resolves to a real mention.

NOT supported (don't use):
- Markdown tables (\`| col | col |\` syntax) — they render as raw pipes. For tabular data, wrap in a triple-backtick code block with column alignment.
- HTML tags (<details>, <img>, etc.) — render as literal text.
- Task lists (- [ ] / - [x]) — render as raw text.
- Image markdown (![alt](url)) — use the attachments parameter to send a real file.`;

export function createSendTool(args: { sender: MessageSender }) {
  const { sender } = args;
  return defineTool({
    name: "send",
    label: "send message",
    description: `Send a message to the Discord conversation. ALL replies to the user MUST go through this tool — raw text replies are NOT delivered (the user cannot see them). Each call posts one Discord message. The agent loop continues after each call unless you set endOfTurn: true.

To attach files (images, docs, generated artifacts), pass absolute paths in the attachments array. The files post inline with this message.
${discordFormattingDoc}`,
    parameters: Type.Object({
      text: Type.String({
        description: "the message content (≤1900 chars). See description for supported Discord formatting.",
      }),
      endOfTurn: Type.Optional(
        Type.Boolean({
          description:
            "set true to end your turn after this message is delivered. Default false — the agent loop continues, letting you call more tools or send more messages. Set true on your FINAL send when you have nothing left to do.",
        }),
      ),
      in_reply_to: Type.Optional(
        Type.String({
          description:
            "Discord message ID to thread this reply under. Discord shows a 'replying to' badge linking back, which keeps multi-person channels readable and makes the conversational target unambiguous. DEFAULT BEHAVIOR: when you're answering a specific message — including the message that woke you — pass its `message_id=…` here. The wake prompt at the top of your turn always carries the right ID. Omit only for: (a) unprompted/spontaneous messages tied to no specific target, (b) continuation parts of a multi-message reply (set in_reply_to on the first part only), (c) general broadcasts not directed at one message.",
        }),
      ),
      attachments: Type.Optional(
        Type.Array(Type.String(), {
          description:
            "Absolute paths of local files to attach to this message. Each must exist, be a regular file, and be ≤24MB. Discord allows up to 10 per message. Don't paste raw paths in the text — use this parameter.",
          maxItems: 10,
        }),
      ),
    }),
    execute: async (_id, params) => {
      if (params.text.length > 1900) {
        return {
          content: [{ type: "text", text: `Rejected: ${params.text.length} chars exceeds the 1900 char limit. Split your content into multiple send calls at natural paragraph/section boundaries. Do NOT summarize or shorten — send the full content across multiple calls, setting endOfTurn: true only on the last one.` }],
          details: { length: params.text.length, messageId: undefined, attachmentCount: 0 },
          isError: true,
          terminate: false,
        };
      }
      const validatedPaths = await validateAttachments(params.attachments ?? []);
      const sent = await sender.send({
        text: params.text,
        files: validatedPaths,
        inReplyTo: params.in_reply_to,
      });
      const summary = formatDeliverySummary({
        length: sent.length,
        attachmentCount: validatedPaths.length,
        success: sent.success,
      });
      return {
        content: [{ type: "text", text: summary }],
        details: {
          length: sent.length,
          messageId: sent.messageId,
          attachmentCount: validatedPaths.length,
        },
        terminate: params.endOfTurn ?? false,
      };
    },
  });
}

async function validateAttachments(paths: string[]): Promise<string[]> {
  const validated: string[] = [];
  for (const path of paths) {
    if (!path.startsWith("/")) {
      throw new Error(`attachment path must be absolute: "${path}"`);
    }
    const stats = await stat(path).catch((error) => {
      console.error(`[send] stat ${path} failed:`, error);
      return null;
    });
    if (!stats) throw new Error(`attachment not found: ${path}`);
    if (!stats.isFile()) throw new Error(`attachment is not a regular file: ${path}`);
    if (stats.size > discordMaxAttachmentBytes) {
      const sizeMb = (stats.size / (1024 * 1024)).toFixed(1);
      throw new Error(`attachment too large (${sizeMb}MB > 24MB): ${path}`);
    }
    validated.push(path);
  }
  return validated;
}

function formatDeliverySummary(args: {
  length: number;
  attachmentCount: number;
  success: boolean;
}): string {
  const { length, attachmentCount, success } = args;
  if (!success) return "delivery failed";
  if (attachmentCount === 0) return `delivered (${length} chars)`;
  const plural = attachmentCount === 1 ? "" : "s";
  return `delivered (${length} chars + ${attachmentCount} attachment${plural})`;
}
