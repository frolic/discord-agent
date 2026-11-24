import { describe, expect, test } from "bun:test";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { AssistantMessage, StopReason, ToolCall } from "@earendil-works/pi-ai";
import { createSendMessageDelivery } from "./createSendMessageDelivery.ts";
import type { AttachOptions, DiscordSender, EditTextResult, SendTextResult } from "../io/createDiscordSender.ts";
import {
  createStreamingDispatcher,
  type DispatcherTimer,
  type StreamingDispatcher,
} from "../streaming/createStreamingDispatcher.ts";

/**
 * These drive the streamer with the exact event shapes pi emits
 * (`message_update` carrying an `AssistantMessageEvent`), so the wiring is
 * tested rather than re-described: a wrong field name or a missed
 * `toolcall_delta` case fails here instead of in a live channel.
 */

const usage = {
  input: 1,
  output: 1,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 2,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function assistant(content: AssistantMessage["content"], stopReason: StopReason): AssistantMessage {
  return {
    role: "assistant",
    content,
    api: "openai-completions",
    provider: "test",
    model: "test-model",
    usage,
    stopReason,
    timestamp: Date.now(),
  };
}

function sendMessageCall(id: string, args: Record<string, string>): ToolCall {
  return { type: "toolCall", id, name: "send_message", arguments: args };
}

function toolCallStart(block: ToolCall): AgentSessionEvent {
  const message = assistant([block], "toolUse");
  return {
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_start",
      contentIndex: 0,
      partial: message,
    },
  };
}

function toolCallDelta(block: ToolCall, delta: string): AgentSessionEvent {
  const message = assistant([block], "toolUse");
  return {
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_delta",
      contentIndex: 0,
      delta,
      partial: message,
    },
  };
}

function toolCallEnd(block: ToolCall): AgentSessionEvent {
  const message = assistant([block], "toolUse");
  return {
    type: "message_update",
    message,
    assistantMessageEvent: {
      type: "toolcall_end",
      contentIndex: 0,
      toolCall: block,
      partial: message,
    },
  };
}

function agentStart(): AgentSessionEvent {
  return { type: "agent_start" };
}

interface RecordedMessage {
  id: string;
  content: string;
}

interface Harness {
  sender: DiscordSender;
  delivery: ReturnType<typeof createSendMessageDelivery>;
  emit: (event: AgentSessionEvent) => void;
  flush: () => Promise<void>;
  messages: RecordedMessage[];
  replyTargets: (string | undefined)[];
  dispatchers: StreamingDispatcher[];
}

/** Deterministic clock + recorder around the real dispatcher. */
function makeHarness(args: { replyTarget?: string } = {}): Harness {
  let nextHandle = 1;
  const handlers = new Map<number, () => void>();
  const timer: DispatcherTimer = {
    setTimeout: (handler) => {
      const handle = nextHandle++;
      handlers.set(handle, handler);
      return handle;
    },
    clearTimeout: (handle) => {
      handlers.delete(handle as number);
    },
  };

  const messages: RecordedMessage[] = [];
  const replyTargets: (string | undefined)[] = [];
  const dispatchers: StreamingDispatcher[] = [];
  let nextMessageId = 1;

  const sender: DiscordSender = {
    openStream(options) {
      replyTargets.push(options.inReplyTo);
      const dispatcher = createStreamingDispatcher({
        hardLimit: 1990,
        flushIntervalMs: 1,
        timer,
        post: async (content) => {
          const message = { id: `m${nextMessageId++}`, content };
          messages.push(message);
          return { messageId: message.id };
        },
        edit: async (messageId, content) => {
          const message = messages.find((candidate) => candidate.id === messageId);
          if (!message) throw new Error(`no message ${messageId}`);
          message.content = content;
        },
        deleteMessage: async (messageId) => {
          const index = messages.findIndex((candidate) => candidate.id === messageId);
          if (index >= 0) messages.splice(index, 1);
        },
      });
      dispatchers.push(dispatcher);
      return dispatcher;
    },
    async sendText(): Promise<SendTextResult> {
      throw new Error("completion path should not be used in these tests");
    },
    async editText(): Promise<EditTextResult> {
      throw new Error("not used");
    },
    async deleteMessage(): Promise<void> {},
    async attach() {
      throw new Error("not used");
    },
    async sendError() {},
  } satisfies DiscordSender;

  let emit: (event: AgentSessionEvent) => void = () => {};
  const delivery = createSendMessageDelivery({
    sender,
    getReplyTarget: () => args.replyTarget,
    subscribe: (handler) => {
      emit = handler;
    },
  });

  return {
    sender,
    delivery,
    emit: (event) => emit(event),
    flush: async () => {
      // Fire every armed flush timer, then let the dispatcher's write chain settle.
      for (let pass = 0; pass < 3; pass++) {
        const armed = [...handlers.values()];
        handlers.clear();
        for (const handler of armed) handler();
        await new Promise((resolve) => setTimeout(resolve, 5));
      }
    },
    messages,
    replyTargets,
    dispatchers,
  };
}

