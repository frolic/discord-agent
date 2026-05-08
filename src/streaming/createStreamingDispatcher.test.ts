import { describe, expect, test } from "bun:test";
import { createStreamingDispatcher } from "./createStreamingDispatcher.ts";

interface PostCall {
  type: "post";
  content: string;
}
interface EditCall {
  type: "edit";
  messageId: string;
  content: string;
}
type Call = PostCall | EditCall;

interface Recorder {
  calls: Call[];
  postFails: Set<number>; // 0-based indices of post calls that should reject (return null)
  editFails: Set<number>; // 0-based indices of edit calls that should throw
  postCount: number;
  editCount: number;
}

interface FakeTimer {
  /** Run all currently-pending timer callbacks. */
  flushTimers(): void;
  /** Number of pending timers. */
  pending(): number;
  /**
   * Every `setTimeout` delay value the dispatcher has requested, in
   * order. Lets tests assert which debounce path each scheduling
   * decision took.
   */
  scheduledDelays: number[];
}

function makeFakeTimer(): { timer: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }; control: FakeTimer } {
  const handlers = new Map<number, () => void>();
  const scheduledDelays: number[] = [];
  let nextId = 1;
  return {
    timer: {
      setTimeout: (fn, ms) => {
        scheduledDelays.push(ms);
        const id = nextId++;
        handlers.set(id, fn);
        return id;
      },
      clearTimeout: (handle) => {
        handlers.delete(handle as number);
      },
    },
    control: {
      flushTimers: () => {
        const all = [...handlers.entries()];
        handlers.clear();
        for (const [, fn] of all) fn();
      },
      pending: () => handlers.size,
      scheduledDelays,
    },
  };
}

function makeDispatcher(args: { softLimit?: number; hardLimit?: number; recorder?: Recorder } = {}) {
  const softLimit = args.softLimit ?? 50;
  const hardLimit = args.hardLimit ?? 100;
  const recorder: Recorder = args.recorder ?? {
    calls: [],
    postFails: new Set(),
    editFails: new Set(),
    postCount: 0,
    editCount: 0,
  };
  const { timer, control } = makeFakeTimer();

  const dispatcher = createStreamingDispatcher({
    softLimit,
    hardLimit,
    initialPostDelayMs: 10,
    editDebounceMs: 20,
    timer,
    post: async (content) => {
      const idx = recorder.postCount++;
      recorder.calls.push({ type: "post", content });
      if (recorder.postFails.has(idx)) return null;
      return { messageId: `m${idx + 1}` };
    },
    edit: async (messageId, content) => {
      const idx = recorder.editCount++;
      recorder.calls.push({ type: "edit", messageId, content });
      if (recorder.editFails.has(idx)) throw new Error("simulated edit fail");
    },
  });
  return { dispatcher, recorder, control };
}

/**
 * Drive the dispatcher to settled state: flush timers, await microtasks,
 * loop until nothing more is pending. Tests use this between input phases.
 */
async function settle(control: FakeTimer): Promise<void> {
  for (let safety = 0; safety < 100; safety++) {
    control.flushTimers();
    // Yield to microtasks so awaited writes resolve.
    for (let m = 0; m < 5; m++) await Promise.resolve();
    if (control.pending() === 0) return;
  }
  throw new Error("settle did not converge");
}

