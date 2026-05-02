/** Replace ASCII backticks with the visually similar acute accent so the
 * surrounding Markdown code-fence isn't broken by user/tool content. */
export function sanitizeBackticks(text: string): string {
  return text.replace(/`/g, "´");
}
