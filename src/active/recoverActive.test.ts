/**
 * Tests for recoverActive's routing logic — which prompt is selected
 * per flag and that the catchup cursor is correctly threaded.
 *
 * Stub the pool and tracker rather than instantiate the real ones; this
 * keeps the test fast (no disk, no Discord client, no pi session) and
 * focused on the wiring under test.
 */
import { describe, expect, test } from "bun:test";
import { recoverActive } from "./recoverActive.ts";
import type { AgentPool } from "../createAgentPool.ts";
import type { ActiveTracker } from "./createActiveTracker.ts";
import type { ChannelState } from "./common.ts";

interface WakeCall {
  channelId: string;
  prompt: string;
}

function stubPool(): { pool: AgentPool; wakes: WakeCall[] } {
  const wakes: WakeCall[] = [];
  const pool = {
    wakeUp: async (channelId: string, prompt: string) => {
      wakes.push({ channelId, prompt });
    },
  } as unknown as AgentPool;
  return { pool, wakes };
}

function stubTracker(channels: Array<{ channelId: string; state: ChannelState }>): {
  tracker: ActiveTracker;
  cleared: string[];
} {
  const cleared: string[] = [];
  const tracker = {
    listChannels: () => channels,
    clearRecoveryFlags: (channelId: string) => {
      cleared.push(channelId);
    },
  } as unknown as ActiveTracker;
  return { tracker, cleared };
}

/**
 * Pull the first wake from the recording and narrow it to non-undefined,
 * failing loudly if recoverActive didn't wake anything. Keeps the test
 * bodies readable under strict null checks.
 */
function expectOne(wakes: WakeCall[]): WakeCall {
  const [wake] = wakes;
  if (!wake) throw new Error("expected exactly one wakeUp call, got 0");
  expect(wakes).toHaveLength(1);
  return wake;
}

/** Build a ChannelState fixture with sensible defaults; override per-test. */
function channelState(overrides: Partial<ChannelState> = {}): ChannelState {
  return {
    pending: false,
    inTool: false,
    cameFromRestart: false,
    ...overrides,
  };
}

describe("recoverActive — prompt selection by flag", () => {
  test("cameFromRestart wakes with the restart prompt", async () => {
    const { pool, wakes } = stubPool();
    const { tracker, cleared } = stubTracker([
      {
        channelId: "channel-restart",
        state: channelState({ cameFromRestart: true, lastSeenMessageId: "msg-99" }),
      },
    ]);

    await recoverActive({ pool, tracker });

    const wake = expectOne(wakes);
    expect(wake.channelId).toBe("channel-restart");
    expect(wake.prompt).toContain("[harness notice — you were just restarted");
    expect(wake.prompt).toContain("history(after=msg-99)");
    expect(cleared).toEqual(["channel-restart"]);
  });

  test("inTool (without cameFromRestart) wakes with the mid-tool prompt", async () => {
    const { pool, wakes } = stubPool();
    const { tracker } = stubTracker([
      {
        channelId: "channel-mid-tool",
        state: channelState({ inTool: true, lastSeenMessageId: "msg-50" }),
      },
    ]);

    await recoverActive({ pool, tracker });

    const wake = expectOne(wakes);
    expect(wake.prompt).toContain("the bot was restarted while a tool was mid-execution");
  });

  test("pending only (no inTool, no cameFromRestart) wakes with the mid-think prompt", async () => {
    const { pool, wakes } = stubPool();
    const { tracker } = stubTracker([
      {
        channelId: "channel-mid-think",
        state: channelState({ pending: true, lastSeenMessageId: "msg-10" }),
      },
    ]);

    await recoverActive({ pool, tracker });

    const wake = expectOne(wakes);
    expect(wake.prompt).toContain("the bot crashed while you were drafting a response");
  });

  test("no recovery flag — channel is skipped, no wake fires", async () => {
    const { pool, wakes } = stubPool();
    const { tracker, cleared } = stubTracker([
      {
        channelId: "channel-quiet",
        state: channelState({ lastSeenMessageId: "msg-1" }),
      },
    ]);

    await recoverActive({ pool, tracker });

    expect(wakes).toHaveLength(0);
    expect(cleared).toEqual([]);
  });

  test("cameFromRestart wins over inTool when both are set", async () => {
    // restart_self IS a tool call, so a channel marked cameFromRestart
    // will also have inTool set. recoverActive must check restart first.
    const { pool, wakes } = stubPool();
    const { tracker } = stubTracker([
      {
        channelId: "channel-both",
        state: channelState({
          cameFromRestart: true,
          inTool: true,
          lastSeenMessageId: "msg-7",
        }),
      },
    ]);

    await recoverActive({ pool, tracker });

    const wake = expectOne(wakes);
    expect(wake.prompt).toContain("[harness notice — you were just restarted");
    expect(wake.prompt).not.toContain("the bot was restarted while a tool was mid-execution");
  });
});

describe("recoverActive — catchup suffix shape (regression guard for #35/#36)", () => {
  test("catchup suffix orders the history call BEFORE response text", async () => {
    // Regression guard: the two-message bug after !restart was fixed in
    // #36 by switching the catchup suffix from compositional ("call X
    // if you want; otherwise skip") to procedural ("call X BEFORE
    // writing any response text, then fold result into single reply").
    // Lock the procedural shape in so a future prompt edit can't silently
    // regress.
    const { pool, wakes } = stubPool();
    const { tracker } = stubTracker([
      {
        channelId: "channel-restart",
        state: channelState({ cameFromRestart: true, lastSeenMessageId: "msg-99" }),
      },
    ]);

    await recoverActive({ pool, tracker });

    const wake = expectOne(wakes);
    expect(wake.prompt).toContain("BEFORE writing any response text");
    expect(wake.prompt).toContain("do not post a status text first and then a separate reply");
  });

  test("no catchup suffix when lastSeenMessageId is absent", async () => {
    const { pool, wakes } = stubPool();
    const { tracker } = stubTracker([
      {
        channelId: "channel-no-cursor",
        state: channelState({ cameFromRestart: true }),
      },
    ]);

    await recoverActive({ pool, tracker });

    const wake = expectOne(wakes);
    expect(wake.prompt).toContain("[harness notice — you were just restarted");
    expect(wake.prompt).not.toContain("[catchup");
  });
});
