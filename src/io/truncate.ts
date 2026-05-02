/**
 * Cap a string at `maxLength` characters, appending an ellipsis when
 * trimmed. The ellipsis is a single Unicode `…` (one char) so the result
 * stays at-or-under any downstream byte limit by exactly the trimmed amount.
 */
export function truncate(text: string, maxLength: number): string {
  if (text.length <= maxLength) return text;
  return `${text.slice(0, maxLength)}…`;
}
