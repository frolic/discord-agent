/**
 * Progress watchdog — the channel never sits silent while a tool runs.
 *
 * Long work is now asynchronous (see `agent/jobs.ts`), which fixes the turn being
 * blocked but introduces a new silence: the agent is off polling, the user sees
 * nothing, and "is it working?" becomes guesswork. So the harness itself watches
 * tool execution and, when a tool has been running past a threshold, posts a
 * short note to the channel on its own initiative.
 *
 * Deliberate properties:
 *
 * - **Harness output, not model output.** It goes straight to the channel through
 *   the sender, so it works identically in both chat modes and cannot be
 *   swallowed by the model forgetting to call `send_message`.
 * - **Bounded noise.** One note per threshold crossing, then doubling intervals
 *   (30s → 60s → 120s …), up to `maxNotes` per tool call. A ten-minute job
 *   produces a handful of lines, not one a second.
 * - **It never kills anything.** A stall is a thing to report, not a thing to fix
 *   by force; the agent (and the user) decide.
 */
import type { AgentSession } from "@earendil-works/pi-coding-agent";
import type { DiscordSender } from "../io/createDiscordSender.ts";

export interface ProgressWatchdogOptions {
  /** Seconds before the first note for a running tool call. `0` disables the watchdog. */
  firstNoteSeconds?: number;
  /** Upper bound on notes for a single tool call. */
  maxNotes?: number;
  /** Timer source, for tests. */
  now?: () => number;
}

/**
 * Post one note per threshold crossing while a tool call runs. Returns a stop
 * function for eviction/shutdown.
 */
export function installProgressWatchdog(args: {
  session: AgentSession;
  sender: DiscordSender;
  options?: ProgressWatchdogOptions;
}): () => void {
  const { session, sender } = args;
  const firstNoteSeconds = args.options?.firstNoteSeconds ?? 30;
  const maxNotes = args.options?.maxNotes ?? 4;
  if (firstNoteSeconds <= 0) return () => {};

  // toolCallId → { toolName, startedAt, notes, timer }
  const running = new Map<
    string,
    { toolName: string; startedAt: number; notes: number; timer: ReturnType<typeof setTimeout> | null }
  >();
  let stopped = false;

  function schedule(entryKey: string): void {
    const entry = running.get(entryKey);
    if (!entry || stopped) return;
    // Doubling backoff: 30s, 60s, 120s, 240s …
    const delayMs = firstNoteSeconds * 1000 * 2 ** entry.notes;
    entry.timer = setTimeout(() => {
      const current = running.get(entryKey);
      if (!current || stopped || current.notes >= maxNotes) return;
      current.notes += 1;
      const elapsedSeconds = Math.round((Date.now() - current.startedAt) / 1000);
      void sender
        .sendWatchdogNote({ toolName: current.toolName, elapsedSeconds })
        .catch((error) => console.error("[watchdog] progress note failed:", error));
      schedule(entryKey);
    }, delayMs);
    // Never keep the process alive for a progress note.
    entry.timer.unref?.();
  }

  const unsubscribe = session.subscribe((event) => {
    if (event.type === "tool_execution_start") {
      running.set(event.toolCallId, {
        toolName: event.toolName,
        startedAt: Date.now(),
        notes: 0,
        timer: null,
      });
      schedule(event.toolCallId);
      return;
    }
    if (event.type === "tool_execution_end") {
      const entry = running.get(event.toolCallId);
      if (entry?.timer) clearTimeout(entry.timer);
      running.delete(event.toolCallId);
      return;
    }
    if (event.type === "agent_end") {
      // A turn ending with a tool still "running" means the tool result never
      // arrived (abort, crash) — nothing left to report on.
      for (const entry of running.values()) {
        if (entry.timer) clearTimeout(entry.timer);
      }
      running.clear();
    }
  });

  return () => {
    stopped = true;
    for (const entry of running.values()) {
      if (entry.timer) clearTimeout(entry.timer);
    }
    running.clear();
    unsubscribe();
  };
}
