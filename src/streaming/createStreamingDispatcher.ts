/**
 * Drives the "stream assistant text into edited Discord messages" loop.
 *
 * The mental model:
 *
 *   - On a delta, append to a raw-markdown buffer and arm a single-slot
 *     timer (no-op if one is already armed). When the timer fires, the
 *     buffer is rendered through `prepareForDelivery` and either posted
 *     as a new Discord message or edited onto the current one.
 *   - When the rendered length crosses `softLimit`, `findSafeSplit`
 *     picks a safe block boundary; the current message is edited down
 *     to that seam (potentially shorter than what's currently shown —
 *     the rollback case), and the carry-over starts a fresh message.
 *   - After each flush settles, if more work piled up during the await
 *     (new deltas, or seal carry-over), we re-arm the timer so it fires
 *     `intervalMs` from flush completion. Gives a "~1s between flush
 *     completions" cadence instead of debounce-after-delta drift.
 *   - End-of-stream drains the buffer immediately (no debounce), running
 *     forced fallbacks if a single huge block needs within-block splitting.
 *
 * The Discord side is injected as `post` / `edit` callbacks so this
 * module is pure logic; tests record calls. Writes are serialized
 * through an internal chain so concurrent settles arrive in order.
 */
import { findSafeSplit } from "./findSafeSplit.ts";
import { prepareForDelivery } from "./prepareForDelivery.ts";

export interface DispatcherTimer {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DispatcherConfig {
  /** Send a fresh Discord message. Returns the new message's ID, or null on failure. */
  post: (content: string) => Promise<{ messageId: string } | null>;
  /** Edit an existing Discord message. Rejection is logged; next delta retries. */
  edit: (messageId: string, content: string) => Promise<void>;
  /** Try-paragraph-seam target. Once exceeded with a clean seam, the dispatcher splits. */
  softLimit: number;
  /** Absolute per-message cap; once exceeded, the splitter forces a within-block split. */
  hardLimit: number;
  /**
   * Wait this long before firing each flush. Default 1000ms — matches
   * Discord's empirical ~5-edits-per-5-seconds per-channel bucket, and
   * batches enough content into the initial post so first-message
   * latency doesn't show as "Hi! " (4 chars) before the model has
   * actually said anything.
   */
  intervalMs?: number;
  /** Timer source. Tests inject a fake clock for deterministic scheduling. */
  timer?: DispatcherTimer;
}

export interface StreamingDispatcher {
  /** Append a delta. Arms the flush timer if not already pending. */
  append(delta: string): void;
  /** End the stream. Drains pending content immediately; resolves on settle. */
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
    intervalMs = 1000,
    timer = realTimer,
  } = config;

  // Pending raw-markdown content. Every flush renders this through
  // prepareForDelivery and either posts it or edits the current message.
  let buffer = "";
  // The Discord message currently being edited; null before first post
  // and again briefly after a seal until the next flush posts the carry-over.
  let currentMessageId: string | null = null;
  // Last rendered text we sent for currentMessageId — skips redundant edits.
  let lastSentContent = "";
  // Single-slot flush timer. Armed by deltas (if not pending) and re-armed
  // after a flush settles when more work piled up during the await.
  let timerHandle: unknown = null;
  // Serial chain so writes settle in display order.
  let writeChain: Promise<unknown> = Promise.resolve();
  // Settled list of messages we've created.
  const messageIds: string[] = [];
  // True while end() is draining; forces seal fallbacks even mid-construct.
  let ending = false;

  function armTimer(): void {
    if (timerHandle !== null) return;
    timerHandle = timer.setTimeout(() => {
      timerHandle = null;
      enqueueFlush();
    }, intervalMs);
  }

  function clearTimer(): void {
    if (timerHandle === null) return;
    timer.clearTimeout(timerHandle);
    timerHandle = null;
  }

  function enqueueFlush(): void {
    writeChain = writeChain
      .then(async () => {
        const bufferBefore = buffer;
        await flushNow();
        // Rebase the next tick to fire intervalMs from THIS flush's
        // completion, not from the next delta. If a delta armed a
        // timer during the flush's await, replace it; otherwise this
        // is just the post-flush re-arm. Either way, the cadence is
        // "intervalMs after each flush settles" rather than drifting.
        if (buffer !== bufferBefore && !ending) {
          clearTimer();
          armTimer();
        }
      })
      .catch((error) => {
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
      // No clean seam and not forced. Fall through and edit/post with
      // what we have; the next delta will trigger another attempt.
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
    armTimer();
  }

  async function end(): Promise<void> {
    ending = true;
    clearTimer();
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
    clearTimer();
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
