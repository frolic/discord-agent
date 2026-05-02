# Tools and interaction

## How interaction works

**Single-player wake:** the harness wakes the agent on every non-bot
message in any channel or thread the bot can see. There's no @mention
requirement, no slash commands, no command syntax. (For a multi-tenant
server you'd want mention-gating; the place to extend is the
`messageCreate` handler in [`../src/installRouter.ts`](../src/installRouter.ts).)

**Text commands the harness handles directly** (these never reach the agent):

- `!stop` — abort whatever the agent is currently doing. Bot reacts 🛑.
- `!compact` — trigger pi's context compaction on the current session.
  Older messages get summarized into a single compaction entry, freeing
  context budget. Bot reacts 🗜️. Compaction also runs automatically at
  pi's threshold; this command just triggers it on demand.
- `!clear` — abort, drop the warm cache entry, delete this channel's
  `session.jsonl`. Next message starts a fresh conversation. Bot reacts 🗑️.
- `!restart` — exit the bot process; supervisor (systemd, Docker) restarts
  with current source. Bot reacts 🔄. Without a supervisor, the bot won't
  come back. Use when state is stuck or after pulling fresh code.
- Any other `!command` — bot reacts ❓.

**Steering mid-turn:** send another message while the agent is working.
The harness re-injects it as a steer between tool batches. The agent
finishes its current tool, then addresses your new message.

## Tools the agent has

Pi's defaults — **bash, read, write, edit** — plus five harness-specific
ones:

- **`send(text, more?, in_reply_to?, attachments?)`** — the only way
  visible text reaches the user. Raw assistant text is dropped by the
  harness. Multi-message replies: set `more: true` on every call except the
  last. Pass `in_reply_to=<message_id>` to thread the reply under a
  specific message (Discord shows a "replying to" badge). Attach files
  inline by passing absolute paths in `attachments` (≤24MB each, ≤10 per
  message).
- **`react(emoji, message_id)`** — toggle an emoji reaction on a specific
  message. Calling twice with the same emoji removes it. Use for "thanks /
  got it / 👍" style acknowledgments. The `message_id` is mandatory
  because every message the agent receives carries `message_id=…` in its
  formatted line.
- **`history(limit?, before?, after?, id?, channel_id?)`** — fetch
  messages from a Discord channel/thread, oldest-first. Cursor modes:
  `before` walks older, `after` walks newer (used by catchup hints),
  `id` returns just one specific message (e.g., the target of an
  `in_reply_to=…` you saw). `channel_id` defaults to the current channel.
- **`thread(name, initial_message, parent_message_id?)`** — create a
  Discord thread, post `initial_message` as the seed, and automatically
  wake a fresh agent session in the new thread using `initial_message` as
  the user prompt. The calling session terminates; work continues in the
  new thread's channel.
- **`restart_self(reason?)`** — exit the bot process so the supervisor
  (systemd, Docker, wrapper script) restarts with current source. Used
  after editing the framework, or as a recovery hatch. No-op if no
  supervisor is running.

## Why the envelope-tool pattern

The agent's raw assistant text is not delivered to Discord — the harness
drops it. Every visible reply must go through one of the three delivery
tools (`send`, `react`, `thread`). The set is centralized in
[`../src/agent/deliveryTools.ts`](../src/agent/deliveryTools.ts). This is
enforced by:

1. The system prompt mandating it (appended automatically — see
   [`../src/agent/prompts.ts`](../src/agent/prompts.ts)).
2. The harness ignoring assistant `message_update` events (raw text never
   gets rendered to Discord).
3. A silent-turn detector — if a turn produces no delivery tool, the
   harness augments the system prompt for one `agent.continue()` retry. If
   that retry is also silent, raw text is surfaced with a
   `*[harness fallback]*` prefix so the user always sees something.
4. A circuit breaker — runaway `send`-only loops get `session.abort()`
   on the 9th consecutive send-only turn. Encapsulated in
   [`../src/agent/createRunawayCounter.ts`](../src/agent/createRunawayCounter.ts).

Net result: the model can't half-deliver, can't accidentally narrate a
correction, and can't loop indefinitely. Behaviour is robust across
models that don't reliably honor `tool_choice` (e.g. DeepSeek).

## Debug channel

If you set `DEBUG_CHANNEL_ID` to a Discord channel ID, the harness
cross-posts operational logs to that channel — tool calls, per-call
usage, compaction events, and process lifecycle (startup, shutdown).
Useful for monitoring and post-mortems without scraping `journalctl`.

Tool-call lines are a masked link (tool name → either the user message
that triggered the run, or the channel itself for synthetic-prompt turns)
followed by all of the tool's args as `key=value` pairs. The first tool
call of each LLM batch carries the per-call usage suffix
(`<total>/<context-window> → <output> · $cost`):

```
-# 🟢 online
-# [bash](url) command="git status" · 6.8k/128k → 340 · $0.0017
-# [send](url) text="Here's what I found, …" in_reply_to="1500..."
-# [history](url) limit=50 · 67.8k/200k → 44 · $0.0001
-# ❌ react failed: message 1500... not found in this channel    ← reply-threaded under the start line
-# 🗜️ [compacting](url) context · trigger=manual
-# 🗜️ compacted · was 87.3k · "Summary preview..."
-# 🔴 offline — restart_self — applied typing-indicator fix
```

Failed tool calls produce a follow-up `❌` line threaded as a Discord
reply to the original start log, so the eye can correlate them visually.
Compaction events (`🗜️`) bracket each context summarization — start line
includes the trigger (`manual` / `threshold` / `overflow`); end line
shows the pre-compaction token count and a preview of the generated
summary. Lifecycle lines (`🟢` / `🔴`) bracket each process run, so a
restart cycle leaves a visible pair in the log.

The bot must be a member of the debug channel with Send Messages
permission.
