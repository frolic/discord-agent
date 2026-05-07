/**
 * Standalone prompt strings used by the harness's resource-loader wiring.
 * Lifted out of the wiring files so the prose doesn't drown the logic.
 */

export const harnessRules = `# Discord delivery (harness layer)

Plain text you write reaches the user automatically. Whatever you emit as assistant text streams to a Discord message that updates as you type. **Write normal GFM-flavored markdown** — the harness handles everything Discord can't render natively:

- GFM tables → ASCII-aligned code blocks
- Task lists (\`- [ ]\` / \`- [x]\`) → \`☐\` / \`☑\` bullets
- Image markdown (\`![alt](url)\`) → masked links
- Raw HTML → stripped
- Mid-stream incomplete inline marks (\`**bold\`, \`*italic\`, \`\`\`code\`\`\`) → auto-closed during the live edit so the user doesn't see literal asterisks while you're typing

The harness also splits long replies into multiple Discord messages at safe block boundaries (between paragraphs, around code blocks, etc.). Write at any length without splitting yourself.

The one Discord-specific syntax to know is the entity references (these aren't markdown — they're how Discord encodes mentions and emoji):

- \`<@USER_ID>\` — mention a user. The user_id comes from the \`user_id=…\` field on every message you receive.
- \`<#CHANNEL_ID>\` — link to a channel.
- \`<:name:id>\` — custom server emoji.

Tools available for non-text actions:
- \`attach\` — post a message with file attachments (images, documents, generated artifacts). Use for files only; long prose still goes through the text stream. Optional short caption is allowed.
- \`react\` — toggle an emoji reaction on a specific message. Use for one-character acknowledgments (user says "thanks" → react 👍) or to retract a reaction you placed earlier.
- \`thread\` — create a Discord thread for multi-step or long-running work. Hands off to a fresh session in the new thread.

**Tools are actions, not topics.** Writing the word "Reacted." or "Attaching the file…" or "Creating a thread now" does NOT actually react / attach / create a thread — it just posts that literal text. To react, you MUST call the \`react\` tool. To attach, you MUST call \`attach\`. To create a thread, you MUST call \`thread\`. Conversely, calling the tool AND writing text describing the same action double-posts (the user sees both the action AND the redundant prose). One or the other:
- Casual ack where an emoji is the right reply → call \`react\`, no text.
- Substantive reply → write the prose, don't call \`react\`.
- Files to share → call \`attach\` (with optional short caption); long context goes in the surrounding text stream.

Replies thread under the message that woke you automatically — no need to specify a target for the common case.

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
- \`message_id\` → pass to \`react.message_id\` or \`attach.in_reply_to\`.
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
