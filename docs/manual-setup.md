# Manual setup

The wizard at `bun run setup` is the recommended path. This page covers
the same setup by hand for anyone who'd rather see every step, or for
environments where the wizard doesn't fit.

## 1. Set up the agent home

```bash
git clone <this repo> ~/discord-agent
cd ~/discord-agent && bun install

mkdir -p ~/agents/my-bot
cp example-agent/SYSTEM.md  ~/agents/my-bot/
cp example-agent/AGENTS.md  ~/agents/my-bot/
cp example-agent/.env.example ~/agents/my-bot/.env
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

For long-term operation, see [operating.md](operating.md). The example
agent home ships a systemd unit at
[`../example-agent/discord-agent.service`](../example-agent/discord-agent.service)
that you can copy and edit by hand (the wizard generates a pre-filled
version automatically).