describe("createStreamingDispatcher — debounce scheduling", () => {
  test("first delta schedules with the initial-post debounce", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    expect(control.scheduledDelays).toEqual([10]); // initialPostDelayMs
    await settle(control);
  });

  test("subsequent deltas after first post schedule with edit debounce", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    await settle(control);
    // Reset the recorded list so we only see what happens next.
    control.scheduledDelays.length = 0;

    dispatcher.append("b");
    expect(control.scheduledDelays).toEqual([20]); // editDebounceMs
    await settle(control);
  });

  test("rapid deltas during the same debounce window don't re-schedule", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    dispatcher.append("b");
    dispatcher.append("c");
    // Only the first append schedules; later ones see timerHandle != null.
    expect(control.scheduledDelays).toEqual([10]);
    await settle(control);
  });

  test("deltas arriving during the initial post's await schedule with edit debounce, not initial-post debounce", async () => {
    // The bug: hasPosted flips true only AFTER `await post()` resolves,
    // so deltas in the await window see hasPosted=false and pick the
    // short initial-post debounce. That's how the user saw "several edits
    // within a second" right after the first post landed.
    let resolvePost: ((v: { messageId: string }) => void) | null = null;
    const postPromise = new Promise<{ messageId: string }>((r) => {
      resolvePost = r;
    });
    const calls: Call[] = [];
    const { timer, control } = makeFakeTimer();
    const dispatcher = createStreamingDispatcher({
      softLimit: 50,
      hardLimit: 100,
      initialPostDelayMs: 10,
      editDebounceMs: 20,
      timer,
      post: async (content) => {
        calls.push({ type: "post", content });
        return postPromise;
      },
      edit: async (messageId, content) => {
        calls.push({ type: "edit", messageId, content });
      },
    });

    // Step 1: first delta. Schedules initial-post timer.
    dispatcher.append("a");
    expect(control.scheduledDelays).toEqual([10]);

    // Step 2: fire the timer. flushNow runs, calls post(), awaits.
    control.flushTimers();
    // Drain microtasks so flushNow gets to its `await post()`.
    for (let i = 0; i < 5; i++) await Promise.resolve();
    expect(calls.length).toBe(1);
    expect(calls[0]!.type).toBe("post");

    // Step 3: with the post still pending, append more deltas. Each new
    // delta should schedule the next flush with the EDIT debounce (20ms),
    // not the initial-post debounce (10ms). The bug schedules with 10ms.
    dispatcher.append("b");
    // Only the first delta (b) actually schedules — c sees timerHandle set
    // and returns. So we expect exactly one new entry, and it must be 20.
    expect(control.scheduledDelays.slice(1)).toEqual([20]);

    dispatcher.append("c");
    expect(control.scheduledDelays.slice(1)).toEqual([20]);

    // Step 4: resolve the post and let everything settle so the test
    // doesn't leak a pending promise.
    resolvePost!({ messageId: "m1" });
    await settle(control);
  });

  test("after flush settles with content changes during the await, the timer is rebased to fire from flush completion", async () => {
    // The interval-style cadence: when a flush settles, the next tick
    // should fire editDebounceMs from THAT moment, not from the most
    // recent delta. We force a delta-armed timer to land DURING a
    // flush's await, then verify the post-flush rebase replaces it
    // (clears + re-schedules) so the cadence isn't drifted by REST
    // latency.
    let resolvePost: ((v: { messageId: string }) => void) | null = null;
    const postPromise = new Promise<{ messageId: string }>((r) => {
      resolvePost = r;
    });
    const calls: Call[] = [];
    const { timer, control } = makeFakeTimer();
    const dispatcher = createStreamingDispatcher({
      softLimit: 50,
      hardLimit: 100,
      initialPostDelayMs: 10,
      editDebounceMs: 20,
      timer,
      post: async (content) => {
        calls.push({ type: "post", content });
        return postPromise;
      },
      edit: async (messageId, content) => {
        calls.push({ type: "edit", messageId, content });
      },
    });

    dispatcher.append("a");
    control.flushTimers();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // During the post's await, append more content. This arms a timer
    // (delta-armed) for editDebounceMs from now. scheduledDelays now
    // has [10 (initial), 20 (delta-armed during await)].
    dispatcher.append("b");
    expect(control.scheduledDelays).toEqual([10, 20]);

    // Resolve the post. After the await resolves, the post-flush
    // re-arm logic notices buffer changed (b appended during the
    // await) and calls scheduler.clear() + scheduler.schedule(20).
    // That cancels the delta-armed timer and arms a fresh one — the
    // rebase. scheduledDelays gets a third entry of 20.
    resolvePost!({ messageId: "m1" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(control.scheduledDelays).toEqual([10, 20, 20]);

    await settle(control);
  });

  test("flush that consumed everything (no deltas during await) doesn't re-arm — next delta drives the next cycle", async () => {
    // If nothing changes during a flush's await, there's no work left
    // — the next delta should arm fresh, not the post-flush re-arm.
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    await settle(control);
    // Reset what we record so the next phase is clean.
    control.scheduledDelays.length = 0;

    // Stream pauses (no append). Settle drives no further work.
    await settle(control);
    expect(control.scheduledDelays).toEqual([]);

    // New delta arrives. Arms fresh.
    dispatcher.append("b");
    expect(control.scheduledDelays).toEqual([20]);
    await settle(control);
  });

  test("deltas during the seal-then-post sequence schedule with edit debounce", async () => {
    // Once any post has resolved, hasPosted should stay sticky-true so
    // the brief currentMessageId=null window after a seal doesn't drop
    // back into the initial-post debounce.
    const { dispatcher, control } = makeDispatcher({ softLimit: 30, hardLimit: 100 });

    // Get past the first post.
    dispatcher.append("first");
    await settle(control);
    control.scheduledDelays.length = 0;

    // Push past softLimit so the next flush seals + posts a new message.
    dispatcher.append("\n\n" + "second paragraph that goes well past the soft limit so we trigger a seal");
    // The append schedules with editDebounceMs (20).
    expect(control.scheduledDelays).toEqual([20]);
    await settle(control);

    // Now any further deltas — even though seal/post may have toggled
    // currentMessageId — should still schedule with editDebounceMs.
    control.scheduledDelays.length = 0;
    dispatcher.append(" more text");
    expect(control.scheduledDelays).toEqual([20]);
    await settle(control);
  });
});

