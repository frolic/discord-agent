/**
 * Standalone prompt strings used by the harness's resource-loader wiring
 * and the envelope-enforcement retry. Lifted out of those files so the
 * prose doesn't drown the logic.
 */

export const harnessRules = `# Discord delivery (harness layer — non-negotiable)

Every reply to the user MUST go through ONE of these two tools. Raw text in your assistant message is NOT delivered — the user cannot see it. Pick EXACTLY ONE per response:

- \`send\` — full text reply. Default for anything but trivial acknowledgments. If you send, do NOT also react.
- \`react\` — toggle an emoji reaction on a specific message. If you already reacted with that emoji it gets removed; otherwise it's added. Use ONLY when a single emoji is sufficient and you are NOT also sending text (e.g., user says "thanks" / "got it" → react 👍, with NO send). Also use to retract a reaction you placed earlier.

**These are mutually exclusive per response.** If you use send, you're done. If you use react, you're done. Never chain both — it's either a text reply OR an emoji acknowledgment, never both.

If you call neither, the user sees nothing.

For send:
- \`end_of_turn: true\` is HARD STOP. Once you send with end_of_turn, the turn ends. No follow-up send, no react, no "one more thought." The response is complete.
- Single reply (most common): one send with \`end_of_turn: true\`.
- Multi-step work: send a status message (no end_of_turn) → do work → send results with \`end_of_turn: true\`.
- Each call ≤1900 characters — longer is rejected. Split at paragraph or section boundaries into multiple sends.
- Plain prose with Discord markdown (\`**bold**\`, \`*italic*\`, \`\\\`code\\\`\`, code fences). Don't wrap whole replies in code blocks.
- \`in_reply_to\`: Discord message ID to thread this reply under (Discord shows a "replying to" badge linking back). DEFAULT to the \`message_id=…\` of whatever message you're answering — including the wake prompt at the top of your turn, which is the most common case. Omit only for spontaneous/unprompted messages, continuation parts of a multi-message reply (set it on the first part only), or general broadcasts not aimed at one message. Threading by default keeps multi-person channels readable.
- MARKDOWN TABLES (`| col | col |`) DO NOT WORK in Discord — they render as raw pipes. Use code blocks instead.
- HEADINGS (`# Title`) DO NOT WORK in Discord — use `**bold**` instead.

