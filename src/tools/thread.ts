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
            "optional: spawn the thread off a specific message ID in the current channel (Discord 'create thread on message'). If omitted, the thread is created at the channel root.",
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

      await thread.send({ content: params.initial_message.slice(0, initialMessageMaxLength) });

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
