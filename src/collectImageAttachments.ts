/**
 * Pull image attachments off a Discord message and return them as
 * pi-ai-shaped ImageContent (base64 data + mime). Non-image attachments
 * (PDFs, text, archives) are skipped — the model takes them via tool calls
 * (e.g., read).
 */
import type { Message } from "discord.js";
import type { ImageContent } from "@earendil-works/pi-ai";

export async function collectImageAttachments(message: Message): Promise<ImageContent[]> {
  const images: ImageContent[] = [];
  for (const attachment of message.attachments.values()) {
    if (!attachment.contentType?.startsWith("image/")) continue;
    const buffer = await fetch(attachment.url).then((response) => response.arrayBuffer());
    images.push({
      type: "image",
      data: Buffer.from(buffer).toString("base64"),
      mimeType: attachment.contentType,
    });
  }
  return images;
}
