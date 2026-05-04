# discord-agent

A Discord harness for [pi](https://github.com/badlogic/pi-mono) agents.
One Bun process. Each Discord channel/thread gets its own warm
`AgentSession` with on-disk history and a private workspace. Threads are
first-class — their own session, their own workspace.

The framework is one repo; each running bot is a separate *agent home*
directory containing config, persona, and runtime state. Same source,
any number of agents.

## Prerequisites

- [Bun](https://bun.sh) ≥ 1.1
- A Discord account (you'll create a bot application)
- An LLM API key from any pi-ai-supported provider — Anthropic, OpenAI,
  DeepSeek, OpenRouter, Google, etc.

## Quick start

Easiest path is hosted: [exe.dev](https://exe.dev) is a great place
to test and run software, with a built-in agent (Shelley) that takes
care of setup and sys ops. Spin up a VM with a prompt that links to
this repo.

To set up locally:

```bash
git clone <this repo> ~/discord-agent
cd ~/discord-agent && bun install
bun run setup
```

The wizard walks you through creating a Discord application, validates
your bot token, generates the invite URL with the right permissions,
prompts for a model provider key, and lays down a fresh agent home (by
default `~/agents/<botname>`) with `.env`, persona templates, and an
optional systemd unit. It prints the run command at the end.

For the manual flow without the wizard, see
[docs/manual-setup.md](docs/manual-setup.md). For long-term hosting and
self-modification, see [docs/operating.md](docs/operating.md).

## Docs

- [docs/goals.md](docs/goals.md) — what the bot gives a user, the feel any rebuild should preserve
- [docs/persona.md](docs/persona.md) — `SYSTEM.md`, `AGENTS.md`, skills, writing guidance
- [docs/tools.md](docs/tools.md) — `send` / `react` / `history` / `thread` / `restart_self`, the envelope-tool pattern, interaction model, debug-channel logs
- [docs/operating.md](docs/operating.md) — agent-home layout, environment, systemd, building binaries, self-modification

The agent home is also pi's `agentDir` — `settings.json`, `models.json`,
custom skills, etc. are all configured the pi-native way. See
[pi-coding-agent's settings docs](https://github.com/badlogic/pi-mono/blob/v0.72.1/packages/coding-agent/docs/settings.md)
for the full list of pi-side knobs.
