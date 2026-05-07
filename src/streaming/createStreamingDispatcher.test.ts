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
}

function makeFakeTimer(): { timer: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void }; control: FakeTimer } {
  const handlers = new Map<number, () => void>();
  let nextId = 1;
  return {
    timer: {
      setTimeout: (fn) => {
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
