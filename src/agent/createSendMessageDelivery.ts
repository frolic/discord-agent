/**
 * Live preview for `send_message` in `CHAT_MODE=tools`.
 *
 * In stream mode the typing effect comes free: assistant text deltas are the
 * reply. In tools mode the reply is a tool call, so the text only exists as the
 * growing JSON of the call's arguments. pi hands us that growth directly —
 * `toolcall_start` / `toolcall_delta` (the next chunk of argument JSON) /
 * `toolcall_end` (the authoritative parsed call) — so the same effect is
 * reachable: read the `text` field out of the partial JSON, append the new suffix
 * to a `StreamingDispatcher`, and let it post/ edit as usual.
 *
 * Three rules keep that honest:
 *
 * 1. **The preview is never the final content.** At `toolcall_end` the
 *    authoritative `arguments.text` replaces the accumulated source
 *    (`replaceSource`), so a partial-unescape error is corrected in place — the
 *    dispatcher edits the messages it already posted or removes the surplus.
 * 2. **Unreadable arguments mean no preview, not a broken one.** A non-monotonic
 *    or malformed partial read stops streaming; the tool then posts the finished
 *    text itself.
 * 3. **One owner per reply.** The finished delivery is registered under the tool
 *    call's ID, and `send_message.execute` claims it — so streaming never
 *    produces a second copy of the same message.
 *
 * Only the first `send_message` of an assistant message streams when calls
 * overlap (parallel tool calls interleave their deltas, and two live-growing
 * messages at once read as a glitch). Later ones post on completion.
 *
 * Constructed *before* the session exists (the tool set is built as an argument
 * to session creation), so the caller wires `attachTo(session)` afterwards — the
 * same shape `createDebugLogger` uses.
 */
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import type { ChatDelivery, StreamedDelivery } from "./chatDelivery.ts";
import type { DiscordSender } from "../io/createDiscordSender.ts";
import { readPartialStringField } from "../streaming/partialJsonStringField.ts";
import type { StreamingDispatcher } from "../streaming/createStreamingDispatcher.ts";

const sendMessageToolName = "send_message";

/** In-flight preview for one tool call. */
interface ActivePreview {
  contentIndex: number;
  /** Raw argument JSON accumulated from `toolcall_delta`. */
  rawArguments: string;
  /** Text already appended to the dispatcher (the diff baseline). */
  emitted: string;
  /** Set once the first suffix lands; null means nothing has been posted. */
  dispatcher: StreamingDispatcher | null;
  /** Reply target the dispatcher was opened with. */
  replyTarget: string | undefined;
  /** True when the partial read stopped being trustworthy. */
  degraded: boolean;
}

