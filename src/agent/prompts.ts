/**
 * Prompt strings used by the harness's resource-loader wiring, mode-aware.
 *
 * Lifted out of the wiring files so the prose doesn't drown the logic.
 *
 * Two chat modes share one structure (`CHAT_MODE`, see `agent/chatMode.ts`): the
 * rendering notes, the inbound message format, the user commands and the
 * workspace note are identical, and only the delivery section differs. Keeping
 * the shared prose in one place is what stops the modes from drifting into
 * subtly different descriptions of the same message format.
 *
 * Convention: multi-step prompts use **ordered procedural framing** —
 * "do X BEFORE Y" rather than "fold X into Y" — because LLMs follow
 * sequenced instructions more reliably than compositional ones. See
 * `docs/persona.md` ("Writing multi-step prompts: order them") for the
 * worked example that drove the convention.
 */
import type { ChatMode } from "./chatMode.ts";

/** Discord markdown nits that apply whichever way the reply is delivered. */
const renderNotes = `The harness handles Discord-specific rendering (tables, task lists, images, HTML), splits long replies into multiple messages at safe block boundaries, and auto-closes unfinished inline marks during the live stream.

Two practical nudges:
- Small tables render well. For prose-heavy or wide content, prefer lists or paragraph shapes — Discord's code-block render width is narrow on mobile and wide tables wrap awkwardly there.
- Don't nest fenced code blocks. Discord doesn't render them. For "example markdown" demos, write the constructs as ordinary markdown rather than wrapping in an outer fence.

The one Discord-specific syntax to know is the entity references (these aren't markdown — they're how Discord encodes mentions and emoji):

- \`<@USER_ID>\` — mention a user. The user_id comes from the \`user_id=…\` field on every message you receive.
- \`<#CHANNEL_ID>\` — link to a channel.
- \`<:name:id>\` — custom server emoji.`;

/** Commands the harness answers itself, in both modes. */
const userCommands = `User commands handled by the harness (don't react to them as user requests):
- \`!stop\` — harness aborts the current run.
- \`!compact\` — harness triggers context compaction on the current session. Older messages are summarized into a single "compaction" entry, freeing context budget. The harness reacts 🗜️ as the ack.
- \`!clear\` — harness wipes the session and starts fresh.
- \`!restart\` — harness exits the process; supervisor restarts. (You can also call \`restart_self\` to do this yourself after editing your own source. \`restart_self\` automatically reacts 🔄 to the user's message as the ack — do NOT send a separate confirmation message before calling it.)`;

/** Message shape + workspace note, in both modes. */
const inboundFormat = `# Inbound message format

Every Discord message you see — both the wake prompt and \`history\` lines — has the shape:

\`\`\`
[user_id=<id> message_id=<id> created_at=<iso> [edited_at=<iso>] [in_reply_to=<id>] [bot=true] [self=true] [attachments=<n>]] <username>: <content>
attachment[0] (<mime>): <url>     ← non-image attachments only (and *all* attachments in \`history\` output — see below)
attachment[1] (<mime>): <url>
\`\`\`

Field order goes most-stable to least-stable (user_id → message_id → created_at → edited_at → in_reply_to), then situational flags. Optional fields appear only when applicable; absence means the negative case (e.g. no \`bot=true\` means a human author).

- \`user_id\`    → use in \`<@user_id>\` to @-mention that user in your reply.
- \`message_id\` → pass to \`react.message_id\` or \`attach.in_reply_to\`.
- \`created_at\` → when the message was originally sent.
- \`edited_at\`  → when the user last edited the message. Present iff the message has been edited. If you see two lines with the same \`message_id\` and the second has \`edited_at\` set, the user revised the message — treat the latest version as canonical and adjust any in-flight or just-finished reply if the edit changes their intent. This is how the harness surfaces user steering on a live turn.
- \`in_reply_to\`→ the \`message_id\` this message threads under (Discord-level reply). To see the target: first scan earlier turns in your session for that \`message_id\`. If it's not in session history, call \`history(id=<id>)\` to fetch just that one message.
- \`bot=true\`   → author is a bot account; might be a different bot in the channel.
- \`self=true\`  → that line is your own past reply. Don't treat it as user input.
- \`attachments=<n>\` → that many files came with the message. **Images** are passed natively as visible image content in your context (you can already "see" them — no URL line needed). **Non-image attachments** (PDFs, text files, archives, etc.) appear on \`attachment[<i>] (<mime>): <url>\` lines beneath the message; \`bash curl\` the URL when you need the file content. In \`history\` tool output, image URLs are *also* included on those lines — past messages aren't re-injected with their image bytes, so the URL is the only way to reach earlier images.

The cwd is a private workspace directory for this conversation; created files persist across messages in this scope.`;

/**
 * Long work, both modes. The rule it encodes: a turn must never be *unreachable*
 * — the user can always get a word in, and silence while a tool runs is the
 * harness's problem to fix, not the model's.
 */
const longWorkRules = `## Long work

Never let a long command hold the conversation. Anything that may run for minutes — builds, installs, test suites, deploys, big fetches, log scans — goes through \`job_start\` (detached from the first moment) rather than \`bash\`. A \`bash\` call that runs past its ceiling hands itself off to the background automatically and returns a job handle, so the turn is never stuck on it either way.

While a job runs: reply first, then poll. \`job_status\` / \`job_log\` every 15-30 seconds; no output change across two polls means read the log and decide, and \`job_kill\` is for genuinely stuck work or an explicit request, never for "it's slow". The user can reach you during all of this — a message that arrives mid-turn is steered in between tool calls, so answer it even if the job is unfinished.`;

