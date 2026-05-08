/**
 * Discord typing indicator — the channel-based "agent is working" loading
 * cue. Stays visible while the agent is doing anything observable: an LLM
 * turn, a tool call, or a compaction. Self-contained: subscribes to
 * session events and manages its own timer. Shares no state with
 * `DiscordSender` or `DebugLogger`, so consumers don't need to thread it
 * through their own interfaces.
 *
 * Two independent activity flags drive a "typing iff anything's happening"
 * rule:
 *   - `turnInFlight` — set on `turn_start`, cleared on `agent_end`. Spans
 *     the whole agent run (each LLM call inside a run keeps the indicator
 *     on between calls; only the final `agent_end` stops it).
 *   - `compactionInFlight` — set on `compaction_start`, cleared on
 *     `compaction_end`. Covers manual `!compact` (no surrounding agent
 *     run) and auto-compactions that happen mid-run.
 *
 * The indicator is on iff either flag is set; it transitions on each
 * event by re-evaluating that boolean. The two flags let manual
 * `!compact` (no surrounding agent run) keep the typing indicator
 * visible even though no `turn_start` fired.
 */
import type { Client, SendableChannels } from "discord.js";
import type { AgentSession } from "@mariozechner/pi-coding-agent";
import { fetchSendableChannel } from "./fetchSendableChannel.ts";

// Discord's typing indicator auto-fades ~10 seconds after the last
// `sendTyping` call. We re-pulse a few seconds inside that window so the
// indicator stays visible without unnecessary REST traffic — 7s gives a
// 3-second safety margin against jitter and clock drift.
const typingPulseIntervalMs = 7000;

export function installTypingIndicator(args: {
  client: Client;
  channelId: string;
  session: AgentSession;
}): void {
  const { client, channelId, session } = args;
  let typingTimer: Timer | null = null;
  let turnInFlight = false;
  let compactionInFlight = false;

  function getChannel(): Promise<SendableChannels | null> {
    return fetchSendableChannel(client, channelId);
  }

  async function startTyping(): Promise<void> {
    if (typingTimer) return;
    const channel = await getChannel();
    if (!channel) return;
    channel.sendTyping().catch((error) => console.error("[typing] sendTyping failed:", error));
    typingTimer = setInterval(() => {
      channel.sendTyping().catch((error) => console.error("[typing] sendTyping failed:", error));
    }, typingPulseIntervalMs);
  }

  function stopTyping(): void {
    if (!typingTimer) return;
    clearInterval(typingTimer);
    typingTimer = null;
  }

  function reconcile(): void {
    if (turnInFlight || compactionInFlight) {
      startTyping();
    } else {
      stopTyping();
    }
  }

  session.subscribe((event) => {
    switch (event.type) {
      case "turn_start":
        turnInFlight = true;
        reconcile();
        return;
      case "agent_end":
        turnInFlight = false;
        reconcile();
        return;
      case "compaction_start":
        compactionInFlight = true;
        reconcile();
        return;
      case "compaction_end":
        compactionInFlight = false;
        reconcile();
        return;
    }
  });
}
