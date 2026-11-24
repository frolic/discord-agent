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
 *   `edit_message`, and reasoning through `think` (which is never delivered).
 *   Provider reasoning stays at the configured default — turning it off was
 *   measured and it cost replies outright (see `docs/tools.md`).
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
 * Unset means "use the configured default", in both modes. `tools` mode used to
 * force `off` on the theory that `think` was the only reasoning outlet worth
 * paying for; an A/B over the same prompt set showed the opposite — with
 * reasoning off, half the replies were never delivered at all (the model wrote
 * "Sent." as prose instead of calling `send_message`) and the answers that did
 * arrive were shallower. See `docs/tools.md` for the numbers.
 *
 * The override remains for the opposite reason: some endpoints (e.g. Gemini via
 * OpenRouter) answer HTTP 400 "Reasoning is mandatory for this endpoint and
 * cannot be disabled", which has to be fixable with an env change.
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
