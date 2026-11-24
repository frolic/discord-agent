# Tools and interaction

## How interaction works

**Single-player wake:** the harness wakes the agent on every non-bot
message in any channel or thread the bot can see. There's no @mention
requirement, no slash commands, no command syntax — direct conversations
stay frictionless. A multi-tenant server would want mention-gating,
allowlists, or role checks instead; the place to extend is the
`messageCreate` handler in [`../src/installRouter.ts`](../src/installRouter.ts).

**Text commands the harness handles directly** (these never reach the agent):

- `!stop` — abort whatever the agent is currently doing. Bot reacts 🛑.
- `!compact` — trigger pi's context compaction on the current session.
  Older messages get summarized into a single compaction entry, freeing
  context budget. Bot reacts 🗜️. Compaction also runs automatically at
  pi's threshold; this command just triggers it on demand.
- `!clear` — abort, drop the warm cache entry, and gzip this channel's
  `session.jsonl` into `sessions/archive/<channelId>-<YYYYMMDD-HHMMSS>.jsonl.gz`
  (UTC timestamp = clear time). Next message starts a fresh conversation;
  prior conversations stay on disk compressed for debugging — read with
  `gunzip -c <path>`. Bot reacts 🗑️.
- `!restart` — exit the bot process; supervisor (systemd, Docker) restarts
  with current source. Bot reacts 🔄. Without a supervisor, the bot won't
  come back. Use when state is stuck or after pulling fresh code.
- Any other `!command` — bot reacts ❓.

**Steering mid-turn:** send another message while the agent is working.
The harness re-injects it as a steer between tool batches. The agent
finishes its current tool, then addresses your new message.

## Chat modes (`CHAT_MODE`)

There are two ways the agent's output reaches the user, chosen by the
`CHAT_MODE` env var. Both live in the same binary; flipping the mode is one env
change and a restart, which is also how you A/B them.

| | `stream` (default) | `tools` |
|---|---|---|
| The reply | assistant text | a `send_message` tool call |
| Reasoning | provider thinking, if the model has it | the `think` tool, provider reasoning off |
| Texts on a tool call | fine | normal |
| Text the model writes outside a tool call | that *is* the reply | logged to the debug channel, never delivered |
| Extra tools | — | `send_message`, `edit_message`, `think` |

**`stream`** is the original behaviour, described below: the agent writes
markdown and the harness streams it into Discord messages, editing them as the
text grows.

**`tools`** exists for models and workloads where you want the reply to be an
explicit act rather than a side effect of generating tokens. The model's prose
is no longer the delivery channel — it calls `send_message(text, in_reply_to?)`,
corrects itself with `edit_message(message_id, text)`, and thinks out loud with
`think(thought)`, which stays in the transcript and never reaches Discord. Text
the model writes outside a tool call is cross-posted to `DEBUG_CHANNEL_ID` (so a
model that forgot to call the tool is visible to an operator instead of silently
saying nothing) and never reaches the user channel.

Provider reasoning is switched off in `tools` mode (`session.setThinkingLevel("off")`)
so `think` is the only reasoning outlet — otherwise the same work gets split
between an invisible thinking block and an explicit tool. Some endpoints refuse
to disable reasoning outright (OpenRouter answers HTTP 400
`Reasoning is mandatory for this endpoint and cannot be disabled` for Gemini);
set `CHAT_THINKING_LEVEL` to override, e.g. `CHAT_THINKING_LEVEL=high`.

### The typing effect in `tools` mode

Tool-call arguments stream too, so the live-typing effect survives: the harness
reads the `text` field out of the growing argument JSON
([`../src/streaming/partialJsonStringField.ts`](../src/streaming/partialJsonStringField.ts)),
previews it into a live message, and at `toolcall_end` replaces the preview with
the authoritative parsed text (`replaceSource`) so a partial unescape is
corrected in place rather than delivered. The tool then *claims* the streamed
delivery instead of posting a second copy.

In practice how visible that is depends on the provider: OpenRouter hands pi the
whole argument object in one or two chunks for the models we run, so a
`tools`-mode reply usually appears fully formed (no growth to watch), while
`stream` mode — where the granularity is per-token text deltas — always shows the
text growing. The code path is covered by
[`../src/agent/createSendMessageDelivery.test.ts`](../src/agent/createSendMessageDelivery.test.ts).

### Checking a mode for real

[`../src/bin/chat-mode-smoke.ts`](../src/bin/chat-mode-smoke.ts) drives one live
turn through the real pool in a real channel and reports what reached Discord
(messages, edits, debug-channel lines), asserting the mode-specific expectations.
Run it from the agent home against a channel with no live session:

```bash
CHAT_MODE=tools CHAT_SMOKE_CHANNEL_ID=123 CHAT_SMOKE_EXPECT=abc \
  bun /path/to/discord-agent/src/bin/chat-mode-smoke.ts "reply with abc"
```

## Tools the agent has

Pi's defaults — **bash, read, write, edit** — plus the harness-specific ones
below. In `tools` mode `send_message`, `edit_message` and `think` join them; in
`stream` mode they are not registered. The trade-off in giving the agent
unrestricted shell and filesystem access is power vs blast radius — the
assumption is a trusted home rather than a hostile sandbox.

