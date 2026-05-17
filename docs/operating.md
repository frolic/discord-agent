# Operating

## Recommended host

A small VPS or VM dedicated to the bot is the recommended home. Two
reasons: it keeps the agent reachable around the clock (laptops sleep,
networks change), and it contains the blast radius of the agent's
`bash` / `write` / `edit` tools to an environment that doesn't share
your personal `~/`, ssh keys, or other credentials. The agent's tool
surface assumes a trusted home; "trusted" reads better when the home
is dedicated.

A laptop is fine for development. For anything long-lived or shared,
give the agent its own host.

## Agent home layout

The agent home is the cwd you launch the bot from (or whatever you point
`PI_CODING_AGENT_DIR` at). It's both *your* home for this bot and pi's
`agentDir` — pi reads its own configuration from the same place.

```
<agent-home>/
  # secrets + harness env (gitignored)
  .env

  # bot identity (tracked)
  SYSTEM.md                           # pi-native; auto-discovered as the system prompt
  AGENTS.md                           # pi-native; loaded as project context
  skills/                             # pi-format skills, auto-loaded

  # pi config (tracked, all optional — pi has working defaults)
  settings.json                       # defaultProvider/Model/ThinkingLevel, compaction, retry, skills paths, etc.
  models.json                         # custom model definitions / overrides

  # service template (tracked)
  discord-agent.service               # systemd template

  # runtime state (gitignored)
  auth.json                                              # pi's credential store (created by pi if a user runs `/login`)
  sessions/<channelId>.jsonl                             # one file per Discord channel/thread
  sessions-archive/<channelId>-<YYYYMMDD-HHMMSS>.jsonl   # session files moved here by `!clear` (UTC timestamp = clear time)
  workspaces/<channelId>/                                # agent's cwd for that channel
  active-sessions.json                                   # per-channel work-state for restart recovery
```

Threads share the structure with channels — Discord treats a thread as a
distinct channel ID, so `sessions/<threadId>.jsonl` and
`workspaces/<threadId>/` get created naturally on first message.

The `session.jsonl` files are pi's native format. You can resume any
conversation from your terminal with `pi --session <path>`, useful for
debugging or continuing a chat outside Discord. `!clear` moves the
current session JSONL to `sessions-archive/<channelId>-<timestamp>.jsonl`
instead of deleting it — `ls sessions-archive/<channelId>-*.jsonl`
indexes prior conversations for the same channel, oldest to newest.

To run multiple agents from the same framework, repeat with a separate
home dir per bot.

## Environment

Four env vars; everything else lives in `settings.json` (pi-native).

| Variable | Required? | What it is |
|---|---|---|
| `DISCORD_TOKEN` | required | Bot token from the Discord developer portal |
| `<PROVIDER>_API_KEY` | required | API key — pi resolves the provider from whichever `*_API_KEY` is set (e.g., `OPENROUTER_API_KEY` → OpenRouter) |
| `DEBUG_CHANNEL_ID` | optional | Discord channel ID to cross-post operational logs (tool calls, per-call usage, compaction, lifecycle) |
| `PI_CODING_AGENT_DIR` | optional | Override `agentDir` if cwd is awkward for your deployment. Default: cwd. |

**Recommended channel layout.** The agent is single-player — it
responds to every non-bot message in any channel or thread it can
see, no @mention required, so channel membership is what scopes
participation. Invite it only into rooms where direct conversation
with anyone present is what you want. A typical setup uses two
channels: one for talking *to* the agent (where users post), and a
second `DEBUG_CHANNEL_ID` for watching what it's *doing* (tool
activity, restarts, compaction, errors). Either side can collapse —
a single channel without a debug feed, or a debug feed alone with
the agent in `#general` — but two channels reads cleanest
day-to-day.

**Cloud-host workaround.** Discord blocks some cloud IP ranges (notably
AWS) at `discord.com`. If the bot can't connect from a hosted VM, set
`DISCORD_API_URL=https://canary.discord.com/api` in your `.env` to route
REST and gateway traffic through the canary domain instead.

**Multiple API keys in env?** Set `defaultProvider` (and optionally
`defaultModel`) in `settings.json` to disambiguate, or just keep one
`*_API_KEY` and pi picks that provider automatically.

## Pi configuration (`settings.json`)