export function createSendMessageDelivery(args: {
  sender: DiscordSender;
  /** The message this run should reply under, if any (see `PoolEntry.replyTarget`). */
  getReplyTarget: () => string | undefined;
  /** Called once with the streamer's event handler; the pool wires it to `session.subscribe`. */
  subscribe: (handler: (event: AgentSessionEvent) => void) => void;
}): ChatDelivery {
  const { sender, getReplyTarget, subscribe } = args;

  const inFlightPreviews = new Map<string, Promise<StreamedDelivery | undefined>>();
  let active: ActivePreview | null = null;
  // Only the first delivered message of a run carries the reply badge.
  let isFirstMessageOfRun = true;
  // Whether anything reached the user during the current run — distinguishes a
  // rejected reply from chatter after a successful one.
  let deliveredThisRun = false;

  function defaultReplyTarget(): string | undefined {
    return isFirstMessageOfRun ? getReplyTarget() : undefined;
  }

  function openDispatcher(preview: ActivePreview, replyTarget: string | undefined): void {
    preview.dispatcher = sender.openStream({ inReplyTo: replyTarget });
    preview.replyTarget = replyTarget;
  }

  function startPreview(contentIndex: number): ActivePreview | null {
    // Only one live preview at a time — see the header note on parallel calls.
    if (active) return null;
    const preview: ActivePreview = {
      contentIndex,
      rawArguments: "",
      emitted: "",
      dispatcher: null,
      replyTarget: undefined,
      degraded: false,
    };
    active = preview;
    return preview;
  }

  function appendPreview(preview: ActivePreview, delta: string): void {
    if (preview.degraded) return;
    preview.rawArguments += delta;
    const read = readPartialStringField(preview.rawArguments, "text");
    if (read.malformed) {
      // Never let a misread become the delivered text: stop previewing and let
      // the completion path post the authoritative version.
      console.error("[sendMessageStreamer] partial argument read went malformed — not previewing");
      preview.degraded = true;
      return;
    }
    if (read.value === null) return;
    if (!read.value.startsWith(preview.emitted)) {
      console.error("[sendMessageStreamer] partial read was not monotonic — not previewing");
      preview.degraded = true;
      return;
    }
    const suffix = read.value.slice(preview.emitted.length);
    if (suffix.length === 0) return;
    preview.emitted = read.value;
    if (!preview.dispatcher) {
      const explicitReplyTarget = readPartialStringField(preview.rawArguments, "in_reply_to");
      openDispatcher(preview, explicitReplyTarget.value ?? defaultReplyTarget());
    }
    preview.dispatcher?.append(suffix);
  }

  /**
   * Finish a preview against the authoritative call. Returns the delivery when
   * messages were actually posted (the tool then claims it and posts nothing).
   */
  async function finalizePreview(
    preview: ActivePreview,
    authoritativeText: string | null,
    explicitReplyTarget: string | undefined,
  ): Promise<StreamedDelivery | undefined> {
    const dispatcher = preview.dispatcher;
    if (!dispatcher) return undefined;
    if (authoritativeText === null) {
      // Arguments didn't parse into a usable `text`: keep whatever the preview
      // showed rather than deleting a half-written reply, and let the tool's own
      // validation surface the error.
      await dispatcher.end();
      return undefined;
    }
    // The reply target may only have become readable after the preview's first
    // flush (arguments stream after `text`). If nothing was posted yet, reopen
    // with the right target instead of replying in the wrong place.
    const desiredTarget = explicitReplyTarget ?? preview.replyTarget;
    if (dispatcher.getPostedMessageIds().length === 0 && desiredTarget !== preview.replyTarget) {
      // Nothing was posted yet, so the wrong-target dispatcher can be dropped
      // without a trace — but its flush timer has to be stopped first, or it
      // would post the preview later as a second message.
      dispatcher.reset();
      openDispatcher(preview, desiredTarget);
    }
    const target = preview.dispatcher ?? dispatcher;
    target.replaceSource(authoritativeText);
    await target.end();
    const messageIds = target.getPostedMessageIds();
    if (messageIds.length === 0) return undefined;
    isFirstMessageOfRun = false;
    return { messageIds, text: authoritativeText };
  }

  /** Flush a preview that never reached `toolcall_end` (aborted turn). */
  function abandonActive(): void {
    const preview = active;
    active = null;
    if (!preview?.dispatcher) return;
    const dispatcher = preview.dispatcher;
    void dispatcher.end().catch((error) => {
      console.error("[sendMessageStreamer] flushing an abandoned preview failed:", error);
    });
    isFirstMessageOfRun = false;
  }

  subscribe((event) => {
    if (event.type === "agent_start") {
      isFirstMessageOfRun = true;
      return;
    }
    if (event.type === "agent_end") {
      abandonActive();
      inFlightPreviews.clear();
      return;
    }
    if (event.type === "turn_end") {
      // A normal turn ends *after* its tool calls ran, so the claim has already
      // happened. Only an aborted turn leaves a preview open.
      abandonActive();
      return;
    }
    if (event.type !== "message_update") return;
    const assistantMessageEvent = event.assistantMessageEvent;

    if (assistantMessageEvent.type === "toolcall_start") {
      const part = assistantMessageEvent.partial.content[assistantMessageEvent.contentIndex];
      if (!part || part.type !== "toolCall" || part.name !== sendMessageToolName) return;
      startPreview(assistantMessageEvent.contentIndex);
      return;
    }

    if (assistantMessageEvent.type === "toolcall_delta") {
      if (!active || active.contentIndex !== assistantMessageEvent.contentIndex) return;
      appendPreview(active, assistantMessageEvent.delta);
      return;
    }

    if (assistantMessageEvent.type === "toolcall_end") {
      const preview = active;
      if (!preview || preview.contentIndex !== assistantMessageEvent.contentIndex) return;
      active = null;
      const toolCall = assistantMessageEvent.toolCall;
      if (toolCall.name !== sendMessageToolName) return;
      const argumentsObject = toolCall.arguments;
      const text = typeof argumentsObject.text === "string" ? argumentsObject.text : null;
      const explicitReplyTarget =
        typeof argumentsObject.in_reply_to === "string" ? argumentsObject.in_reply_to : undefined;
      inFlightPreviews.set(
        toolCall.id,
        finalizePreview(preview, text, explicitReplyTarget).catch((error) => {
          console.error("[sendMessageStreamer] finalizing the preview failed:", error);
          return undefined;
        }),
      );
    }
  });

  return {
    markDelivered(): void {
      deliveredThisRun = true;
    },
    deliveredThisRun(): boolean {
      return deliveredThisRun;
    },
    resetDelivered(): void {
      deliveredThisRun = false;
    },
    claimStreamed(toolCallId: string): Promise<StreamedDelivery | undefined> {
      const delivery = inFlightPreviews.get(toolCallId);
      // A claim happens exactly once per tool call; drop it so a long-lived warm
      // session does not accumulate every reply it ever streamed.
      inFlightPreviews.delete(toolCallId);
      return delivery ?? Promise.resolve(undefined);
    },
    takeCompletionReplyTarget(): string | undefined {
      if (!isFirstMessageOfRun) return undefined;
      isFirstMessageOfRun = false;
      return getReplyTarget();
    },
  };
}
