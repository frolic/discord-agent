# discord-agent

A Discord harness for [pi](https://github.com/earendil-works/pi) agents.
One Bun process. Each Discord channel/thread gets its own warm
`AgentSession` with on-disk history and a private workspace. Threads are
first-class — their own session, their own workspace.

The framework is one repo; each running bot is a separate *agent home*
directory containing config, persona, and runtime state. Same source,
any number of agents.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1 — runs the harness itself.
- [Node.js](https://nodejs.org) ≥ 20 — recommended even though the harness uses Bun. The agent runs npm-distributed CLIs over bash for many real tasks (search scrapers, browser automation, format converters), and most have `#!/usr/bin/env node` shebangs or call `node` internally. A Bun-only environment will fail those silently. If you're installing via a setup agent (Shelley, etc.), make sure Node lands too — `bun install` alone isn't enough.
- A Discord account (you'll create a bot application)
- An LLM API key from any [pi-supported provider](https://github.com/earendil-works/pi/blob/v0.74.0/packages/ai/README.md#supported-providers) — Anthropic, OpenAI, DeepSeek, OpenRouter, Google, etc.

## Quick start

Easiest path is hosted: [exe.dev](https://exe.dev) is a great place
to test and run software, with a built-in agent (Shelley) that takes
care of setup and sys ops. Spin up a VM with a prompt that links to
this repo.

To set up on your machine:

```bash
git clone <this repo> ~/discord-agent
cd ~/discord-agent && bun install
bun run setup
```

`bun run setup` is the supported install path. It walks you through
creating a Discord application, validates your bot token against
Discord, generates the invite URL with the correct permissions,
prompts for a model provider key, and lays down a fresh agent home (by
default `~/agents/<botname>`) with `.env`, persona templates, and an
optional pre-filled systemd unit. The run command prints at the end.

> **Setting this up via an agent (Shelley, Claude Code, etc.)? Run
> `bun run setup` and drive its prompts — don't piece the install
> together by hand.** The wizard is doing real work that's annoying to
> get right manually:
>
> - **Token validation against Discord** — fail-fast on a bad token
>   instead of a silent gateway disconnect minutes later.
> - **OAuth invite URL** — the right permission bitfield is computed
>   from `discord.js`; copy-pasted permission lists drift.
> - **canary.discord.com fallback** — discord.com is rate-limited from
>   many cloud IP ranges (often returning multi-hour retry-afters); the
>   wizard auto-detects this and writes `DISCORD_API_URL` accordingly.
> - **Pre-filled systemd unit** — generated with absolute paths for
>   this host, including `StartLimitIntervalSec=0` (a foot-gun if you
>   miss it — see [docs/operating.md](docs/operating.md)). Hardening
>   beyond `NoNewPrivileges` is off by default since the namespace
>   directives break on some hosts; opt back in per
>   [docs/operating.md#optional-stricter-hardening](docs/operating.md).
>
> Ask the user for the Discord bot token and the LLM provider + key
> upfront if you want; then start `bun run setup` and feed those answers
> when prompted. Don't substitute manual `cp` + edit for the wizard.

For the manual flow without the wizard (development, environments
where the wizard doesn't fit), see
[docs/manual-setup.md](docs/manual-setup.md). For long-term hosting
and self-modification, see [docs/operating.md](docs/operating.md).

## Docs

- [docs/goals.md](docs/goals.md) — what the bot gives a user, the feel any rebuild should preserve
- [docs/persona.md](docs/persona.md) — `SYSTEM.md`, `AGENTS.md`, skills, writing guidance
- [docs/tools.md](docs/tools.md) — text streaming, `attach` / `react` / `history` / `thread` / `restart_self`, interaction model, debug-channel logs
- [docs/operating.md](docs/operating.md) — agent-home layout, environment, systemd, building binaries, self-modification

The agent home is also pi's `agentDir` — `settings.json`, `models.json`,
custom skills, etc. are all configured the pi-native way. See
[pi-coding-agent's settings docs](https://github.com/earendil-works/pi/blob/v0.74.0/packages/coding-agent/docs/settings.md)
for the full list of pi-side knobs.
