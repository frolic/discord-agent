# Manual setup

The wizard at `bun run setup` is the recommended path. This page covers
the same setup by hand for anyone who'd rather see every step, or for
environments where the wizard doesn't fit.

## 1. Set up the agent home

```bash
git clone <this repo> ~/discord-agent
cd ~/discord-agent && bun install

mkdir -p ~/agents/my-bot
cp agent-template/SYSTEM.md  ~/agents/my-bot/
cp agent-template/AGENTS.md  ~/agents/my-bot/
cp agent-template/.env.example ~/agents/my-bot/.env
cd ~/agents/my-bot
$EDITOR SYSTEM.md                     # voice, tone, behavior
$EDITOR AGENTS.md                     # background context (or delete it)
$EDITOR .env                          # paste your provider's *_API_KEY (e.g. ANTHROPIC_API_KEY); DISCORD_TOKEN comes in step 2
```

The agent home stays outside the framework repo so the bot's identity
and accumulated state travel with the bot, not the source.

## 2. Create your Discord application

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

## 3. Run

```bash
cd ~/agents/my-bot
bun ~/discord-agent/src/bin/agent.ts
```

You should see `discord-agent online as YourBotName#1234`. Send any
message in any channel or thread the bot can see — it'll reply.

For long-term operation, see [operating.md](operating.md). The template
at [`../agent-template/discord-agent.service`](../agent-template/discord-agent.service)
has five `{{X}}` placeholders to fill in:

| Placeholder | Value |
|---|---|
| `{{BOT_NAME}}` | friendly name shown in `systemctl status` (e.g. `my-bot`) |
| `{{USER}}` | unix user the bot runs as (e.g. `$(whoami)`) |
| `{{AGENT_HOME}}` | absolute path to the agent home (e.g. `/home/me/agents/my-bot`) |
| `{{SOURCE_DIR}}` | absolute path to this checkout (e.g. `/home/me/discord-agent`) |
| `{{BUN_PATH}}` | absolute path to bun (`which bun`) |

Replace each, then follow the install steps in
[operating.md](operating.md#running-long-term-with-systemd). The wizard
reads this same template and does the substitution for you.
