/**
 * Circuit breaker for the "model only ever calls `send`" failure mode. If
 * the agent loops over and over, calling exactly one `send` per turn and
 * nothing else, that's almost certainly a bug (model can't decide to stop
 * via `end_of_turn: true`, for example) — abort the session before it eats
 * budget and floods the channel.
 *
 * State is encapsulated per session: the counter owns its number inside
 * the closure and exposes only what the caller needs to drive it. The
 * single writer means the classifier (`installEnvelopeEnforcement`) and
 * the counter never race over the same field.
 *
 * Legitimate multi-message replies fit in fewer than `runawaySendLimit`
 * turns. This is a runaway guard, not a content cap.
 */
import type { AgentSession } from "@mariozechner/pi-coding-agent";

const runawaySendLimit = 8;

interface ToolCallPart {
  type: string;
  name?: string;
}

export interface RunawayCounter {
  /** Reset back to zero — call at the start of a fresh run, or when a non-send tool call happened. */
  reset(): void;
  /**
   * Record the just-finished turn's tool calls. Increments the counter if
   * the turn was send-only; resets if it called anything else. When the
   * counter exceeds the limit, aborts the session.
   */
  recordTurn(toolCalls: ToolCallPart[]): void;
}

export function createRunawayCounter(session: AgentSession): RunawayCounter {
  let consecutiveSendOnly = 0;

  return {
    reset(): void {
      consecutiveSendOnly = 0;
    },
    recordTurn(toolCalls): void {
      const onlySend = toolCalls.length === 1 && toolCalls[0]?.name === "send";
      if (!onlySend) {
        consecutiveSendOnly = 0;
        return;
      }
      consecutiveSendOnly += 1;
      if (consecutiveSendOnly > runawaySendLimit) {
        console.warn(
          `[runaway] aborting after ${consecutiveSendOnly} consecutive send turns`,
        );
        session.abort();
        consecutiveSendOnly = 0;
      }
    },
  };
}
