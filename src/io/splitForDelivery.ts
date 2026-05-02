/**
 * Split a long text into Discord-sized sections. The agent can also opt
 * into multi-message replies via `\n---\n` markers — those take precedence
 * over the soft-limit fallback (sentence/paragraph break under softCharLimit).
 */
const softCharLimit = 1800;
const hardCharLimit = 1990;
const messageDelimiter = "\n---\n";

export function splitForDelivery(text: string): string[] {
  const sections: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    const delimiterIndex = remaining.indexOf(messageDelimiter);
    if (delimiterIndex !== -1 && delimiterIndex <= softCharLimit) {
      const head = remaining.slice(0, delimiterIndex).trim();
      if (head.length > 0) {
        sections.push(head);
      }
      remaining = remaining.slice(delimiterIndex + messageDelimiter.length);
      continue;
    }
    if (remaining.length <= hardCharLimit) {
      const trimmed = remaining.trim();
      if (trimmed.length > 0) {
        sections.push(trimmed);
      }
      remaining = "";
      continue;
    }
    const cutPoint = findFallbackCutPoint(remaining.slice(0, softCharLimit));
    const head = remaining.slice(0, cutPoint).trim();
    if (head.length > 0) {
      sections.push(head);
    }
    remaining = remaining.slice(cutPoint).trimStart();
  }
  return sections;
}

function findFallbackCutPoint(window: string): number {
  const paragraphBreak = window.lastIndexOf("\n\n");
  if (paragraphBreak > 0) return paragraphBreak;
  const sentenceBreak = Math.max(
    window.lastIndexOf(". "),
    window.lastIndexOf("! "),
    window.lastIndexOf("? "),
  );
  if (sentenceBreak > 0) return sentenceBreak + 1;
  return softCharLimit;
}