- **Plain text streams to Discord automatically (`stream` mode).** The agent writes
  standard GFM-flavored markdown — the format any LLM naturally produces
  — and the harness translates the bits Discord can't render before
  posting: tables become ASCII-aligned code blocks, task lists become
  `☐` / `☑` bullets, image markdown becomes masked links, raw HTML is
  stripped, and incomplete inline marks (mid-stream `**bold`) are
  auto-closed by [`remend`](https://github.com/vercel/streamdown/tree/main/packages/remend)
  so the live edit doesn't show literal asterisks.
  Long replies split at safe top-level block boundaries (between
  paragraphs, around code blocks, between list groups, etc.). The full
  pipeline is in [`../src/streaming/prepareForDelivery.ts`](../src/streaming/prepareForDelivery.ts)
  with seam selection in [`../src/streaming/chunkRendered.ts`](../src/streaming/chunkRendered.ts)
  and the post/edit driver in
  [`../src/streaming/createStreamingDispatcher.ts`](../src/streaming/createStreamingDispatcher.ts).
- **`attach(files, content?, in_reply_to?)`** — post a Discord message
  with file attachments (≤24MB each, ≤10 per message). Optional caption
  for short headlines; long prose still goes through the text stream.
  Use for sharing generated artifacts, images, documents.
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
- **`send_message(text, in_reply_to?)`** (`tools` mode) — the reply. Chunked
  and rendered exactly like streamed text, so a long reply is still split across
  several Discord messages at markdown-safe boundaries. Returns the message IDs,
  which is what makes `edit_message` possible.
- **`edit_message(message_id, text)`** (`tools` mode) — replace the whole
  content of a message the bot posted. Refuses rather than truncates when the
  rendered text would exceed one Discord message, and refuses to touch other
  people's messages.
- **`think(thought)`** (`tools` mode) — reasoning outlet. Returns `ok`, logs a
  truncated preview to the journal, stays in the transcript for later turns, and
  is never posted.
- **`bash(command, timeout?)`** — pi's shell tool, wrapped so it cannot hold the
  turn hostage: the command runs as a detached job and the tool waits only up to
  a ceiling (`BASH_CEILING_SECS`, default 110s). Finished inside the ceiling →
  the output comes back exactly as before. Still running → the call returns a job
  handle plus the tail so far, and the command keeps going. An explicit `timeout`
  still means *kill* after N seconds.
- **`job_start(name, command)`** — start a command detached from the first
  moment. Use it when the work is already known to be long, so you can reply
  without waiting at all.
- **`job_status(name?)`** — running/finished with its exit code, plus a log tail;
  omitting `name` lists every job. **`job_log(name, lines?)`** reads the log.
  **`job_kill(name)`** sends SIGTERM to the job's process group.
- **`restart_self(reason?)`** — exit the bot process so the supervisor
  (systemd, Docker, wrapper script) restarts with current source. Used
  after editing the framework, or as a recovery hatch. No-op if no
  supervisor is running.

## Long work and progress notes

Job state lives on disk: `<agent home>/jobs/<name>/{log,pid,meta.json}`. A job
survives the tool call, the turn, and an agent restart, and is never auto-killed —
a poll that sees no output is a question for the agent, not grounds to kill a
build.

Silence while a tool runs is covered by the **typing indicator**, not by status
messages: it is set on `turn_start`, re-pulsed every 7 seconds (inside Discord's
~10 second fade), and cleared only at `agent_end`. A tool call that takes minutes,
a compaction, and a job being polled across turns all show the same thing — the
agent is working — with nothing extra posted to the channel.

`src/bin/async-smoke.ts` is the live check for the whole story: in one real turn
it starts a 150s job, replies while it runs, gets steered mid-turn (ack 👀,
reply lands), and confirms the typing indicator kept pulsing through a slow
command without posting any status lines. Run it against a parent
channel — it creates its own private thread so it never races the live bot:

```bash
CHAT_MODE=tools CHAT_SMOKE_CHANNEL_ID=<channel> \
  bun /path/to/discord-agent/src/bin/async-smoke.ts
```

## How streaming text reaches Discord

(`stream` mode. `tools` mode streams tool-call arguments instead — see above.)

Each text content block in an assistant message becomes its own chain of
Discord messages. The first delta posts a message after a short debounce
so a flurry of fast tokens batch into a single send; subsequent deltas
edit the same message on a longer debounce (Discord's per-channel edit
bucket is small).

On every flush, the raw buffer goes through `prepareForDelivery`:
[`remend`](https://github.com/vercel/streamdown/tree/main/packages/remend)
closes any unfinished inline marks at the suffix, [`remark`](https://www.npmjs.com/package/remark)
+ [`remark-gfm`](https://www.npmjs.com/package/remark-gfm) parses the
result into an mdast AST, transform visitors rewrite tables / task
lists / images / HTML / `__bold__`, and `remark-stringify` emits each
top-level block back to markdown — accumulating both the rendered text
and a list of (rawStart, rawEnd, renderedStart, renderedEnd) per block.

When the rendered length outgrows what one Discord message can hold,
[`findSafeSplit`](../src/streaming/findSafeSplit.ts) picks the latest
top-level block boundary at-or-before the soft limit. The current
message is edited down to the seal point (potentially shorter than
what's currently displayed — the rollback case) and the raw buffer
slices past the consumed offset so the carry-over re-renders fresh on
the next message. Forced fallbacks (within-block word boundary, code-
fence close-and-reopen, hard cut) kick in only when the buffer is past
the hard limit or the stream has ended without a clean seam.

The first streamed message of an agent run threads under the user
message that woke the run; later messages don't, so a multi-step turn
doesn't repeat the reply badge.

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
-# [attach](url) files=["/.../report.pdf"] content="here's the writeup" · 67.8k/200k → 44 · $0.0001
-# [history](url) limit=50
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
