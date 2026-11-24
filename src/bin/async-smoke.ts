#!/usr/bin/env bun
/**
 * Live proof that long work cannot block the conversation.
 *
 * The claim being tested, in one real turn in a real Discord thread:
 *
 *   1. a **job runs** (`job_start`, so it is detached from the first moment),
 *   2. the agent **replies while it runs** (no waiting for the job),
 *   3. a **steer lands mid-turn** (a second message while the agent is busy is
 *      injected between tool calls and produces its own reply),
 *   4. the **harness posts progress notes on its own** while a tool runs long
 *      (`TOOL_PROGRESS_NOTE_SECS`), so the channel never shows a silent stall.
 *
 * Everything is driven through the real pool, the real tools and the real
 * gateway; the script only observes. It creates its own private thread so it
 * never races the live bot on a channel that has a pool entry.
 *
 * Usage, from the agent home:
 *
 *   CHAT_MODE=tools CHAT_SMOKE_CHANNEL_ID=<parent channel> TOOL_PROGRESS_NOTE_SECS=5 \
 *     bun /path/to/discord-agent/src/bin/async-smoke.ts
 *
 * Exit code 0 means every assertion held.
 */
import { resolve } from "node:path";
import { Client, GatewayIntentBits, type Message, type PartialMessage } from "discord.js";
import { config } from "../config.ts";
import { createAgentPool } from "../createAgentPool.ts";
import { createActiveTracker } from "../active/createActiveTracker.ts";
import { createJobs } from "../agent/jobs.ts";

const turnTimeoutMs = 300_000;
const settleMs = 6_000;
/** How long the proof job runs — long enough to outlive the turn comfortably. */
const jobSeconds = 150;
/** A bash call inside the turn that outlives TOOL_PROGRESS_NOTE_SECS. */
const slowBashSeconds = 14;

const jobName = "async-smoke";
const jobMarker = "job-finished-" + Date.now().toString(36);
const replyOneMarker = "PROGRESS-ONE";
const replyTwoMarker = "PROGRESS-TWO";
const steerMarker = "STEER-LANDED";

const token = process.env.DISCORD_TOKEN;
const parentChannelId = process.env.CHAT_SMOKE_CHANNEL_ID ?? "";

if (!token) {
  console.error("DISCORD_TOKEN is not set (run from the agent home so .env loads)");
  process.exit(2);
}
if (!parentChannelId) {
  console.error("CHAT_SMOKE_CHANNEL_ID is not set");
  process.exit(2);
}

interface Observation {
  kind: "create" | "update";
  content: string;
  at: number;
}

const observations: Observation[] = [];
const jobs = createJobs({ rootDir: resolve(config.agentDir, "jobs") });

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  ...(config.discordApiUrl ? { rest: { api: config.discordApiUrl } } : {}),
});

let channelId = "";

function record(kind: Observation["kind"], message: Message): void {
  if (message.channelId !== channelId) return;
  if (message.author.id !== client.user?.id) return;
  const previous = observations.at(-1);
  if (previous?.kind === kind && previous.content === message.content) return;
  observations.push({ kind, content: message.content, at: Date.now() });
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
  activeStateFile: resolve(config.agentDir, "async-smoke-active-sessions.json"),
});
const pool = createAgentPool({ client, tracker });

await client.login();

// Private thread: the live bot has a pool entry for the parent channel, so the
// proof has to happen somewhere it cannot collide with a real conversation.
const parent = await client.channels.fetch(parentChannelId);
if (!parent || !parent.isTextBased() || !("threads" in parent)) {
  console.error("parent channel cannot host a thread");
  process.exit(2);
}
const thread = await parent.threads.create({
  name: `async proof ${new Date().toISOString().slice(11, 19)}`,
  autoArchiveDuration: 60,
  reason: "async job / steering proof",
});
channelId = thread.id;
console.log(`thread: ${channelId}`);

/** Post the steer as a real incoming message (webhook author, not the bot). */
async function postSteerMessage(content: string): Promise<Message | null> {
  const channel = await client.channels.fetch(channelId);
  if (!channel?.isTextBased() || !("fetchWebhooks" in channel)) return null;
  const webhooks = await channel.fetchWebhooks();
  const webhook = webhooks.find((candidate) => candidate.token !== undefined) ?? (await channel.createWebhook({ name: "async-proof" }));
  if (!webhook.token) return null;
  // discord.js sends webhooks with `wait=true`, so this resolves to the real
  // Message — which is what the pool needs in order to react and steer.
  return webhook.send({ content, username: "proof-steer", threadId: channelId });
}

