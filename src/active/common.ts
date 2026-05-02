/**
 * Per-channel state recorded in the active-state file. Shared between
 * the tracker (writer), the recovery dispatcher (reader), and the
 * session subscriber that flips `inTool` based on tool events.
 *
 * Field semantics:
 *   - `pending`           — user message received, no delivery yet (work
 *                           owed by the agent).
 *   - `inTool`            — a tool was executing when the bot died;
 *                           agent.continue() would replay it, so recovery
 *                           uses a synthetic prompt instead.
 *   - `cameFromRestart`   — the bot exited intentionally (restart_self /
 *                           !restart). Lets recovery distinguish a
 *                           planned restart from a mid-think crash.
 *   - `lastSeenMessageId` — most recent Discord message ID the client
 *                           received in this channel. Survives across
 *                           restarts so recovery can hand the agent a
 *                           catchup hint (`history(after=…)`). The only
 *                           field that's "memory" rather than "work
 *                           state" — persists even when nothing's owed.
 */
export interface ChannelState {
  pending: boolean;
  inTool: boolean;
  cameFromRestart: boolean;
  lastSeenMessageId?: string;
}
