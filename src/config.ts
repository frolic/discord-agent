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
 * https://github.com/earendil-works/pi/blob/v1.3.0/packages/coding-agent/docs/settings.md
 * for the full list of pi-side knobs (model defaults, compaction, retry,
 * skill paths, etc.) — none of those need our env vars.
 */
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseChatMode, parseChatThinkingLevel } from "./agent/chatMode.ts";

/** Env knob in whole seconds; anything unparseable falls back to the default. */
function positiveSeconds(name: string, fallback: number): number {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number.parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : fallback;
}

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
  // Liveness beacon (see `src/active/livenessBeacon.ts`). `heartbeat` and
  // `ready` are written into `livenessDir`; an out-of-band supervisor reads
  // them and reverts this checkout if they stop arriving. Keep the default
  // in sync with `/usr/local/sbin/pollux-deadmans-switch.sh`.
  livenessDir: resolve(process.env.LIVENESS_DIR ?? resolve(homedir(), ".pollux")),
  // How assistant output reaches the user channel: `stream` (assistant text is
  // the reply, streamed into edited Discord messages) or `tools` (replies are
  // `send_message` calls; assistant text is logged, never delivered). Both paths
  // stay in the tree — flipping the mode is one env change plus a restart, which
  // is also how an A/B comparison is run. Throws on an unknown value.
  chatMode: parseChatMode(process.env.CHAT_MODE),
  // Explicit override for the thinking level asserted on every session.
  // Unset → the mode chooses: `off` in `tools` mode, the settings default in
  // `stream` mode. Needed for endpoints that refuse to disable reasoning — see
  // `parseChatThinkingLevel`.
  chatThinkingLevel: parseChatThinkingLevel(process.env.CHAT_THINKING_LEVEL),
  // How long `bash` waits before handing a still-running command to the job
  // runner. Under this, a command behaves exactly like a blocking bash call;
  // past it, the turn is freed and the model polls the job. Unset → 110s.
  bashCeilingSecs: positiveSeconds("BASH_CEILING_SECS", 110),
  // How long a single tool call may run before the harness posts its own
  // progress note to the channel. `0` disables the watchdog. Unset → 30s.
  progressNoteSecs: positiveSeconds("TOOL_PROGRESS_NOTE_SECS", 30),
  // Harness checkout root. Its git SHA is stamped into the ready marker so
  // the supervisor can tell whether a revert to `known-good` would actually
  // change anything.
  harnessDir: resolve(process.env.HARNESS_DIR ?? resolve(import.meta.dir, "..")),
} as const;