/** Build the argument JSON one character at a time, the way a delta stream arrives. */
function deltasFor(block: ToolCall, json: string): AgentSessionEvent[] {
  return [...json].map((character) => toolCallDelta(block, character));
}

describe("createSendMessageDelivery — preview + claim", () => {
  test("previews the streamed text, then finalises it from the authoritative call", async () => {
    const harness = makeHarness();
    const placeholder = sendMessageCall("call_1", {});
    harness.emit(agentStart());
    harness.emit(toolCallStart(placeholder));
    for (const event of deltasFor(placeholder, '{"text":"hello world"}')) harness.emit(event);
    harness.emit(toolCallEnd(sendMessageCall("call_1", { text: "hello world" })));

    const delivery = await harness.delivery.claimStreamed("call_1");
    expect(delivery?.text).toBe("hello world");
    expect(delivery?.messageIds.length).toBe(1);
    // One message, edited in place — never a duplicate of the preview.
    expect(harness.messages.map((message) => message.content)).toEqual(["hello world"]);
  });

  test("a preview already posted is replaced by the authoritative text, not duplicated", async () => {
    const harness = makeHarness();
    const placeholder = sendMessageCall("call_2", {});
    harness.emit(agentStart());
    harness.emit(toolCallStart(placeholder));
    for (const event of deltasFor(placeholder, '{"text":"part one')) harness.emit(event);
    await harness.flush();
    // The live preview is whatever had been read when the first flush fired.
    expect(harness.messages.map((message) => message.content)).toEqual(["part one"]);

    // The authoritative call differs from the preview (a real case: a held-back
    // escape or a misread tail). The posted message is edited in place.
    harness.emit(toolCallEnd(sendMessageCall("call_2", { text: "part one, corrected" })));
    const delivery = await harness.delivery.claimStreamed("call_2");
    expect(delivery?.text).toBe("part one, corrected");
    expect(harness.messages.map((message) => message.content)).toEqual(["part one, corrected"]);
    expect(harness.messages.length).toBe(1);
  });

  test("a surrogate pair split across deltas never shows half an emoji", async () => {
    const harness = makeHarness();
    const placeholder = sendMessageCall("call_11", {});
    harness.emit(agentStart());
    harness.emit(toolCallStart(placeholder));
    const emoji = "😀";
    for (const codeUnit of `{"text":"hi ` + emoji.slice(0, 1)) {
      harness.emit(toolCallDelta(placeholder, codeUnit));
    }
    await harness.flush();
    // The high half is held back until its partner arrives (rendering trims the
    // trailing space, hence "hi" rather than "hi ").
    expect(harness.messages.map((message) => message.content)).toEqual(["hi"]);
    harness.emit(toolCallDelta(placeholder, emoji.slice(1)));
    await harness.flush();
    expect(harness.messages.map((message) => message.content)).toEqual(["hi 😀"]);
    harness.emit(toolCallEnd(sendMessageCall("call_11", { text: "hi 😀" })));
    await harness.delivery.claimStreamed("call_11");
  });

  test("escaped quotes and newlines survive the preview", async () => {
    const harness = makeHarness();
    const placeholder = sendMessageCall("call_3", {});
    harness.emit(agentStart());
    harness.emit(toolCallStart(placeholder));
    const json = JSON.stringify({ text: 'he said "hi"\nand left' });
    for (const event of deltasFor(placeholder, json)) harness.emit(event);
    harness.emit(toolCallEnd(sendMessageCall("call_3", { text: 'he said "hi"\nand left' })));
    const delivery = await harness.delivery.claimStreamed("call_3");
    expect(delivery?.text).toBe('he said "hi"\nand left');
    expect(await harness.delivery.claimStreamed("call_3")).toBeUndefined();
  });

  test("no claim when nothing was previewed — the tool posts instead", async () => {
    const harness = makeHarness();
    harness.emit(agentStart());
    harness.emit(toolCallStart(sendMessageCall("call_4", {})));
    harness.emit(toolCallEnd(sendMessageCall("call_4", { text: "straight to the tool" })));
    expect(await harness.delivery.claimStreamed("call_4")).toBeUndefined();
    expect(harness.replyTargets).toEqual([]);
  });

  test("unreadable arguments stop the preview but the real text still lands once", async () => {
    const harness = makeHarness();
    const placeholder = sendMessageCall("call_5", {});
    harness.emit(agentStart());
    harness.emit(toolCallStart(placeholder));
    // An invalid escape (`\q`) makes the partial read untrustworthy: no further
    // previewing, and the authoritative arguments replace whatever was shown.
    for (const event of deltasFor(placeholder, '{"text":"a\\qb"}')) harness.emit(event);
    harness.emit(toolCallEnd(sendMessageCall("call_5", { text: "a" })));
    const delivery = await harness.delivery.claimStreamed("call_5");
    expect(delivery?.text).toBe("a");
    expect(harness.messages.map((message) => message.content)).toEqual(["a"]);
  });

  test("only send_message is previewed", async () => {
    const harness = makeHarness();
    const otherCall: ToolCall = { type: "toolCall", id: "call_6", name: "bash", arguments: {} };
    harness.emit(agentStart());
    harness.emit(toolCallStart(otherCall));
    for (const event of deltasFor(otherCall, '{"text":"nope"}')) harness.emit(event);
    harness.emit(toolCallEnd(otherCall));
    expect(harness.replyTargets).toEqual([]);
    expect(harness.messages).toEqual([]);
  });
});

