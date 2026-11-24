/**
 * The typing indicator is the whole "the agent is working" cue: no progress
 * notes, no chatty status lines. It must therefore stay lit for the entire run —
 * including a tool call that takes a while — and go out the moment the run ends.
 *
 * These tests pin the two properties that matter and are easy to break by
 * accident: the pulse interval is comfortably inside Discord's ~10s fade, and
 * nothing stops the timer except the run ending.
 */
import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { Client, SendableChannels } from "discord.js";
import { installTypingIndicator } from "./installTypingIndicator.ts";

type SessionEvent = { type: string };

function fakeSession(): { session: AgentSession; emit: (event: SessionEvent) => void } {
  const handlers: ((event: SessionEvent) => void)[] = [];
  const session = {
    subscribe(handler: (event: SessionEvent) => void) {
      handlers.push(handler);
      return () => {
        const at = handlers.indexOf(handler);
        if (at >= 0) handlers.splice(at, 1);
      };
    },
  };
  return {
    session: session as unknown as AgentSession,
    emit: (event) => {
      for (const handler of handlers) handler(event);
    },
  };
}

function fakeClient(pulses: number[]): Client {
  const channel = {
    isSendable: () => true,
    sendTyping: async () => {
      pulses.push(Date.now());
    },
  };
  const client = {
    channels: {
      cache: {
        get: () => channel,
      },
      fetch: async () => channel,
    },
  };
  return client as unknown as Client & { channels: { cache: { get: () => SendableChannels } } };
}

describe("installTypingIndicator", () => {
  const spies: { mockRestore: () => void }[] = [];
  afterEach(() => {
    for (const spy of spies.splice(0)) spy.mockRestore();
  });

  test("starts typing as soon as the run starts, and re-pulses inside Discord's fade window", async () => {
    const pulses: number[] = [];
    const intervals: { callback: () => void; ms: number }[] = [];
    spies.push(
      spyOn(globalThis, "setInterval").mockImplementation(((callback: () => void, ms: number) => {
        intervals.push({ callback, ms });
        return 1 as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval),
    );

    const { session, emit } = fakeSession();
    installTypingIndicator({ client: fakeClient(pulses), channelId: "c1", session });
    emit({ type: "turn_start" });
    await Bun.sleep(0);

    expect(pulses).toHaveLength(1);
    expect(intervals).toHaveLength(1);
    // Discord fades the indicator after ~10s of silence.
    expect(intervals[0]?.ms).toBeLessThan(10_000);

    // A long tool call produces no session events at all — the timer is what
    // keeps the channel looking alive, so it has to keep pulsing.
    intervals[0]?.callback();
    expect(pulses).toHaveLength(2);
  });

  test("a tool call in the middle of a run does not stop the indicator", async () => {
    const pulses: number[] = [];
    const intervalHandles: number[] = [];
    const cleared: unknown[] = [];
    spies.push(
      spyOn(globalThis, "setInterval").mockImplementation((() => {
        const handle = intervalHandles.length + 1;
        intervalHandles.push(handle);
        return handle as unknown as ReturnType<typeof setInterval>;
      }) as unknown as typeof setInterval),
    );
    spies.push(
      spyOn(globalThis, "clearInterval").mockImplementation(((handle: unknown) => {
        cleared.push(handle);
      }) as unknown as typeof clearInterval),
    );

    const { session, emit } = fakeSession();
    installTypingIndicator({ client: fakeClient(pulses), channelId: "c1", session });

    emit({ type: "turn_start" });
    await Bun.sleep(0);
    emit({ type: "tool_execution_start" });
    emit({ type: "tool_execution_end" });
    expect(cleared).toHaveLength(0);

    emit({ type: "agent_end" });
    expect(cleared).toEqual([1]);
  });

  test("manual compaction alone keeps the indicator on", async () => {
    const pulses: number[] = [];
    spies.push(
      spyOn(globalThis, "setInterval").mockImplementation(
        (() => 1 as unknown as ReturnType<typeof setInterval>) as unknown as typeof setInterval,
      ),
    );
    const { session, emit } = fakeSession();
    installTypingIndicator({ client: fakeClient(pulses), channelId: "c1", session });
    emit({ type: "compaction_start" });
    await Bun.sleep(0);
    expect(pulses).toHaveLength(1);
  });
});
