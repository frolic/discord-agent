/**
 * Single-slot debounce timer.
 *
 * Owns the "one pending callback at a time" invariant the streaming
 * dispatcher needs: every `schedule(delayMs)` is a no-op if a callback
 * is already pending, otherwise it (re)arms the underlying timer with
 * the requested delay. When the timer fires, the slot is cleared and
 * the configured `onFire` runs synchronously — so subsequent
 * `schedule` calls during `onFire` re-arm fresh.
 *
 * Extracted from `createStreamingDispatcher` so the scheduling guard
 * is independently testable and the dispatcher's own state is one
 * concern shorter.
 */

export interface DispatcherTimer {
  setTimeout(handler: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

export interface DebounceTimer {
  /**
   * Schedule `onFire` to run after `delayMs`. No-op if a previous
   * `schedule` is still pending — the existing timer keeps its
   * original delay rather than getting rearmed shorter.
   */
  schedule(delayMs: number): void;
  /** Cancel any pending callback. Idempotent. */
  clear(): void;
  /** True iff a callback is currently pending. */
  isPending(): boolean;
}

export function createDebounceTimer(args: {
  timer: DispatcherTimer;
  onFire: () => void;
}): DebounceTimer {
  const { timer, onFire } = args;
  let handle: unknown = null;

  return {
    schedule(delayMs) {
      if (handle !== null) return;
      handle = timer.setTimeout(() => {
        handle = null;
        onFire();
      }, delayMs);
    },
    clear() {
      if (handle === null) return;
      timer.clearTimeout(handle);
      handle = null;
    },
    isPending() {
      return handle !== null;
    },
  };
}