describe("createSendMessageDelivery — reply target", () => {
  test("the first message of a run threads under the waking message, later ones do not", async () => {
    const harness = makeHarness({ replyTarget: "wake-1" });
    harness.emit(agentStart());

    harness.emit(toolCallStart(sendMessageCall("call_7", {})));
    for (const event of deltasFor(sendMessageCall("call_7", {}), '{"text":"first"}')) {
      harness.emit(event);
    }
    harness.emit(toolCallEnd(sendMessageCall("call_7", { text: "first" })));
    await harness.delivery.claimStreamed("call_7");

    harness.emit(toolCallStart(sendMessageCall("call_8", {})));
    for (const event of deltasFor(sendMessageCall("call_8", {}), '{"text":"second"}')) {
      harness.emit(event);
    }
    harness.emit(toolCallEnd(sendMessageCall("call_8", { text: "second" })));
    await harness.delivery.claimStreamed("call_8");

    expect(harness.replyTargets).toEqual(["wake-1", undefined]);
  });

  test("an explicit in_reply_to wins, even when it only arrives after the text", async () => {
    const harness = makeHarness({ replyTarget: "wake-1" });
    harness.emit(agentStart());
    const placeholder = sendMessageCall("call_9", {});
    harness.emit(toolCallStart(placeholder));
    for (const event of deltasFor(placeholder, '{"text":"reply","in_reply_to":"target-9"}')) {
      harness.emit(event);
    }
    harness.emit(
      toolCallEnd(sendMessageCall("call_9", { text: "reply", in_reply_to: "target-9" })),
    );
    await harness.delivery.claimStreamed("call_9");
    // The stream opens with the default target (in_reply_to hasn't arrived yet)
    // and is reopened with the explicit one before anything is posted.
    expect(harness.replyTargets.at(-1)).toBe("target-9");
    expect(harness.messages.length).toBe(1);
  });

  test("the completion path consumes the first-message target exactly once", async () => {
    const harness = makeHarness({ replyTarget: "wake-2" });
    expect(harness.delivery.takeCompletionReplyTarget()).toBe("wake-2");
    expect(harness.delivery.takeCompletionReplyTarget()).toBeUndefined();
  });
});

describe("createSendMessageDelivery — abandoned turns", () => {
  test("an aborted turn flushes what was previewed", async () => {
    const harness = makeHarness();
    const placeholder = sendMessageCall("call_10", {});
    harness.emit(agentStart());
    harness.emit(toolCallStart(placeholder));
    for (const event of deltasFor(placeholder, '{"text":"half a th')) harness.emit(event);
    harness.emit({ type: "turn_end", message: assistant([placeholder], "aborted"), toolResults: [] });
    await harness.flush();
    expect(harness.messages.map((message) => message.content)).toContain("half a th");
  });
});
