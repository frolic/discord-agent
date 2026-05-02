/**
 * Read each local file path into an in-memory AttachmentBuilder. Missing
 * files are skipped silently — Discord will still post the message text,
 * just without that attachment.
 */
import { basename } from "node:path";
import { AttachmentBuilder } from "discord.js";

export async function buildAttachments(filePaths: string[]): Promise<AttachmentBuilder[]> {
  const attachments: AttachmentBuilder[] = [];
  for (const filePath of filePaths) {
    const file = Bun.file(filePath);
    if (!(await file.exists())) continue;
    const content = Buffer.from(await file.arrayBuffer());
    attachments.push(new AttachmentBuilder(content, { name: basename(filePath) }));
  }
  return attachments;
}
