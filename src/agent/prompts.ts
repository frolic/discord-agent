/**
 * Standalone prompt strings used by the harness's resource-loader wiring
 * and the envelope-enforcement retry. Lifted out of those files so the
 * prose doesn't drown the logic.
 */

export const harnessRules = `# Discord delivery (harness layer — non-negotiable)

Every reply to the user MUST go through ONE of these two tools. Raw text in your assistant message is NOT delivered — the user cannot see it. Pick the right tool per turn:

- \`send\` — full text reply. Default for anything but trivial acknowledgments.
- \`react\` — toggle an emoji reaction on a specific message. If you already reacted with that emoji it gets removed; otherwise it's added. Use when a single emoji is sufficient (e.g., user says "thanks" / "got it" → react 👍), or to retract a reaction you placed earlier.

If you call neither, the user sees nothing.

For send:
- Single reply (most common): call once with just \`text\`. The agent loop ends after delivery.
- Multi-message reply: call multiple times. On every call EXCEPT the last, set \`more: true\` so the loop keeps going. On the final call, omit \`more\` (or set it to false) — the loop ends and you're done.
- Forgetting \`more: true\` on an intermediate call cuts the reply short after that message. Forgetting to omit it on the last call risks looping.
- Each call ≤ ~1900 characters.
- Plain prose with Discord markdown (\`**bold**\`, \`*italic*\`, \`\\\`code\\\`\`, code fences). Don't wrap whole replies in code blocks.
- No emojis in send text — reserve emojis for react.
- \`in_reply_to\`: Discord message ID to thread this reply under (Discord shows a "replying to" badge linking back). DEFAULT to the \`message_id=…\` of whatever message you're answering — including the wake prompt at the top of your turn, which is the most common case. Omit only for spontaneous/unprompted messages, continuation parts of a multi-message reply (set it on the first part only), or general broadcasts not aimed at one message. Threading by default keeps multi-person channels readable.

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
 */
export const harnessRestartPrompt = `[harness notice — you were just restarted (intentional, via the restart_self tool or the user's !restart command). The bot process exited and respawned with current source code. Acknowledge briefly that you're back, in your usual voice. If the user's prior turn asked for anything beyond the restart itself, address that too.]`;

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
 */
export const harnessReminderSuffix = `

---

[HARNESS NOTICE — for this single turn only, not part of the user-facing conversation]

Your previous assistant turn produced raw text but did NOT call send. The harness dropped that turn entirely — the user saw nothing. Re-emit the intended content now via send. Do NOT apologize, do NOT say "let me try again" or "sorry about that", do NOT reference this notice. The user is unaware of the previous attempt; from their perspective, this is your first reply.`;
