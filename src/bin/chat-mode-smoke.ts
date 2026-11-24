#!/usr/bin/env bun
/**
 * Live smoke test for a chat mode.
 *
 * Unit tests cover the pieces; this drives one **real** turn through the real
 * pool in a real channel and reports what actually reached Discord. Two modes,
 * two shapes of proof:
 *
 *   CHAT_MODE=stream — the reply is assistant text: expect one message that
 *                      grows through edits, plus whatever markers were asked for.
 *   CHAT_MODE=tools  — the reply is a `send_message` call: expect the message to
 *                      arrive (edited in place if the arguments streamed in more
 *                      than one chunk), nothing containing the `think` marker in
 *                      the channel, and the stray-prose marker in the debug
 *                      channel.
 *
 * Visible appends are provider-dependent — see `CHAT_SMOKE_REQUIRE_APPENDS`.
 *
 * Usage, from the agent home (so `.env` and the agent dir resolve as usual):
 *
 *   CHAT_MODE=tools CHAT_SMOKE_CHANNEL_ID=123 CHAT_SMOKE_EXPECT=abc \
 *     bun /path/to/discord-agent/src/bin/chat-mode-smoke.ts "prompt"
 *
 * Optional: `CHAT_SMOKE_THINK_MARKER`, `CHAT_SMOKE_STRAY_MARKER` (markers the
 * prompt tells the model to emit) and `CHAT_SMOKE_REQUIRE_APPENDS=1`.
 *
 * Run it against a channel/thread with no live pool entry — it writes to that
 * channel's session file, so it must not race the running bot on the same
 * channel. Exit code 0 means every assertion held.
 */
import { resolve } from "node:path";
import { Client, GatewayIntentBits, type Message, type PartialMessage } from "discord.js";
import { config } from "../config.ts";
import { createAgentPool } from "../createAgentPool.ts";
import { createActiveTracker } from "../active/createActiveTracker.ts";

const turnTimeoutMs = 240_000;
/** Let trailing gateway events (final edit, debug post) arrive before judging. */
const settleMs = 4_000;

const token = process.env.DISCORD_TOKEN;
const channelId = process.env.CHAT_SMOKE_CHANNEL_ID ?? "";
const prompt = process.argv.slice(2).join(" ").trim();

if (!token) {
  console.error("DISCORD_TOKEN is not set (run from the agent home so .env loads)");
  process.exit(2);
}
if (!channelId) {
  console.error("CHAT_SMOKE_CHANNEL_ID is not set");
  process.exit(2);
}
if (prompt.length === 0) {
  console.error("usage: chat-mode-smoke.ts '<prompt>'");
  process.exit(2);
}

interface Observation {
  kind: "create" | "update";
  messageId: string;
  content: string;
  at: number;
}

const observations: Observation[] = [];

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  ...(config.discordApiUrl ? { rest: { api: config.discordApiUrl } } : {}),
});

function record(kind: Observation["kind"], message: Message): void {
  if (message.channelId !== channelId) return;
  if (message.author.id !== client.user?.id) return;
  const previous = observations.at(-1);
  if (previous?.kind === kind && previous.content === message.content) return;
  observations.push({ kind, messageId: message.id, content: message.content, at: Date.now() });
}

client.on("messageCreate", (message) => record("create", message));
client.on("messageUpdate", async (oldMessage: Message | PartialMessage, newMessage: Message | PartialMessage) => {
  const message = newMessage.partial ? await newMessage.fetch().catch(() => null) : newMessage;
  if (!message || message.partial) return;
  const before = oldMessage.partial ? null : oldMessage.content;
  if (before !== null && before === message.content) return;
  record("update", message);
});

const tracker = createActiveTracker({
  activeStateFile: resolve(config.agentDir, "smoke-active-sessions.json"),
});
const pool = createAgentPool({ client, tracker });

await client.login();

