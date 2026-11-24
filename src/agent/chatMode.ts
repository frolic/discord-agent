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

/** pi's thinking levels, in ascending effort. `off` means no provider reasoning. */
export const chatThinkingLevels = [
  "off",
  "minimal",
  "low",
  "medium",
  "high",
  "xhigh",
  "max",
] as const;

export type ChatThinkingLevel = (typeof chatThinkingLevels)[number];

/**
 * Parse `CHAT_THINKING_LEVEL`, the explicit override for the provider thinking
 * level this harness asserts on every session.
 *
 * Unset means "let the mode decide": `off` in `tools` mode (`think` is the only
 * reasoning outlet there), the configured default in `stream` mode.
 *
 * The override exists because reasoning-off is not universally available: some
 * endpoints (e.g. Gemini behind OpenRouter) answer HTTP 400 "Reasoning is
 * mandatory for this endpoint and cannot be disabled". That has to be fixable
 * with an env change rather than a code change.
 */
export function parseChatThinkingLevel(raw: string | undefined): ChatThinkingLevel | null {
  if (raw === undefined || raw.trim().length === 0) return null;
  const value = raw.trim();
  const match = chatThinkingLevels.find((level) => level === value);
  if (!match) {
    throw new Error(`CHAT_THINKING_LEVEL must be one of ${chatThinkingLevels.join(", ")} (got "${raw}")`);
  }
  return match;
}