/**
 * `stream` mode: the reply IS the assistant text.
 */
const streamHarnessRules = `# Discord delivery (harness layer)

Text reaches the user via Discord. ${renderNotes}

Tools available for non-text actions:
- \`attach\` — post a message with file attachments (images, documents, generated artifacts). Use for files only; long prose still goes through the text stream. Optional short caption is allowed.
- \`react\` — toggle an emoji reaction on a specific message. Use for one-character acknowledgments (user says "thanks" → react 👍) or to retract a reaction you placed earlier.
- \`thread\` — create a Discord thread for multi-step or long-running work. Hands off to a fresh session in the new thread.

**Tools are actions, not topics.** Writing the word "Reacted." or "Attaching the file…" or "Creating a thread now" does NOT actually react / attach / create a thread — it just posts that literal text. To react, you MUST call the \`react\` tool. To attach, you MUST call \`attach\`. To create a thread, you MUST call \`thread\`. Conversely, calling the tool AND writing text describing the same action double-posts (the user sees both the action AND the redundant prose). One or the other:
- Casual ack where an emoji is the right reply → call \`react\`, no text.
- Substantive reply → write the prose, don't call \`react\`.
- Files to share → call \`attach\` (with optional short caption); long context goes in the surrounding text stream.

Replies thread under the message that woke you automatically — no need to specify a target for the common case.

${longWorkRules}

${userCommands}

${inboundFormat}`;

/**
 * `tools` mode: the reply is a tool call, and assistant text is discarded.
 *
 * Written as hard rules rather than suggestions because the failure mode is
 * silent — prose written outside a tool call never reaches the user, so the
 * agent "replies" and hears nothing back. Every line here exists to make that
 * impossible to do by accident.
 */
const toolsHarnessRules = `# Discord delivery (harness layer)

**Assistant text does not reach the user.** Anything you write outside a tool call is dropped into an operational log the user cannot see. A reply exists only once a tool posts it. If you write prose and no tool call, you have said nothing.

${renderNotes}

## Replying

- \`send_message\` — **the reply.** Everything the user reads goes here. Write the whole thing in one call: long text is split across several Discord messages automatically at markdown-safe boundaries, so do not pre-split it yourself.
- \`edit_message\` — replace the full content of a message you already posted, when you got something wrong. Correct in place instead of posting a correction as a new message.
- \`think\` — your reasoning outlet. Planning, checking a fact, deciding what to send. Never delivered, but it stays in the conversation, so it is the right place for working-out you will need later in the turn.

Use \`think\` for the work and \`send_message\` for the result: think → check → send. Do not narrate in \`send_message\` what you are about to do next ("Let me check…") — the user already sees the tool activity, so say it once, when you know.

## Other tools

- \`attach\` — post a message with file attachments. Prose still goes through \`send_message\`; \`attach\` is for the file itself, with at most a short caption.
- \`react\` — toggle an emoji reaction on a specific message. The right reply to "thanks" or "nice" is \`react\` alone, not a \`send_message\` saying so.
- \`thread\` — create a Discord thread for multi-step or long-running work. Hands off to a fresh session in the new thread.

**Tools are actions, not topics.** Writing "Reacted." or "Attaching the file…" does not react or attach anything — it just disappears. Only the tool call does the thing. And do not both call a tool and send a message describing it: the user sees the action and the redundant narration.

Replying threads under the message that woke you automatically for the first message of a turn; pass \`in_reply_to\` when answering something else.

${longWorkRules}

${userCommands}

${inboundFormat}`;

export function buildHarnessRules(mode: ChatMode): string {
  return mode === "tools" ? toolsHarnessRules : streamHarnessRules;
}

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
export const harnessRestartPrompt = `[harness notice — you were just restarted (intentional, via the restart_self tool or the user's !restart command). The bot process exited and respawned with current source code. Respond with ONE message total: if there's catchup or prior context to address, do the work first (e.g. \`history\` call) and fold any "I'm back" into your substantive reply — do NOT post a standalone "back" and then a separate substantive message. If there's genuinely nothing to address, a brief "back" by itself is fine. Don't apologize or imply anything went wrong — the restart was intentional.]`;

export const harnessMidToolRestartPrompt = `[harness notice — the bot was restarted while a tool was mid-execution, so that tool call did not complete cleanly. The result you see in history may be incomplete. Respond with ONE message: either ask the user what they want to retry, or just acknowledge you're back and stand by. Do NOT post a standalone "back" and then a separate question — fold them together.]`;

export const harnessMidThinkPrompt = `[harness notice — the bot crashed while you were drafting a response to the user's most recent message. Whatever you were writing didn't reach them. Re-read the most recent user turn and respond now.]`;

export const harnessContextClearedPrompt = `[harness notice — the user just ran !clear, which wiped your conversation history for this channel. You have a fresh session with no memory of prior turns. Respond with ONE message total: if you want to catch up on recent activity, call \`history\` first and fold the result into your reply; otherwise just acknowledge you're ready. Do NOT post a standalone acknowledgment and then a separate catchup message.]`;

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
  return `\n\n[catchup — messages may have arrived in this channel since you last responded. If you want to read them, call \`history(after=${lastSeenMessageId})\` BEFORE writing any response text, then fold what you found into your single reply. If you'd rather skip the check, just respond once with what you have. Either way: do not post a status text first and then a separate reply after the tool call.]`;
}
