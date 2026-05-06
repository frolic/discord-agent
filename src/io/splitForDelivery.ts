/**
 * Split text into Discord-sized sections. Only splits when text exceeds
 * the hard character limit — the send tool rejects >1900 chars upstream,
 * so this is a safety net, not the primary splitting mechanism.
 *
 * Previously split on `\n---\n` markers as an explicit split hint, but
 * that collided with YAML frontmatter and markdown horizontal rules
 * inside code blocks. Removed: the model is now responsible for splitting
 * content across multiple send calls at natural boundaries.
 */
const softCharLimit = 1800;
const hardCharLimit = 1990;

export function splitForDelivery(text: string): string[] {
  const sections: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
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
