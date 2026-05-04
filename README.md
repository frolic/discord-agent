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

To set up by hand, the three steps below.

### 1. Set up the agent home

```bash
git clone <this repo> ~/discord-agent
cd ~/discord-agent && bun install

cp -r example-agent ~/agents/my-bot
cd ~/agents/my-bot
cp .env.example .env
$EDITOR SYSTEM.md                     # voice, tone, behavior
$EDITOR AGENTS.md                     # background context (or delete it)
$EDITOR .env                          # paste your provider's *_API_KEY (e.g. ANTHROPIC_API_KEY); DISCORD_TOKEN comes in step 2
```

### 2. Create your Discord application

1. <https://discord.com/developers/applications> → **New Application**.
   The name you give it becomes the bot's display name.
2. **Bot** → **Reset Token**. Copy the token and paste it into your
   `.env` as `DISCORD_TOKEN=<token>`. (Shown once; reset and copy again
   if you lose it.)
3. **Bot** → **Privileged Gateway Intents** → enable **Message Content
   Intent**. Without this the bot can't read message text. Save.
4. **OAuth2 → URL Generator** → scope `bot`, permissions: View Channels,
   Send Messages, Send Messages in Threads, Create Public Threads, Embed
   Links, Attach Files, Read Message History, Add Reactions, Use
   External Emojis. Copy the URL, open it, add the bot to your server.

### 3. Run

```bash
bun ~/discord-agent/src/bin/agent.ts
```

You should see `discord-agent online as YourBotName#1234`. Send any
message in any channel or thread the bot can see — it'll reply.

For long-term operation, the example agent home ships a systemd unit at
[`example-agent/discord-agent.service`](example-agent/discord-agent.service)
— see [docs/operating.md](docs/operating.md).

## Docs

- [docs/goals.md](docs/goals.md) — what the bot gives a user, the feel any rebuild should preserve
- [docs/persona.md](docs/persona.md) — `SYSTEM.md`, `AGENTS.md`, skills, writing guidance
- [docs/tools.md](docs/tools.md) — `send` / `react` / `history` / `thread` / `restart_self`, the envelope-tool pattern, interaction model, debug-channel logs
- [docs/operating.md](docs/operating.md) — agent-home layout, environment, systemd, building binaries, self-modification

The agent home is also pi's `agentDir` — `settings.json`, `models.json`,
custom skills, etc. are all configured the pi-native way. See
[pi-coding-agent's settings docs](https://github.com/badlogic/pi-mono/blob/v0.72.1/packages/coding-agent/docs/settings.md)
for the full list of pi-side knobs.