const startedAt = Date.now();
let turnError: unknown = null;
try {
  await Promise.race([
    pool.wakeUp(channelId, prompt),
    new Promise((_, reject) =>
      setTimeout(() => reject(new Error(`turn did not finish within ${turnTimeoutMs}ms`)), turnTimeoutMs),
    ),
  ]);
} catch (error) {
  turnError = error;
}
await new Promise((done) => setTimeout(done, settleMs));

const mode = config.chatMode;
const creates = observations.filter((observation) => observation.kind === "create");
const updates = observations.filter((observation) => observation.kind === "update");
const channelText = observations.map((observation) => observation.content).join("\n");

async function debugChannelText(): Promise<string> {
  if (!config.debugChannelId) return "";
  const channel = await client.channels.fetch(config.debugChannelId).catch(() => null);
  if (!channel || !channel.isTextBased()) return "";
  const recent = await channel.messages.fetch({ limit: 25 }).catch(() => null);
  if (!recent) return "";
  return [...recent.values()]
    .filter((message) => message.author.id === client.user?.id)
    .filter((message) => message.createdTimestamp >= startedAt - 5_000)
    .map((message) => message.content)
    .join("\n");
}

const debugText = await debugChannelText();

console.log(`\nmode: ${mode}  channel: ${channelId}  turn: ${Date.now() - startedAt}ms`);
console.log("observed timeline:");
for (const observation of observations) {
  const t = `+${observation.at - startedAt}ms`;
  console.log(`  ${t.padStart(9)} ${observation.kind.padEnd(6)} ${observation.content.length
    .toString()
    .padStart(4)}ch  ${JSON.stringify(observation.content.slice(0, 120))}`);
}
if (turnError) console.log(`turn error: ${String(turnError)}`);

const failures: string[] = [];
function check(label: string, ok: boolean): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}`);
  if (!ok) failures.push(label);
}

check("the turn finished without throwing", turnError === null);
check("a message was posted to the channel", creates.length > 0);
check(
  "the reply content is what the prompt asked for",
  (process.env.CHAT_SMOKE_EXPECT ?? "").length === 0 ||
    channelText.includes(process.env.CHAT_SMOKE_EXPECT ?? ""),
);
// Visible appends depend on how finely the provider streams tool-call
// arguments: OpenRouter hands pi the whole argument object in one or two chunks
// for the models we run, so a tools-mode reply usually appears at once. Text
// deltas in stream mode are fine-grained and do append. Set
// CHAT_SMOKE_REQUIRE_APPENDS=1 when checking against a provider that streams
// arguments incrementally.
const appendCount = updates.filter((update) => update.content.length > 0).length;
console.log(`INFO  appends observed while streaming: ${appendCount}`);
if (process.env.CHAT_SMOKE_REQUIRE_APPENDS === "1") {
  check("the message was edited while streaming (visible appends)", appendCount > 0);
}
check(
  "no message was posted twice",
  new Set(creates.map((create) => create.content)).size === creates.length,
);
if ((process.env.CHAT_SMOKE_THINK_MARKER ?? "").length > 0) {
  const marker = process.env.CHAT_SMOKE_THINK_MARKER ?? "";
  check("the think marker never reached the user channel", !channelText.includes(marker));
  // The debug channel logs every tool call, so the thought legitimately shows up
  // there as a `think` tool line. What must not happen is it showing up as
  // *delivered content*.
  const thinkMarkerOutsideToolLog = debugText
    .split("\n")
    .filter((line) => line.includes(marker) && !line.includes("think"));
  check(
    "the think marker appears in the debug channel only as a tool log line",
    thinkMarkerOutsideToolLog.length === 0,
  );
}
if ((process.env.CHAT_SMOKE_STRAY_MARKER ?? "").length > 0) {
  const marker = process.env.CHAT_SMOKE_STRAY_MARKER ?? "";
  check("stray assistant text reached the debug channel", debugText.includes(marker));
  check("stray assistant text did not reach the user channel", !channelText.includes(marker));
}

client.destroy();
console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
