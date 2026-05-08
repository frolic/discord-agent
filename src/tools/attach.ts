/**
 * Post a Discord message with one or more file attachments.
 *
 * Plain text replies stream automatically — anything the model writes
 * outside a tool call appears in the channel. `attach` exists for the
 * cases streaming can't cover: posting a file (image, document, generated
 * artifact) inline. An optional `content` field lets the model pair a
 * short caption with the files; long-form prose should still go through
 * the text stream.
 *
 * Does NOT terminate the agent loop. The model may continue with more
 * text or further tool calls after the attachment lands.
 */
import { stat } from "node:fs/promises";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { DiscordSender } from "../io/createDiscordSender.ts";

const discordMaxAttachmentBytes = 24 * 1024 * 1024;

export function createAttachTool(args: { sender: DiscordSender }) {
  const { sender } = args;
  return defineTool({
    name: "attach",
    label: "attach files",
    description: `Post a Discord message with file attachments (images, documents, generated artifacts). Use for sharing files only — plain text replies stream automatically as you write them. Each file path must be absolute, exist, be a regular file, and be ≤24MB. Discord allows up to 10 attachments per message.

Optional caption: pair a short \`content\` string with the files (≤1900 chars). For long-form prose, write it as normal assistant text — it streams to Discord on its own.`,
    parameters: Type.Object({
      files: Type.Array(Type.String(), {
        description:
          "Absolute paths of local files to attach. Each must exist, be a regular file, and be ≤24MB. 1-10 items.",
        minItems: 1,
        maxItems: 10,
      }),
      content: Type.Optional(
        Type.String({
          description:
            "Optional caption posted alongside the files (≤1900 chars). Skip this for the common case where streamed prose covers the explanation.",
        }),
      ),
      in_reply_to: Type.Optional(
        Type.String({
          description:
            "Optional Discord message ID to thread this attach-post under. Pull from `message_id=…` of the message you're answering.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const captionLength = params.content?.length ?? 0;
      if (captionLength > 1900) {
        return {
          content: [
            {
              type: "text",
              text: `Rejected: caption ${captionLength} chars exceeds the 1900 char limit. Shorten the caption — long prose should stream as plain text instead.`,
            },
          ],
          details: {
            captionLength,
            attachmentCount: 0,
            messageId: undefined as string | undefined,
          },
          isError: true,
          terminate: false,
        };
      }
      const validatedPaths = await validateAttachments(params.files);
      const result = await sender.attach({
        content: params.content,
        files: validatedPaths,
        inReplyTo: params.in_reply_to,
      });
      const summary = result.success
        ? `delivered ${validatedPaths.length} attachment${validatedPaths.length === 1 ? "" : "s"}`
        : "delivery failed";
      return {
        content: [{ type: "text", text: summary }],
        details: {
          captionLength,
          attachmentCount: validatedPaths.length,
          messageId: result.messageId,
        },
        terminate: false,
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
      console.error(`[attach] stat ${path} failed:`, error);
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
