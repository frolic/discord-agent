/**
 * Drives the "stream assistant text into edited Discord messages" loop.
 *
 * Mental model: as deltas arrive we accumulate the FULL stream source
 * from the start. Each flush re-parses the whole accumulated buffer
 * through `prepareForDelivery`, runs `chunkRendered` over it to derive
 * one rendered string per Discord message, and reconciles those chunks
 * against the messages we've already posted:
 *
 *   - If chunk[i] is unchanged from `messages[i].lastSent`: skip (no edit).
 *   - If chunk[i] differs: edit `messages[i]` with the new content.
 *   - If chunks are longer than `messages.length`: post the new ones.
 *
 * Sealed messages stabilize naturally — once the stream content past a
 * chunk boundary stops shifting that boundary, the sealed chunk's text
 * stops changing and the diff-skip avoids redundant edits. We never
 * destructively slice the buffer, so context for re-deriving chunks
 * (table headers, code-block fences, etc.) is always intact.
 *
 * The flush timer fires on a single-slot debounce: armed by deltas,
 * re-armed after each flush completes if the buffer changed during the
 * await. Gives a "~flushIntervalMs between flushes" cadence regardless
 * of REST latency drift.
 */
import { chunkRendered } from "./chunkRendered.ts";
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
  /** Absolute per-message render-character cap. Discord's is 2000; production passes ~1990. */
  hardLimit: number;
  /**
   * Wait this long before firing each flush. Default 1000ms — matches
   * Discord's empirical ~5-edits-per-5-seconds per-channel bucket and
   * batches enough content into the initial post so first-message
   * latency doesn't show a 4-char tease.
   */
  flushIntervalMs?: number;
  /** Timer source. Tests inject a fake clock for deterministic scheduling. */
  timer?: DispatcherTimer;
}

export interface StreamingDispatcher {
  /** Append a delta to the accumulated source. Arms the flush timer if not already pending. */
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

interface DiscordMessage {
  id: string;
  /** Last rendered content we sent to this Discord message — skip-edit check. */
  lastSent: string;
}

export function createStreamingDispatcher(config: DispatcherConfig): StreamingDispatcher {
  const { post, edit, hardLimit, flushIntervalMs = 1000, timer = realTimer } = config;

  // Full source from start of stream, never sliced. Each flush re-parses
  // the entire thing and re-derives chunks; sealed messages stabilize
  // via the lastSent diff-skip.
  let accumulatedRaw = "";
  // The Discord messages this dispatcher has posted, in order. We post
  // a new one when chunks exceed `messages.length`; we edit when
  // chunk[i] differs from `messages[i].lastSent`.
  const messages: DiscordMessage[] = [];
  // Single-slot flush timer.
  let timerHandle: unknown = null;
  // Serial chain so writes settle in display order.
  let writeChain: Promise<unknown> = Promise.resolve();
  // True while end() is draining.
  let ending = false;

  function startTimer(): void {
    if (timerHandle !== null) return;
    timerHandle = timer.setTimeout(() => {
      timerHandle = null;
      enqueueFlush();
    }, flushIntervalMs);
  }

  function stopTimer(): void {
    if (timerHandle === null) return;
    timer.clearTimeout(timerHandle);
    timerHandle = null;
  }

  function enqueueFlush(): void {
    writeChain = writeChain
      .then(async () => {
        const rawBefore = accumulatedRaw;
        await flushNow();
        // Re-arm if more deltas arrived during the flush. Cancel any
        // delta-armed timer first so the next tick fires
        // flushIntervalMs from THIS flush's completion (not from the
        // most recent delta) — predictable cadence.
        if (accumulatedRaw !== rawBefore && !ending) {
          stopTimer();
          startTimer();
        }
      })
      .catch((error) => {
        console.error("[streaming] write chain settled with error:", error);
      });
  }

  async function flushNow(): Promise<void> {
    if (accumulatedRaw.length === 0) return;
    if (accumulatedRaw.trim().length === 0) return;

    const prep = prepareForDelivery(accumulatedRaw);
    const chunks = chunkRendered(prep, { hardLimit });
    if (chunks.length === 0) return;

    // Reconcile: edit-or-skip the overlap with existing messages, post
    // the tail.
    const overlap = Math.min(chunks.length, messages.length);
    for (let i = 0; i < overlap; i++) {
      const desired = chunks[i]!;
      const message = messages[i]!;
      if (desired === message.lastSent) continue;
      try {
        await edit(message.id, desired);
        message.lastSent = desired;
      } catch (error) {
        console.error("[streaming] edit failed:", error);
        // Leave lastSent unchanged so the next flush retries.
      }
    }
    for (let i = overlap; i < chunks.length; i++) {
      const desired = chunks[i]!;
      const result = await post(desired);
      if (result === null) {
        // Post failed — bail out. Subsequent posts would land out of
        // order. Next flush will try again.
        return;
      }
      messages.push({ id: result.messageId, lastSent: desired });
    }
  }

  function append(delta: string): void {
    if (delta.length === 0) return;
    accumulatedRaw += delta;
    startTimer();
  }

  async function end(): Promise<void> {
    ending = true;
    stopTimer();
    enqueueFlush();
    await writeChain;
    ending = false;
  }

  function reset(): void {
    stopTimer();
    accumulatedRaw = "";
    messages.length = 0;
    ending = false;
  }

  function getPostedMessageIds(): readonly string[] {
    return messages.map((m) => m.id);
  }

  return { append, end, reset, getPostedMessageIds };
}