const prompt = [
  `Long-work proof. Do exactly this, in order, without waiting for anything to finish:`,
  `1. job_start with name "${jobName}" and command "sleep ${jobSeconds}; echo ${jobMarker}".`,
  `2. Immediately send_message containing exactly ${replyOneMarker} and one line saying the job is running in the background. Do not wait for the job.`,
  `3. job_status for "${jobName}" once.`,
  `4. send_message containing exactly ${replyTwoMarker} and the job's state from step 3.`,
  `5. Run bash with the command "sleep ${slowBashSeconds}; echo slow-done" — this is deliberately slow so the harness progress note has to fire.`,
  `6. send_message saying the slow command finished.`,
  `Never poll the long job to completion and never kill it — the proof script cleans it up.`,
].join("\n");

const startedAt = Date.now();
let turnError: unknown = null;
const turn = pool
  .wakeUp(channelId, prompt)
  .catch((error) => {
    turnError = error;
  });

// Steer while the turn is in flight: wait for the first reply, then inject.
let steerPostedAt = 0;
let steerMessageId: string | undefined;
const steerPromise = (async () => {
  const deadline = Date.now() + 60_000;
  while (Date.now() < deadline) {
    if (observations.some((observation) => observation.content.includes(replyOneMarker))) break;
    await new Promise((done) => setTimeout(done, 500));
  }
  const steerMessage = await postSteerMessage(
    `${steerMarker}: this arrived mid-turn. Reply with send_message containing exactly ${steerMarker} plus one short line confirming you can still be reached while the job runs.`,
  );
  steerMessageId = steerMessage?.id;
  steerPostedAt = Date.now();
  if (steerMessage) await pool.handle(channelId, steerMessage);
})();

await Promise.race([
  turn,
  new Promise((_, reject) =>
    setTimeout(() => reject(new Error(`turn did not finish within ${turnTimeoutMs}ms`)), turnTimeoutMs),
  ),
]).catch((error) => {
  turnError ??= error;
});
await steerPromise.catch((error) => console.error("steer failed:", error));
await new Promise((done) => setTimeout(done, settleMs));

const turnFinishedAt = Date.now();
const jobStillRunning = jobs.status(jobName)?.running === true;
const jobSnapshot = jobs.status(jobName);
jobs.kill(jobName);

const creates = observations.filter((observation) => observation.kind === "create");
const channelText = observations.map((observation) => observation.content).join("\n");

console.log(`\nmode: ${config.chatMode}  turn: ${turnFinishedAt - startedAt}ms  thread: ${channelId}`);
console.log("observed timeline:");
for (const observation of observations) {
  console.log(
    `  +${String(observation.at - startedAt).padStart(6)}ms ${observation.kind.padEnd(6)} ${JSON.stringify(
      observation.content.slice(0, 140),
    )}`,
  );
}
if (turnError) console.log(`turn error: ${String(turnError)}`);

const firstReply = observations.find((observation) => observation.content.includes(replyOneMarker));
const steerReply = observations.find(
  (observation) => observation.content.includes(steerMarker) && observation.kind === "create",
);
const progressNotes = creates.filter((create) => create.content.includes("⏳"));

let steerAcked = false;
if (steerMessageId) {
  const steerChannel = await client.channels.fetch(channelId).catch(() => null);
  if (steerChannel?.isTextBased()) {
    const message = await steerChannel.messages.fetch(steerMessageId).catch(() => null);
    steerAcked = message?.reactions.cache.some((reaction) => reaction.emoji.name === "👀") ?? false;
  }
}

const failures: string[] = [];
function check(label: string, ok: boolean, detail?: string): void {
  console.log(`${ok ? "PASS" : "FAIL"}  ${label}${detail ? ` — ${detail}` : ""}`);
  if (!ok) failures.push(label);
}

check("the turn finished without throwing", turnError === null, turnError ? String(turnError) : undefined);
check("the job was started", jobSnapshot !== undefined);
check("the job was still running when the turn finished", jobStillRunning);
check(
  "the first reply landed while the job was running",
  firstReply !== undefined && firstReply.at < turnFinishedAt,
  firstReply ? `+${firstReply.at - startedAt}ms` : "no reply",
);
check(
  "the first reply did not wait for the job",
  firstReply !== undefined && firstReply.at - startedAt < 30_000,
  firstReply ? `+${firstReply.at - startedAt}ms` : undefined,
);
check("the second reply landed", channelText.includes(replyTwoMarker));
check("the steer produced a reply", steerReply !== undefined);
check(
  "the steer reply landed while the job was still running",
  steerReply !== undefined && jobStillRunning,
  steerReply ? `+${steerReply.at - steerPostedAt}ms after the steer` : undefined,
);
check("the steer message was acked with 👀", steerAcked);
check(
  "the harness posted a progress note on its own",
  progressNotes.length > 0,
  `${progressNotes.length} note(s)`,
);

client.destroy();
console.log(failures.length === 0 ? "\nall checks passed" : `\n${failures.length} check(s) failed`);
process.exit(failures.length === 0 ? 0 : 1);
