/**
 * Drives the "stream assistant text into edited Discord messages" loop.
 *
 * The dispatcher receives raw text deltas from the agent runtime and
 * turns them into Discord writes:
 *
 *   1. Each flush: run the raw buffer through `prepareForDelivery`
 *      (remend → remark parse → transforms → stringify), yielding the
 *      Discord-ready string and a list of top-level block boundaries.
 *   2. First flush of a stream → post a new Discord message after a short
 *      debounce, so a flurry of fast deltas batch into a single send.
 *   3. Subsequent flushes → edit the same message on a longer debounce
 *      (Discord's per-channel edit bucket is small).
 *   4. Rendered length crosses the soft limit → `findSafeSplit` picks
 *      the latest block boundary at-or-before the limit. The current
 *      message gets edited down to `keepRendered` (potentially shorter
 *      than what was just shown — the rollback case), the raw buffer is
 *      sliced past `rawConsumed`, and the next flush posts the rest as
 *      a fresh message.
 *   5. End of stream → cancel debouncers, flush until empty (forced
 *      fallbacks engage so within-block splits eventually drain).
 *
 * The Discord side is injected as `post` / `edit` callbacks so this
 * module is pure logic and can be unit-tested by recording calls.
 * Writes are serialized through an internal chain so concurrent settles
 * arrive in order on the displayed message.
 */
import { findSafeSplit } from "./findSafeSplit.ts";
import { prepareForDelivery } from "./prepareForDelivery.ts";

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
    if (buffer.trim().length === 0) {
      // Discord rejects whitespace-only content; drop the chunk.
      buffer = "";
      return;
    }

    const prep = prepareForDelivery(buffer);
    if (prep.rendered.length === 0) {
      buffer = "";
      return;
    }

    // Try to seal if we're past the soft limit (in rendered chars).
    if (prep.rendered.length > softLimit) {
      const force = ending || prep.rendered.length > hardLimit;
      const split = findSafeSplit(prep, { softLimit, hardLimit, force });
      if (split !== null) {
        // Seal current message (or post split.keep fresh if no current).
        if (currentMessageId !== null) {
          if (split.keepRendered !== lastSentContent && split.keepRendered.length > 0) {
            try {
              await edit(currentMessageId, split.keepRendered);
              lastSentContent = split.keepRendered;
            } catch (error) {
              console.error("[streaming] seal-edit failed:", error);
            }
          }
        } else if (split.keepRendered.length > 0) {
          const result = await post(split.keepRendered);
          if (result !== null) messageIds.push(result.messageId);
        }
        // Drop the raw chars consumed by `keep`; deltas arriving during
        // the seal-edit (now past `split.rawConsumed` in the buffer) ride
        // through naturally.
        buffer = buffer.slice(split.rawConsumed);
        currentMessageId = null;
        lastSentContent = "";
        if (buffer.length > 0) enqueueFlush();
        return;
      }
      // No clean seam and not forced. Fall through and just edit/post
      // with what we have; we'll try again on the next delta.
    }

    if (currentMessageId === null) {
      const result = await post(prep.rendered);
      if (result === null) {
        // Post failed — drop the chunk to avoid a stuck retry loop.
        buffer = "";
        return;
      }
      currentMessageId = result.messageId;
      messageIds.push(result.messageId);
      lastSentContent = prep.rendered;
      return;
    }

    if (prep.rendered === lastSentContent) return;
    try {
      await edit(currentMessageId, prep.rendered);
      lastSentContent = prep.rendered;
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
