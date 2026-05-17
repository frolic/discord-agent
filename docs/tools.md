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
- `!clear` — abort, drop the warm cache entry, and archive this channel's
  `session.jsonl` to `sessions-archive/<channelId>-<YYYYMMDD-HHMMSS>.jsonl`
  (UTC timestamp = clear time). Next message starts a fresh conversation;
  prior conversations stay on disk for debugging. Bot reacts 🗑️.
- `!restart` — exit the bot process; supervisor (systemd, Docker) restarts
  with current source. Bot reacts 🔄. Without a supervisor, the bot won't
  come back. Use when state is stuck or after pulling fresh code.
- Any other `!command` — bot reacts ❓.

**Steering mid-turn:** send another message while the agent is working.
The harness re-injects it as a steer between tool batches. The agent
finishes its current tool, then addresses your new message.

## Tools the agent has

Pi's defaults — **bash, read, write, edit** — plus five harness-specific
ones. The trade-off in giving the agent unrestricted shell and
filesystem access is power vs blast radius — the assumption is a
trusted home rather than a hostile sandbox.

- **Plain text streams to Discord automatically.** The agent writes
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
  with seam selection in [`../src/streaming/findSafeSplit.ts`](../src/streaming/findSafeSplit.ts)
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
- **`restart_self(reason?)`** — exit the bot process so the supervisor
  (systemd, Docker, wrapper script) restarts with current source. Used
  after editing the framework, or as a recovery hatch. No-op if no
  supervisor is running.

## How streaming text reaches Discord

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
