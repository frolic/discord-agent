#!/usr/bin/env bun
/**
 * A/B harness for the thinking level in `tools` mode.
 *
 * The question: does disabling provider reasoning (`CHAT_THINKING_LEVEL=off`,
 * the mode's default) make the model dumber — specifically, does it make the
 * model answer in prose instead of calling `send_message`, and does it produce
 * shallower work?
 *
 * Method: the same fixed prompt set, the same model, one thread per pass, driven
 * through the real pool. Each pass reports:
 *
 *   - turns / textOnlyReplies — a text-only assistant message in `tools` mode is
 *     a *rejected* reply: the model wrote prose where only a tool call reaches
 *     the user. This is the failure the guard exists for.
 *   - delivered — turns where a `send_message` actually posted something.
 *   - reasoning / output tokens and per-turn latency, from the session record.
 *   - the replies themselves, so quality can be judged rather than assumed.
 *
 * Usage (run from the agent home):
 *
 *   CHAT_MODE=tools CHAT_THINKING_LEVEL=off CHAT_SMOKE_CHANNEL_ID=<parent> \
 *     bun /path/to/discord-agent/src/bin/thinking-ab.ts off
 *
 * The label argument is only used in the printed output.
 */
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "../config.ts";
import { createAgentPool } from "../createAgentPool.ts";
import { createActiveTracker } from "../active/createActiveTracker.ts";

const turnTimeoutMs = 180_000;

/** Fixed prompt set — mixed shape: short answer, explanation, planning, arithmetic check. */
const prompts = [
  "In two sentences: what is a dead man's switch, and why would a long-running agent need one?",
  "A deploy script has no timeout and sometimes hangs for 40 minutes. Give me the two failure modes that creates for a chat agent, ranked by user impact.",
  "I have 3 build jobs: A takes 4 minutes and is idempotent, B takes 90 seconds and writes to prod, C takes 20 minutes and only reads. Tell me which to background and why, in one short paragraph.",
  "What is 17 * 23? Show the arithmetic, then state the answer.",
  "Name three things that can silently go wrong when a harness logs agent replies to a debug channel instead of delivering them.",
  "Rewrite this to be clearer and shorter: 'Due to the fact that the tool call was not made, the message was not delivered to the user, and as a result the user was not able to see the response.'",
];

const token = process.env.DISCORD_TOKEN;
const parentChannelId = process.env.CHAT_SMOKE_CHANNEL_ID ?? "";
const label = process.argv[2] ?? "pass";

if (!token || parentChannelId.length === 0) {
  console.error("DISCORD_TOKEN and CHAT_SMOKE_CHANNEL_ID are required (run from the agent home)");
  process.exit(2);
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  ...(config.discordApiUrl ? { rest: { api: config.discordApiUrl } } : {}),
});

const tracker = createActiveTracker({
  activeStateFile: resolve(config.agentDir, `thinking-ab-${label}.json`),
});
const pool = createAgentPool({ client, tracker });

await client.login();

const parent = await client.channels.fetch(parentChannelId);
if (!parent || !parent.isTextBased() || !("threads" in parent)) {
  console.error("parent channel cannot host a thread");
  process.exit(2);
}
const thread = await parent.threads.create({
  name: `thinking ${label} ${new Date().toISOString().slice(11, 19)}`,
  autoArchiveDuration: 60,
  reason: `thinking-level A/B: ${label}`,
});
console.log(`thread: ${thread.id}`);
console.log(`thinking level in force: ${config.chatThinkingLevel ?? "(mode default)"} · model: (settings)`);

const startedAt = Date.now();
for (const prompt of prompts) {
  try {
    await Promise.race([
      pool.wakeUp(thread.id, prompt),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`turn exceeded ${turnTimeoutMs}ms`)), turnTimeoutMs),
      ),
    ]);
  } catch (error) {
    console.error(`turn failed: ${String(error)}`);
  }
}
const elapsedMs = Date.now() - startedAt;

// Everything the pass did is in the session record; read it rather than
// instrumenting the pool a second time.
const sessionPath = resolve(config.agentDir, "sessions", `${thread.id}.jsonl`);
if (!existsSync(sessionPath)) {
  console.error(`no session file at ${sessionPath}`);
  process.exit(1);
}
const entries = readFileSync(sessionPath, "utf8")
  .split("\n")
  .filter((line) => line.trim().length > 0)
  .map((line) => JSON.parse(line));

interface AssistantMessage {
  role: string;
  content?: { type: string; text?: string; name?: string }[];
  usage?: { reasoning?: number; output?: number; input?: number; totalTokens?: number };
  durationMs?: number;
  stopReason?: string;
}

const assistant = entries
  .filter((entry) => entry.type === "message")
  .map((entry) => entry.message as AssistantMessage)
  .filter((message) => message?.role === "assistant");

const textOnly = assistant.filter(
  (message) =>
    Array.isArray(message.content) &&
    message.content.length > 0 &&
    message.content.every((block) => block.type === "text"),
);
const withToolCall = assistant.filter((message) =>
  Array.isArray(message.content) && message.content.some((block) => block.type === "toolCall"),
);
const sendMessages = assistant.flatMap((message) =>
  (message.content ?? []).filter((block) => block.type === "toolCall" && block.name === "send_message"),
);

const sum = (values: number[]): number => values.reduce((total, value) => total + value, 0);
const reasoningTokens = sum(assistant.map((message) => message.usage?.reasoning ?? 0));
const outputTokens = sum(assistant.map((message) => message.usage?.output ?? 0));
const durations = assistant.map((message) => message.durationMs ?? 0).filter((ms) => ms > 0);

console.log("\n=== summary ===");
console.log(
  JSON.stringify(
    {
      label,
      thinkingLevel: config.chatThinkingLevel ?? "(mode default)",
      prompts: prompts.length,
      assistantMessages: assistant.length,
      turnsWithToolCall: withToolCall.length,
      textOnlyReplies: textOnly.length,
      sendMessageCalls: sendMessages.length,
      reasoningTokens,
      outputTokens,
      avgLlmMs: durations.length > 0 ? Math.round(sum(durations) / durations.length) : null,
      wallMs: elapsedMs,
    },
    null,
    2,
  ),
);

if (textOnly.length > 0) {
  console.log("\ntext-only replies (the failure mode under test):");
  for (const message of textOnly) {
    console.log(`  - ${(message.content?.[0]?.text ?? "").slice(0, 120).replace(/\n/g, " / ")}`);
  }
}

console.log("\ndelivered replies (quality read):");
for (const call of sendMessages.slice(0, prompts.length)) {
  const text = (call as { arguments?: { text?: string } }).arguments?.text ?? "";
  console.log(`  - ${text.slice(0, 160).replace(/\n/g, " / ")}`);
}

client.destroy();
process.exit(0);
