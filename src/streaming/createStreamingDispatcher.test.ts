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
  postFails: Set<number>;
  editFails: Set<number>;
  postCount: number;
  editCount: number;
}

interface FakeTimer {
  flushTimers(): void;
  pending(): number;
  scheduledDelays: number[];
}

function makeFakeTimer(): {
  timer: { setTimeout: (fn: () => void, ms: number) => unknown; clearTimeout: (h: unknown) => void };
  control: FakeTimer;
} {
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

function makeDispatcher(args: { hardLimit?: number; recorder?: Recorder } = {}) {
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
    hardLimit,
    flushIntervalMs: 20,
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

async function settle(control: FakeTimer): Promise<void> {
  for (let safety = 0; safety < 100; safety++) {
    control.flushTimers();
    for (let m = 0; m < 5; m++) await Promise.resolve();
    if (control.pending() === 0) return;
  }
  throw new Error("settle did not converge");
}

describe("createStreamingDispatcher — basic flow", () => {
  test("first delta posts; subsequent deltas edit the same message when content fits", async () => {
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

  test("end() flushes pending content", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("Hello");
    const endPromise = dispatcher.end();
    await settle(control);
    await endPromise;
    expect(recorder.calls).toEqual([{ type: "post", content: "Hello" }]);
  });

  test("getPostedMessageIds returns posted IDs in order", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("first");
    await settle(control);
    expect(dispatcher.getPostedMessageIds()).toEqual(["m1"]);
  });

  test("flush is a no-op when content matches lastSent", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("Hello");
    await settle(control);
    // No new appends. settle drives no further work.
    await settle(control);
    expect(recorder.calls.length).toBe(1);
  });
});

describe("createStreamingDispatcher — chunking across messages", () => {
  test("content that exceeds hardLimit posts a second message at the next block boundary", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ hardLimit: 30 });
    dispatcher.append("first paragraph fits\n\nsecond paragraph also fits");
    await settle(control);
    const posts = recorder.calls.filter((c): c is PostCall => c.type === "post");
    expect(posts.length).toBe(2);
    // First chunk is the first paragraph; second chunk is the second.
    expect(posts[0]!.content).toBe("first paragraph fits");
    expect(posts[1]!.content).toBe("second paragraph also fits");
  });

  test("growing content stabilizes earlier messages — no redundant edits to chunk[0] once chunk[1] exists", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ hardLimit: 30 });
    dispatcher.append("first paragraph fits");
    await settle(control);
    expect(recorder.calls).toEqual([{ type: "post", content: "first paragraph fits" }]);

    // Add content that will need a second message. chunk[0] stays the
    // same (same content), so no edit on m1; chunk[1] is new, post m2.
    dispatcher.append("\n\nsecond paragraph also fits");
    await settle(control);
    const recent = recorder.calls.slice(1);
    expect(recent).toEqual([{ type: "post", content: "second paragraph also fits" }]);
  });
});

describe("createStreamingDispatcher — failure handling", () => {
  test("post failure leaves the message un-tracked; next flush retries", async () => {
    const recorder: Recorder = {
      calls: [],
      postFails: new Set([0]),
      editFails: new Set(),
      postCount: 0,
      editCount: 0,
    };
    const { dispatcher, control } = makeDispatcher({ recorder });
    dispatcher.append("Hello");
    await settle(control);
    expect(recorder.calls).toEqual([{ type: "post", content: "Hello" }]);
    expect(dispatcher.getPostedMessageIds()).toEqual([]);

    // A new delta — next flush retries the post (and succeeds this time).
    dispatcher.append(" world");
    await settle(control);
    expect(recorder.calls.length).toBe(2);
    expect(dispatcher.getPostedMessageIds()).toEqual(["m2"]);
  });

  test("edit failure leaves lastSent unchanged so the next flush retries with the latest content", async () => {
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
    dispatcher.append(" more");
    await settle(control);
    const edits = recorder.calls.filter((c): c is EditCall => c.type === "edit");
    expect(edits.length).toBe(2);
    expect(edits[0]!.content).toBe("Hello, world!");
    expect(edits[1]!.content).toBe("Hello, world! more");
  });
});