describe("createStreamingDispatcher — basic flow", () => {
  test("first delta posts; subsequent deltas edit", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("Hello");
    await settle(control);
    expect(recorder.calls).toEqual([{ type: "post", content: "Hello" }]);

    dispatcher.append(", world!");
    await settle(control);
    expect(recorder.calls).toEqual([
      { type: "post", content: "Hello" },
      { type: "edit", messageId: "m1", content: "Hello, world!" },
    ]);
  });

  test("rapid back-to-back deltas batch into a single post", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("a");
    dispatcher.append("b");
    dispatcher.append("c");
    await settle(control);
    expect(recorder.calls).toEqual([{ type: "post", content: "abc" }]);
  });

  test("no edit when buffer matches lastSentContent", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("Hello");
    await settle(control);
    expect(recorder.calls.length).toBe(1);

    // Trigger another flush with no new content. This shouldn't normally
    // happen but the dispatcher should be idempotent.
    dispatcher.append("");
    await settle(control);
    expect(recorder.calls.length).toBe(1);
  });

  test("end() flushes pending content", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("Hello");
    // Don't flush timers yet — end() should drain anyway.
    const endPromise = dispatcher.end();
    await settle(control);
    await endPromise;
    expect(recorder.calls).toEqual([{ type: "post", content: "Hello" }]);
  });

  test("getPostedMessageIds returns all posted IDs", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("first");
    await settle(control);
    expect(dispatcher.getPostedMessageIds()).toEqual(["m1"]);
  });
});

