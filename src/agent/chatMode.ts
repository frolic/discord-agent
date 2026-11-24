/**
 * How assistant output reaches the user channel.
 *
 * - `stream` (default, and the behaviour before this mode existed): assistant
 *   text deltas are the reply. The harness opens a dispatcher per text block and
 *   edits Discord messages live. Tools exist only for things text can't do
 *   (react, attach, thread).
 * - `tools`: assistant text goes *nowhere the user can see* (the harness posts it
 *   to the debug channel so a misbehaving model is visible to an operator).
 *   Replies happen exclusively through `send_message`, corrections through
 *   `edit_message`, and reasoning through `think`. Provider reasoning is turned
 *   off so `think` is the only reasoning outlet.
 *
 * Both paths stay in the tree: the mode is an env flag so one restart flips it,
 * and an A/B comparison is a restart each way.
 */
export type ChatMode = "stream" | "tools";

/**
 * Parse `CHAT_MODE`. Unknown values throw rather than silently falling back —
 * a typo that quietly means "stream" would look like the mode change didn't
 * work, and the failure would only show up as a mystery reply format.
 */
export function parseChatMode(raw: string | undefined): ChatMode {
  if (raw === undefined || raw.trim().length === 0) return "stream";
  const value = raw.trim();
  if (value === "stream" || value === "tools") return value;
  throw new Error(`CHAT_MODE must be "stream" or "tools" (got "${raw}")`);
}