describe("createStreamingDispatcher — reset / lifecycle", () => {
  test("reset clears state for a fresh stream", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("first stream");
    await settle(control);
    dispatcher.reset();
    dispatcher.append("second stream");
    await settle(control);
    const posts = recorder.calls.filter((c): c is PostCall => c.type === "post");
    expect(posts.length).toBe(2);
    expect(posts[0]!.content).toBe("first stream");
    expect(posts[1]!.content).toBe("second stream");
  });

  test("whitespace-only delta does not post", async () => {
    const { dispatcher, recorder, control } = makeDispatcher();
    dispatcher.append("   \n\n   ");
    await dispatcher.end();
    await settle(control);
    expect(recorder.calls.length).toBe(0);
  });
});

describe("createStreamingDispatcher — flush scheduling", () => {
  test("first delta arms the flush timer at flushIntervalMs", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    expect(control.scheduledDelays).toEqual([20]);
    await settle(control);
  });

  test("rapid deltas in the same window don't re-arm", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    dispatcher.append("b");
    dispatcher.append("c");
    expect(control.scheduledDelays).toEqual([20]);
    await settle(control);
  });

  test("after a flush settles with content changes during the await, the next timer is rebased to fire from flush completion", async () => {
    let resolvePost: ((v: { messageId: string }) => void) | null = null;
    const postPromise = new Promise<{ messageId: string }>((r) => {
      resolvePost = r;
    });
    const { timer, control } = makeFakeTimer();
    const dispatcher = createStreamingDispatcher({
      hardLimit: 100,
      flushIntervalMs: 20,
      timer,
      post: async () => postPromise,
      edit: async () => {},
    });

    dispatcher.append("a");
    control.flushTimers();
    for (let i = 0; i < 5; i++) await Promise.resolve();

    // Delta during the post's await arms a fresh timer.
    dispatcher.append("b");
    expect(control.scheduledDelays).toEqual([20, 20]);

    // Resolve the post: the post-flush re-arm sees the buffer changed
    // and re-schedules — third entry.
    resolvePost!({ messageId: "m1" });
    for (let i = 0; i < 10; i++) await Promise.resolve();
    expect(control.scheduledDelays).toEqual([20, 20, 20]);

    await settle(control);
  });

  test("flush with no buffer changes during await doesn't re-arm; next delta drives the next cycle", async () => {
    const { dispatcher, control } = makeDispatcher();
    dispatcher.append("a");
    await settle(control);
    control.scheduledDelays.length = 0;

    await settle(control);
    expect(control.scheduledDelays).toEqual([]);

    dispatcher.append("b");
    expect(control.scheduledDelays).toEqual([20]);
    await settle(control);
  });
});

describe("createStreamingDispatcher — table chunking with header repeat", () => {
  test("a long table that needs 2 messages emits the header on each chunk", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ hardLimit: 200 });
    const rows = Array.from({ length: 25 }, (_, i) => `| item-${i} | description-${i} | value-${i} |`);
    const raw = "| name | desc | value |\n| - | - | - |\n" + rows.join("\n");
    dispatcher.append(raw);
    await settle(control);
    const posts = recorder.calls.filter((c): c is PostCall => c.type === "post");
    expect(posts.length).toBeGreaterThanOrEqual(2);
    // Every posted chunk is a fenced code block and contains the header
    // column names.
    for (const p of posts) {
      expect(p.content.startsWith("```")).toBe(true);
      expect(p.content.endsWith("```")).toBe(true);
      expect(p.content).toContain("name");
      expect(p.content).toContain("desc");
      expect(p.content).toContain("value");
      expect(p.content.length).toBeLessThanOrEqual(200);
    }
  });

  test("a very long table that needs 3+ messages keeps the header on every chunk", async () => {
    const { dispatcher, recorder, control } = makeDispatcher({ hardLimit: 150 });
    const rows = Array.from({ length: 50 }, (_, i) => `| ${i} | r${i} |`);
    const raw = "| n | row |\n| - | - |\n" + rows.join("\n");
    dispatcher.append(raw);
    await settle(control);
    const posts = recorder.calls.filter((c): c is PostCall => c.type === "post");
    expect(posts.length).toBeGreaterThanOrEqual(3);
    for (const p of posts) {
      // The "n" header column appears in every chunk.
      expect(p.content).toContain("n");
      expect(p.content).toContain("row");
      // Stays under hardLimit.
      expect(p.content.length).toBeLessThanOrEqual(150);
    }
  });
});
