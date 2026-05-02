/**
 * Config — single source of truth for env-driven settings, validated at
 * import time. Required vars throw immediately on startup if missing.
 *
 * Paths are resolved relative to `agentDir` (the bot's home dir). By
 * default `agentDir` is `process.cwd()`, so launching from the agent home
 * Just Works. Set `PI_CODING_AGENT_DIR` to point elsewhere when cwd is
 * inconvenient (containerised setups, etc.).
 *
 * Pi reads its own configuration (`settings.json`, `models.json`,
 * `auth.json`, `AGENTS.md`, etc.) from the same `agentDir`. See
 * https://github.com/badlogic/pi-mono/blob/v0.72.1/packages/coding-agent/docs/settings.md
 * for the full list of pi-side knobs (model defaults, compaction, retry,
 * skill paths, etc.) — none of those need our env vars.
 */
import { resolve } from "node:path";

const agentDir = resolve(process.env.PI_CODING_AGENT_DIR ?? process.cwd());

// `DISCORD_TOKEN` isn't on this struct — discord.js auto-reads
// `process.env.DISCORD_TOKEN` when `Client` is instantiated, so threading
// it through our config would be redundant. The wizard path
// (`src/bin/agent.ts`) ensures the var is set before the harness loads;
// direct invocation without it surfaces a clear error from discord.js
// at login time.
export const config = {
  agentDir,
  agent: {
    idleEvictMs: 20 * 60 * 1000,
    maxWarm: 32,
  },
  // When set, the harness cross-posts operational lines (tool calls,
  // per-call usage, compaction, startup/shutdown) to that channel for
  // monitoring and post-mortems.
  debugChannelId: process.env.DEBUG_CHANNEL_ID || null,
  // Override the Discord REST API base URL. Discord's primary domain
  // (`discord.com`) blocks some cloud IP ranges (notably AWS); routing
  // through `https://canary.discord.com/api` works around that. Setting
  // this also redirects the WebSocket gateway, since discord.js fetches
  // the gateway URL from the REST API. Default unset (use discord.com).
  discordApiUrl: process.env.DISCORD_API_URL || null,
} as const;
