/**
 * Startup recovery: read the tracker, dispatch one wake-up per channel
 * that needs it. The harness picks a tailored prompt based on which
 * recovery flag is set, optionally appends a catchup suffix, and hands
 * control to the agent — no canned harness messages.
 *
 * Three buckets, checked in this order (recovery flags only — channels
 * with just a `lastSeenMessageId` and nothing else are simply preserved):
 *   - `cameFromRestart` → intentional restart (restart_self / /restart).
 *                         Wakes with `harnessRestartPrompt`. Checked first
 *                         because restart_self is itself a tool call, so
 *                         `inTool` is also set on these — but the restart
 *                         framing wins.
 *   - `inTool`          → crash mid-tool. Wakes with
 *                         `harnessMidToolRestartPrompt` so the agent
 *                         decides what to do instead of replaying the
 *                         half-finished tool call.
 *   - `pending` (only)  → crash mid-think (no tool was in flight). Wakes
 *                         with `harnessMidThinkPrompt` to re-engage the
 *                         user's prior message.
 *
 * Every wake also receives a catchup suffix when `lastSeenMessageId` is
 * present, so the agent can `history(after=…)` to see anything that
 * arrived during downtime — the harness doesn't inline the missed
 * messages, just hands the agent the cursor.
 *
 * Recovery flags are cleared via `tracker.clearRecoveryFlags` BEFORE the
 * wake fires, so a crash mid-recovery doesn't cause double-wakeup on the
 * next boot. `lastSeenMessageId` is preserved.
 */
import {
  harnessCatchupSuffix,
  harnessMidThinkPrompt,
  harnessMidToolRestartPrompt,
  harnessRestartPrompt,
} from "../agent/prompts.ts";
import type { AgentPool } from "../createAgentPool.ts";
import type { ActiveTracker } from "./createActiveTracker.ts";
import type { ChannelState } from "./common.ts";

export async function recoverActive(args: {
  pool: AgentPool;
  tracker: ActiveTracker;
}): Promise<void> {
  const { pool, tracker } = args;

  for (const { channelId, state } of tracker.listChannels()) {
    const branchPrompt = pickBranchPrompt(state);
    if (!branchPrompt) continue;

    tracker.clearRecoveryFlags(channelId);

    const catchup = state.lastSeenMessageId
      ? harnessCatchupSuffix(state.lastSeenMessageId)
      : "";
    const fullPrompt = `${branchPrompt}${catchup}`;

    pool.wakeUp(channelId, fullPrompt).catch((error) =>
      console.error(`[recoverActive] failed for ${channelId}:`, error),
    );
  }
}

function pickBranchPrompt(state: ChannelState): string | null {
  if (state.cameFromRestart) return harnessRestartPrompt;
  if (state.inTool) return harnessMidToolRestartPrompt;
  if (state.pending) return harnessMidThinkPrompt;
  return null;
}
