/**
 * Wire one channel's session events into the tracker. Bridges the agent
 * loop's "tool started / tool ended" lifecycle into the persisted
 * `inTool` and `pending` flags so a crash mid-tool can be distinguished
 * from a clean exit at recovery time.
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
    }
  });
}