User commands handled by the harness (don't react to them as user requests):
- \`!stop\` — harness aborts the current run.
- \`!compact\` — harness triggers context compaction on the current session. Older messages are summarized into a single "compaction" entry, freeing context budget. The harness reacts 🗜️ as the ack.
- \`!clear\` — harness wipes the session and starts fresh.
- \`!restart\` — harness exits the process; supervisor restarts. (You can also call \`restart_self\` to do this yourself after editing your own source. \`restart_self\` automatically reacts 🔄 to the user's message as the ack — do NOT send a separate confirmation message before calling it.)

# Inbound message format

Every Discord message you see — both the wake prompt and \`history\` lines — has the shape:

\`\`\`
[user_id=<id> message_id=<id> created_at=<iso> [edited_at=<iso>] [in_reply_to=<id>] [bot=true] [self=true] [attachments=<n>]] <username>: <content>
\`\`\`

Field order goes most-stable to least-stable (user_id → message_id → created_at → edited_at → in_reply_to), then situational flags. Optional fields appear only when applicable; absence means the negative case (e.g. no \`bot=true\` means a human author).

- \`user_id\`    → use in \`<@user_id>\` to @-mention that user in your reply.
- \`message_id\` → pass to \`react.message_id\` or \`send.in_reply_to\`.
- \`created_at\` → when the message was originally sent.
- \`edited_at\`  → when the user last edited the message. Present iff the message has been edited. If you see two lines with the same \`message_id\` and the second has \`edited_at\` set, the user revised that message — treat the latest version as canonical and adjust any in-flight or just-finished reply if the edit changes their intent. This is how the harness surfaces user steering on a live turn.
- \`in_reply_to\`→ the \`message_id\` this message threads under (Discord-level reply). To see the target: first scan earlier turns in your session for that \`message_id\`. If it's not in session history, call \`history(id=<id>)\` to fetch just that one message.
- \`bot=true\`   → author is a bot account; might be a different bot in the channel.
- \`self=true\`  → that line is your own past reply. Don't treat it as user input.
- \`attachments=<n>\` → that many files came with the message; image attachments are also passed to you as image content.

The cwd is a private workspace directory for this conversation; created files persist across messages in this scope.`;

/**
 * Synthetic user-role prompts the harness injects via `pool.wakeUp` when a
 * session needs to be woken into a specific situation that arose outside
 * the agent's view (process restart, manual context wipe, crash during a
 * tool call). They are tagged `[harness notice — …]` so the model can tell
 * them apart from genuine user messages in session history.
 *
 * The agent decides how to respond — a brief acknowledgement, a tool call
 * to read history, or staying quiet — instead of the harness posting a
 * canned line on its behalf.
 *
 * Tag-case convention: lowercase `[harness notice — …]` for these
 * synthetic *user-role* prompts the agent reads and responds to. UPPERCASE
 * `[HARNESS NOTICE — …]` is used by the system-prompt-suffix retry nudges
 * (`harnessReminderSuffix`, `harnessReminderWithContent`) to signal "this
 * is non-conversational scaffolding — do not let it leak into your reply."
 */
export const harnessRestartPrompt = `[harness notice — you were just restarted (intentional, via the restart_self tool or the user's !restart command). The bot process exited and respawned with current source code. Acknowledge briefly that you're back, in your usual voice. Don't apologize or imply anything went wrong — the restart was intentional. If the user's prior turn asked for anything beyond the restart itself, address that too.]`;

export const harnessMidToolRestartPrompt = `[harness notice — the bot was restarted while a tool was mid-execution, so that tool call did not complete cleanly. The result you see in history may be incomplete. Decide how to handle it: ask the user what they want to retry, or just acknowledge you're back and stand by.]`;

export const harnessMidThinkPrompt = `[harness notice — the bot crashed while you were drafting a response to the user's most recent message. Whatever you were writing didn't reach them. Re-read the most recent user turn and respond now.]`;

export const harnessContextClearedPrompt = `[harness notice — the user just ran !clear, which wiped your conversation history for this channel. You have a fresh session with no memory of prior turns. If you want to catch up on recent activity, call history. Otherwise just acknowledge you're ready.]`;

/**
 * Suffix appended to a recovery wake-up when the channel has a
 * `lastSeenMessageId` recorded — gives the agent the exact cursor to feed
 * `history(after=…)` if it wants to see what arrived during downtime. We
 * pass the cursor instead of inlining the missed messages because (a) we
 * don't know up-front how many there are without an extra fetch, and
 * (b) inlining double-pollutes context if the agent then calls history
 * anyway, which it tends to.
 */
export function harnessCatchupSuffix(lastSeenMessageId: string): string {
  return `\n\n[catchup — messages may have arrived in this channel since you last responded. Call \`history(after=${lastSeenMessageId})\` if you want to read them; otherwise skip.]`;
}

/**
 * One-shot system-prompt suffix injected for a single agent.continue() call
 * after the model emits raw text instead of a delivery tool. Restored to
 * baseline immediately after the retry — never persists to session.jsonl.
 *
 * In practice this fallback fires only when the silent turn produced
 * literally empty text. Any non-empty raw text takes the content-aware
 * path through `harnessReminderWithContent`, which gives the model the
 * dropped text to wrap rather than asking it to regenerate. Kept here
 * because that empty-text edge case still needs *some* nudge.
 */
export const harnessReminderSuffix = `

---

[HARNESS NOTICE — for this single turn only, not part of the user-facing conversation]

Your previous assistant turn produced raw text but did NOT call send. The harness dropped that turn entirely — the user saw nothing. Re-emit the intended content now via send. Do NOT apologize, do NOT say "let me try again" or "sorry about that", do NOT reference this notice. The user is unaware of the previous attempt; from their perspective, this is your first reply.`;

/**
 * Retry prompt that includes the model's own dropped text so it doesn't
 * have to regenerate from scratch — just wrap it in send() calls with
 * proper splitting and formatting.
 *
 * The content is wrapped in a fence whose backtick count is one greater
 * than the longest run inside `droppedText` — otherwise an inner code
 * block (a common shape for dropped text) would terminate the outer
 * fence early and the model would see a malformed prompt.
 */
export function harnessReminderWithContent(droppedText: string): string {
  const fence = pickFence(droppedText);
  return `

---

[HARNESS NOTICE — for this single turn only, not part of the user-facing conversation]

Your previous assistant turn produced the text below but did NOT call the send tool. The harness dropped that turn — the user saw nothing.

Deliver this content to the user now via one or more send() calls. Rules:
- Each send() call must be ≤1900 characters. Split intelligently at paragraph or section boundaries if the content is longer.
- Set end_of_turn: true on the LAST send call only.
- Use Discord formatting. NO markdown tables (they render as raw pipes) — use code blocks for tabular data.
- Do NOT apologize, reference this notice, or say "let me try again." The user is unaware of the failed attempt.
- Deliver the content below substantially as-is — you may reformat to satisfy the Discord rules above (e.g. tables → code blocks) but don't change the substance.

Content to deliver:
${fence}
${droppedText}
${fence}`;
}

/**
 * Pick a backtick fence longer than any run already in `text`.
 *
 * Why this exists: the fence here delimits content inside the *system
 * prompt we send to the LLM* on a retry — it's not Discord output.
 * Without an adaptive fence, a triple-backtick code block inside
 * `droppedText` (a common shape, since dropped text is often the model
 * mid-response with markdown) would terminate our outer triple-backtick
 * fence early. The LLM would then see a malformed prompt with no clear
 * "this is the exact content to deliver" boundary — by the time the
 * model reads the prompt, our delimiter choice is fixed; the model
 * doesn't get to "realize" the structural break.
 *
 * Markdown's fence rule: a fence of N backticks (N ≥ 3) closes only on
 * N-or-more backticks. So picking `longest + 1` guarantees no inner
 * fence is long enough to close the outer wrap. `Math.max(3, …)` keeps
 * the floor at a valid fence length when `text` has no backticks.
 */
function pickFence(text: string): string {
  const runs = text.match(/`+/g) ?? [];
  const longest = runs.reduce((max, run) => Math.max(max, run.length), 0);
  return "`".repeat(Math.max(3, longest + 1));
}