Tune the model, compaction, retry, skills paths, themes, and more via
`<agent-home>/settings.json`. Full reference:
[pi-coding-agent settings docs](https://github.com/earendil-works/pi/blob/v0.74.0/packages/coding-agent/docs/settings.md).

Common knobs:

```json
{
  "defaultProvider": "anthropic",
  "defaultModel": "claude-sonnet-4-6",
  "defaultThinkingLevel": "medium",
  "compaction": {
    "enabled": true,
    "keepRecentTokens": 30000
  },
  "retry": {
    "enabled": true,
    "maxRetries": 3
  }
}
```

Pi works with sensible defaults if `settings.json` doesn't exist — only
add it when you want to deviate.

To verify which model the bot resolved at runtime, check the bot's
Discord presence — its activity status displays `<provider>/<model-id>`
(e.g., "Playing anthropic/claude-sonnet-4-6") in the member list once
the first session opens.

## Custom models (`models.json`)

For self-hosted endpoints (vLLM, Ollama, custom OpenAI-compatible) or
overriding pricing/context-window metadata on built-in models, drop a
`models.json` next to `settings.json`. Format and override semantics are
pi-native — see the [pi-coding-agent docs](https://github.com/earendil-works/pi/tree/v0.74.0/packages/coding-agent/docs).

## Running long-term with systemd

`bun run setup` generates a pre-filled unit at
`<agent-home>/<botname>-discord-agent.service` on Linux when you opt in.
The wizard prints the three sudo commands at the end of setup; install
with:

```bash
sudo cp <agent-home>/<botname>-discord-agent.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now <botname>-discord-agent.service
journalctl -u <botname>-discord-agent.service -f       # tail logs
```

If you set up by hand, the template at
[`../agent-template/discord-agent.service`](../agent-template/discord-agent.service)
uses `{{BOT_NAME}}`, `{{USER}}`, `{{AGENT_HOME}}`, `{{SOURCE_DIR}}`, and
`{{BUN_PATH}}` placeholders — fill those in (the three path placeholders
take absolute paths), then run the same `cp` / `daemon-reload` /
`enable --now` sequence above. The wizard reads this same template and
substitutes the placeholders for you.

Two things in the template that matter for self-restarting agents:

- **`StartLimitIntervalSec=0`** disables systemd's restart rate limit. By
  default, systemd marks a service `failed` after 5 restarts in 10s. Tight
  self-edit loops trip this fast and the bot stops coming back until you
  `systemctl reset-failed`.
- **`Restart=always`** restarts on any exit *including* clean
  `process.exit(0)` — which is what the agent calls when self-restarting.
  `Restart=on-failure` would only respawn on non-zero exits.

### Optional: stricter hardening

The shipped template only sets `NoNewPrivileges=true` because the
namespace-based directives (`ProtectSystem=strict`, `ProtectHome=read-only`,
`ReadWritePaths=`, `PrivateTmp=true`) silently break on hosts where systemd
can't set up mount namespaces — containers, some cloud VMs (observed on
exe.dev), and minimal Linux distros. The failure mode is unhelpful: `/tmp`
ends up read-only or writes to the agent home fail despite `ReadWritePaths`
listing it, and you only notice when the bot crashes on the first request.

On hosts where it does work (Debian/Ubuntu on bare VMs, most Hetzner /
DigitalOcean / EC2 instances), add the hardening as a drop-in override
instead of editing the unit file — that way `git pull` updates to the
template don't clobber it:

```bash
sudo systemctl edit <bot>-discord-agent
```

Then paste:

```ini
[Service]
ProtectSystem=strict
ProtectHome=read-only
ReadWritePaths=<absolute path to agent home> <absolute path to discord-agent source>
PrivateTmp=true
```

Save, `sudo systemctl restart <bot>-discord-agent`, then send the bot a
test message. If it crashes with `ReadOnlyFileSystem` or similar, the
host doesn't support the namespace setup — `sudo systemctl edit
--full <bot>-discord-agent` to remove the override, or delete
`/etc/systemd/system/<bot>-discord-agent.service.d/override.conf`.

## Self-modification

When running from source, the harness tells the agent where its own
framework code lives (the absolute path to the cloned repo) via an extra
section appended to the system prompt. The agent can then `read`/`edit`/
`write`/`bash` against framework files just like any other file, and call
**`restart_self`** to relaunch with the new code.

The flow:

1. Agent edits framework source (e.g., `src/io/installTypingIndicator.ts`).
2. Agent writes a brief status line ("Restarting to apply edits.") — this streams to Discord automatically.
3. Agent calls `restart_self({ reason: "tweaked typing-indicator timing" })`.
4. Bot exits cleanly. Supervisor respawns with the new code. Bun reads
   the source fresh; no module cache to reload.

When running from a **compiled binary**, the system-prompt addendum is
not added (the source isn't reachable from inside the binary). The
`restart_self` tool still works, but only as a recovery hatch — there's
no "new source" for it to pick up. Update by replacing the binary, then
restart.

Detection happens at module-import time via `process.env.COMPILED`,
which the build scripts bake into binaries (`COMPILED=true bun build
--env=COMPILED* …`). In source mode, `COMPILED` is undefined.

For the user, `!restart` does the same thing as `restart_self` — exits
the process so the supervisor respawns. Useful when state is stuck or
after pulling fresh code without involving the agent.

## Building binaries (optional)

For deployments where you'd rather not have Bun on the host, you can
compile a self-contained binary via `bun build --compile`. The Bun runtime
gets embedded; the output has no Bun-on-host dependency.

**Trade-off worth knowing before you build.** Running from source lets
the agent edit its own framework code and `restart_self` to pick up the
new version (see [Self-modification](#self-modification) above). A
compiled binary is more portable but loses that loop — the framework
source isn't reachable from inside the binary, so the harness omits the
self-mod addendum from the system prompt and the agent treats its own
code as read-only. Pick source for development and self-modifying
agents; pick binary for "ship it and forget it" deployments.

```bash
cd ~/discord-agent
bun run build              # current platform → dist/discord-agent
bun run build:all          # cross-compile linux + darwin x64/arm64
```

Build targets:

| Script | Target | Output |
|---|---|---|
| `build:linux-x64` | bun-linux-x64 | `dist/discord-agent-linux-x64` |
| `build:linux-arm64` | bun-linux-arm64 | `dist/discord-agent-linux-arm64` |
| `build:darwin-x64` | bun-darwin-x64 | `dist/discord-agent-darwin-x64` |
| `build:darwin-arm64` | bun-darwin-arm64 | `dist/discord-agent-darwin-arm64` |

Each output is ~70 MB (Bun runtime + bundled JS). Ship as a single
executable from a stable cwd that has its own `.env` and persona files.