describe("createStreamingDispatcher — splitting at soft limit", () => {
  test("buffer past softLimit at paragraph seam splits into two messages", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ softLimit: 30, hardLimit: 100 });
    // First post the prefix.
    dispatcher.append("intro paragraph here");
    await settle(control);
    expect(recorder.calls).toEqual([{ type: "post", content: "intro paragraph here" }]);

    // Now push past the soft limit with a paragraph break.
    dispatcher.append("\n\nsecond paragraph after break");
    await settle(control);
    // The seal point happens to land at exactly what m1 already displays
    // (the prose ended at the paragraph boundary), so the redundant edit
    // is skipped. Expectation is just: m2 is posted with the carry-over.
    const m2Post = recorder.calls.find((c) => c.type === "post" && c.content === "second paragraph after break");
    expect(m2Post).toBeDefined();
    expect(dispatcher.getPostedMessageIds()).toEqual(["m1", "m2"]);
  });

  test("rollback case: code block streams past softLimit, message rolls back to before fence", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ softLimit: 40, hardLimit: 200 });
    // Stream prose, blank line, then a long code block.
    dispatcher.append("Here's the implementation:");
    await settle(control);
    dispatcher.append("\n\n```ts\n");
    await settle(control);
    // At this point a Discord message displays the prose + open fence.
    const beforeRollback = recorder.calls.length;
    expect(beforeRollback).toBeGreaterThanOrEqual(2);

    // Now stream a chunky body that pushes past softLimit.
    dispatcher.append("const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\n");
    await settle(control);
    // The dispatcher should have rolled m1 back to just the prose, then
    // posted the code block as m2.
    const lastEdit = recorder.calls.findLast((c) => c.type === "edit" && c.messageId === "m1");
    expect(lastEdit?.content).toBe("Here's the implementation:");
    const m2Post = recorder.calls.find((c) => c.type === "post" && c.content.startsWith("```ts"));
    expect(m2Post).toBeDefined();
  });

  test("very long unbroken text forces a fallback split when end() runs", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ softLimit: 30, hardLimit: 60 });
    // No paragraph breaks anywhere — only line breaks won't help either
    // because we're using a long single line. force=true at end() should
    // fall back to word boundary.
    const text = "word ".repeat(20); // 100 chars, no newlines, with spaces
    dispatcher.append(text);
    await dispatcher.end();
    await settle(control);
    // Expect at least 2 posts (the buffer is 100 chars; hardLimit 60).
    const posts = recorder.calls.filter((c) => c.type === "post");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    // Each post's content fits within hardLimit.
    for (const p of posts) {
      expect(p.content.length).toBeLessThanOrEqual(60);
    }
  });

  test("buffer past hardLimit triggers force-split even mid-stream", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ softLimit: 30, hardLimit: 50 });
    // No paragraph breaks anywhere. Forced fallback even before end().
    dispatcher.append("word ".repeat(15)); // 75 chars
    await settle(control);
    const posts = recorder.calls.filter((c) => c.type === "post");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    for (const p of posts) {
      expect(p.content.length).toBeLessThanOrEqual(50);
    }
  });

  test("multiple sequential paragraph splits during one drain", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ softLimit: 20, hardLimit: 100 });
    // Three paragraphs each 15 chars; combined 49+ chars exceeds softLimit.
    dispatcher.append("paragraph one!\n\nparagraph two!\n\nparagraph three");
    await dispatcher.end();
    await settle(control);
    // Expect a series of posts/edits ending in 3 distinct posted messages.
    expect(dispatcher.getPostedMessageIds().length).toBeGreaterThanOrEqual(2);
  });
});

describe("createStreamingDispatcher — failure handling", () => {
  test("post failure drops the buffer chunk", async () => {
    const recorder: Recorder = {
      calls: [],
      postFails: new Set([0]),
      editFails: new Set(),
      postCount: 0,
      editCount: 0,
    };
    const { dispatcher, control } = makeDispatcher({ recorder });
    dispatcher.append("Hello world");
    await settle(control);
    expect(recorder.calls).toEqual([{ type: "post", content: "Hello world" }]);
    // No edit attempt because no current message.
    expect(dispatcher.getPostedMessageIds()).toEqual([]);
  });

  test("edit failure leaves state recoverable for next delta", async () => {
    const recorder: Recorder = {
      calls: [],
      postFails: new Set(),
      editFails: new Set([0]),
      postCount: 0,
      editCount: 0,
    };
    const { dispatcher, control } = makeDispatcher({ recorder });
    dispatcher.append("Hello");
    await settle(control);
    dispatcher.append(", world!");
    await settle(control);
    // First edit attempt failed; the dispatcher should retry on the next
    // delta with the latest content.
    dispatcher.append(" more");
    await settle(control);
    const edits = recorder.calls.filter((c): c is EditCall => c.type === "edit");
    expect(edits.length).toBe(2);
    expect(edits[0]!.content).toBe("Hello, world!");
    expect(edits[1]!.content).toBe("Hello, world! more");
  });
});

describe("createStreamingDispatcher — reset", () => {
  test("reset clears state for a fresh stream", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("first stream");
    await settle(control);
    dispatcher.reset();
    dispatcher.append("second stream");
    await settle(control);
    const posts = recorder.calls.filter((c) => c.type === "post");
    expect(posts.length).toBe(2);
    expect(posts[0]!.content).toBe("first stream");
    expect(posts[1]!.content).toBe("second stream");
  });
});

describe("createStreamingDispatcher — whitespace-only buffers", () => {
  test("whitespace-only delta does not post a message", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("   \n\n   ");
    await dispatcher.end();
    await settle(control);
    expect(recorder.calls.length).toBe(0);
  });
});
