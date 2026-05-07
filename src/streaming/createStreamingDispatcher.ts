/**
 * Drives the "stream assistant text into edited Discord messages" loop.
 *
 * The dispatcher receives text deltas from the agent runtime and turns them
 * into Discord writes:
 *
 *   1. First delta arrives → post a new Discord message after a short
 *      debounce, so a flurry of fast deltas batch into a single send.
 *   2. Subsequent deltas → edit the same Discord message on a longer
 *      debounce (Discord's per-channel edit bucket is small).
 *   3. Buffer outgrows the soft limit → call `findSafeSplit` to find the
 *      latest paragraph seam outside any fenced code block; edit the
 *      current message down to `keep`, leave `carryOver` in the buffer
 *      so the next flush posts it as a new message. This is the rollback
 *      case: the displayed message may have already shown content past
 *      the seam (we showed it optimistically); the edit walks it back.
 *   4. End of stream → cancel debouncers, flush until empty.
 *
 * The Discord side is injected as `post` / `edit` callbacks so this module
 * is pure logic and can be unit-tested by recording calls. Writes are
 * serialized through an internal chain so concurrent settles arrive in
 * order on the displayed message.
 */
import { findSafeSplit } from "./findSafeSplit.ts";

export interface DispatcherTimer {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DispatcherConfig {
  /**
   * Send a fresh Discord message with `content`. Returns the new message's
   * ID, or null if the send failed (the dispatcher then drops that chunk).
   */
  post: (content: string) => Promise<{ messageId: string } | null>;
  /**
   * Edit an existing Discord message. A rejection is logged and the
   * displayed content is treated as stale until the next delta forces
   * another edit.
   */
  edit: (messageId: string, content: string) => Promise<void>;
  /**
   * Try-paragraph-seam target. Once the buffer exceeds this and a clean
   * seam exists, the dispatcher splits.
   */
  softLimit: number;
  /**
   * Absolute per-message cap. The dispatcher never lets a single message
   * grow past this; once forced, the splitter falls back to line/word/hard.
   */
  hardLimit: number;
  /**
   * Wait this long after the first delta of a stream before posting. Default 80ms.
   */
  initialPostDelayMs?: number;
  /**
   * Wait this long between edit calls. Default 600ms (under Discord's
   * ~5-edits-per-5-seconds per-channel bucket).
   */
  editDebounceMs?: number;
  /**
   * Timer source. Tests inject a fake clock for deterministic scheduling.
   */
  timer?: DispatcherTimer;
}

export interface StreamingDispatcher {
  /** Append a delta. Schedules a write if one isn't pending. */
  append(delta: string): void;
  /** End the current stream. Flushes pending content; resolves on settle. */
  end(): Promise<void>;
  /** Reset state for a fresh stream (e.g., new text block after a tool call). */
  reset(): void;
  /** IDs of every Discord message posted by this dispatcher in order. */
  getPostedMessageIds(): readonly string[];
}

const realTimer: DispatcherTimer = {
  setTimeout: (handler, ms) => globalThis.setTimeout(handler, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as Parameters<typeof clearTimeout>[0]),
};

export function createStreamingDispatcher(config: DispatcherConfig): StreamingDispatcher {
  const {
    post,
    edit,
    softLimit,
    hardLimit,
    initialPostDelayMs = 80,
    editDebounceMs = 600,
    timer = realTimer,
  } = config;

  // Pending content. After first post, equals the latest intended message
  // body; every flush replaces the message wholesale via edit.
  let buffer = "";
  // Discord message currently being edited; null before first post and
  // again after a seal until the next flush posts the carry-over.
  let currentMessageId: string | null = null;
  // Last content we sent for currentMessageId — skip redundant edits.
  let lastSentContent = "";
  // Debounce / initial-post timer handle. One pending flush at a time.
  let timerHandle: unknown = null;
  // Serial chain so writes settle in order.
  let writeChain: Promise<unknown> = Promise.resolve();
  // Settled list of messages we've created.
  const messageIds: string[] = [];
  // True while end() is draining; forces seal fallbacks even mid-construct.
  let ending = false;

  function scheduleFlush(delay: number): void {
    if (timerHandle !== null) return; // one pending flush at a time
    timerHandle = timer.setTimeout(() => {
      timerHandle = null;
      enqueueFlush();
    }, delay);
  }

  function enqueueFlush(): void {
    writeChain = writeChain.then(flushNow).catch((error) => {
      console.error("[streaming] write chain settled with error:", error);
    });
  }

  async function flushNow(): Promise<void> {
    if (buffer.length === 0) return;
    // Discord rejects whitespace-only content. Drop and bail out — the
    // model is between meaningful tokens.
    if (buffer.trim().length === 0) {
      buffer = "";
      return;
    }

    // Try to seal if we're past the soft limit.
    if (buffer.length > softLimit) {
      const sealedAtLen = buffer.length;
      const force = ending || sealedAtLen > hardLimit;
      const split = findSafeSplit(buffer, { softLimit, hardLimit, force });
      if (split !== null) {
        // Seal current message (or post split.keep fresh if no current).
        if (currentMessageId !== null) {
          if (split.keep !== lastSentContent && split.keep.length > 0) {
            try {
              await edit(currentMessageId, split.keep);
              lastSentContent = split.keep;
            } catch (error) {
              console.error("[streaming] seal-edit failed:", error);
            }
          }
        } else if (split.keep.length > 0) {
          const result = await post(split.keep);
          if (result !== null) messageIds.push(result.messageId);
        }
        // Capture deltas that arrived during the seal-edit await.
        const tail = buffer.slice(sealedAtLen);
        buffer = split.carryOver + tail;
        currentMessageId = null;
        lastSentContent = "";
        // Continue draining: the new buffer may itself need sealing or
        // posting. Chain another flush.
        if (buffer.length > 0) enqueueFlush();
        return;
      }
      // No clean seam at this size and not forced. Fall through to a
      // regular edit; we'll try again on the next delta.
    }

    if (currentMessageId === null) {
      const content = buffer;
      const result = await post(content);
      if (result === null) {
        // Post failed — drop the chunk to avoid a stuck retry loop.
        buffer = "";
        return;
      }
      currentMessageId = result.messageId;
      messageIds.push(result.messageId);
      lastSentContent = content;
      // If late deltas arrived during post, the residual buffer (anything
      // beyond `content`) is what actually represents "unsent" content.
      // We sent the snapshot; everything past it is still pending.
      buffer = content + buffer.slice(content.length);
      // (No-op assignment, but documents the invariant.)
      return;
    }

    if (buffer === lastSentContent) return;
    const content = buffer;
    try {
      await edit(currentMessageId, content);
      lastSentContent = content;
    } catch (error) {
      console.error("[streaming] edit failed:", error);
      // Leave lastSentContent unchanged so the next flush retries.
    }
  }

  function append(delta: string): void {
    if (delta.length === 0) return;
    buffer += delta;
    if (currentMessageId === null) {
      scheduleFlush(initialPostDelayMs);
    } else {
      scheduleFlush(editDebounceMs);
    }
  }

  async function end(): Promise<void> {
    ending = true;
    if (timerHandle !== null) {
      timer.clearTimeout(timerHandle);
      timerHandle = null;
    }
    // Drain: keep flushing until the buffer is empty (or stops shrinking).
    enqueueFlush();
    await writeChain;
    while (buffer.length > 0) {
      const before = buffer.length;
      enqueueFlush();
      await writeChain;
      if (buffer.length >= before) break;
    }
    ending = false;
  }

  function reset(): void {
    if (timerHandle !== null) {
      timer.clearTimeout(timerHandle);
      timerHandle = null;
    }
    buffer = "";
    currentMessageId = null;
    lastSentContent = "";
    ending = false;
  }

  function getPostedMessageIds(): readonly string[] {
    return messageIds;
  }

  return { append, end, reset, getPostedMessageIds };
}
