/**
 * Wire one channel's session events into the tracker. Bridges the agent
 * loop's "tool started / tool ended" lifecycle into the persisted
 * `inTool` flag so a crash mid-tool can be distinguished from a clean
 * exit at recovery time, and clears the channel's `pending` flag once
 * the user actually sees something — either streamed assistant text or
 * a delivery-tool call.
 *
 * Lives separately from `createActiveTracker` because the tracker itself
 * is pure state (no Discord/pi awareness). This file knows how pi events
 * map to tracker calls; swapping the agent layer would only require
 * rewriting this one file.
 */
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { deliveryToolNameSet } from "../agent/deliveryTools.ts";
import type { ActiveTracker } from "./createActiveTracker.ts";

export function installActiveTracker(args: {
  channelId: string;
  session: AgentSession;
  tracker: ActiveTracker;
}): void {
  const { channelId, session, tracker } = args;
  session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      tracker.markInTool(channelId, true);
      return;
    }
    if (event.type === "tool_execution_end") {
      tracker.markInTool(channelId, false);
      if (deliveryToolNameSet.has(event.toolName) && !event.isError) {
        tracker.markFulfilled(channelId);
      }
      return;
    }
    if (event.type === "message_update") {
      const ame = event.assistantMessageEvent;
      // Any non-empty streamed text counts as a fulfilled reply for
      // pending-state tracking. We mark on text_end so a turn that ends
      // mid-stream (aborted, errored before the block closed) doesn't
      // falsely register as delivered.
      if (ame.type === "text_end" && ame.content.length > 0) {
        tracker.markFulfilled(channelId);
      }
    }
  });
}
