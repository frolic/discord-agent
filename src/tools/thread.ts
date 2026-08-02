/**
 * Creating a thread is a session handoff: the calling session terminates and
 * a fresh agent session takes over in the new thread, seeded with
 * `initial_message`. The seed message is BOTH the visible first post AND
 * the synthetic user prompt that wakes the new session — bot messages alone
 * don't trigger the agent, so without `wakeUp` the thread would sit silent
 * until a human posted there.
 */
import type { AnyThreadChannel, Client, GuildTextBasedChannel } from "discord.js";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import { createStreamingDispatcher } from "../streaming/createStreamingDispatcher.ts";

const threadAutoArchiveMinutes = 1440;
const initialMessageMaxLength = 1990;

export function createThreadTool(args: {
  client: Client;
  channelId: string;
  wakeUp: (channelId: string, prompt: string) => Promise<void>;
}) {
  const { client, channelId, wakeUp } = args;
  return defineTool({
    name: "thread",
    label: "create thread",
    description:
      "Create a Discord thread in the current channel for multi-step or long-running work. Posts your initial_message as the first message in the thread — that message is visible to the user AND serves as the seed context for the fresh agent session that runs there. Returns the thread ID; the next user message in the thread spins up a brand-new conversation scope, so make initial_message self-contained.",
    parameters: Type.Object({
      name: Type.String({ description: "thread name (≤100 chars)", maxLength: 100 }),
      initial_message: Type.String({
        description:
          "first message posted in the thread. Write it as instructions to a fresh you — include all relevant context, links, file paths, and the goal of the work. The new session won't see this turn's history.",
      }),
      parent_message_id: Type.Optional(
        Type.String({
          description:
            "OPTIONAL — default is to OMIT. Spawns the thread off a specific message ID in the current channel (Discord 'create thread on message'). Only set this when the new thread is a direct reply to a *specific recent message the user just sent* that they'd recognize as the obvious parent (e.g., they pointed at one message and said 'investigate this'). Do NOT pick the first message in the session, the message that started the conversation, or 'the closest relevant message you can find' — those are almost always wrong and create a confusing parent-thread link in Discord (the thread appears as a reply to something unrelated). If you're not certain which specific message would be the parent, OMIT this parameter; the thread is created at the channel root, which is correct for almost all cases.",
        }),
      ),
    }),
    execute: async (_id, params) => {
      const channel = await client.channels.fetch(channelId);
      if (!channel || !channel.isTextBased() || channel.isDMBased()) {
        throw new Error(`channel ${channelId} doesn't support thread creation`);
      }

      const thread = await startThread({
        channel,
        parentMessageId: params.parent_message_id,
        name: params.name,
      });

      await postInitialMessage((content) => thread.send(content), params.initial_message);

      wakeUp(thread.id, params.initial_message).catch((error) => {
        console.error(`[thread] wakeUp failed for ${thread.id}:`, error);
      });

      return {
        content: [
          {
            type: "text",
            text: `created thread "${params.name}" (id: ${thread.id}) and dispatched a fresh session with the seed message`,
          },
        ],
        details: { threadId: thread.id, parentChannelId: channel.id },
        terminate: true,
      };
    },
  });
}

// Reuse the harness's streaming dispatcher so the initial message goes
// through the same markdown-aware chunking as every other Discord
// message (`chunkRendered`). No bespoke splitter: the dispatcher is
// channel-agnostic (driven by a post callback), so we bind it to the
// thread's `send` and let it split long initial messages for us.
// Exported so the dispatcher wiring is testable without a live
// discord.js thread.
export async function postInitialMessage(
  post: (content: string) => Promise<{ id: string }>,
  message: string,
): Promise<void> {
  if (message.length === 0) return;
  // An initial message is a one-shot append + flush: only `post` ever
  // fires. `edit` is a no-op to satisfy the dispatcher contract (no
  // messages exist mid-flush to edit).
  const dispatcher = createStreamingDispatcher({
    hardLimit: initialMessageMaxLength,
    post: async (content) => {
      const sent = await post(content);
      if (!sent) return null;
      return { messageId: sent.id };
    },
    edit: async () => {},
  });
  dispatcher.append(message);
  await dispatcher.end();
}

async function startThread(args: {
  channel: GuildTextBasedChannel;
  parentMessageId: string | undefined;
  name: string;
}): Promise<AnyThreadChannel> {
  const { channel, parentMessageId, name } = args;
  if (!("threads" in channel)) {
    throw new Error(
      channel.isThread()
        ? "cannot create a thread inside a thread"
        : "this channel type doesn't support thread creation",
    );
  }
  if (parentMessageId) {
    const parent = await channel.messages.fetch(parentMessageId).catch((error) => {
      console.error(`[thread] fetch parent ${parentMessageId} failed:`, error);
      return null;
    });
    if (!parent) {
      throw new Error(`parent message ${parentMessageId} not found in this channel`);
    }
    return parent.startThread({ name, autoArchiveDuration: threadAutoArchiveMinutes });
  }
  return channel.threads.create({ name, autoArchiveDuration: threadAutoArchiveMinutes });
}
