/**
 * Debug-channel logging — operational lines cross-posted to a separate
 * Discord channel for monitoring and post-mortems. Per-channel concerns
 * only: tool starts, tool failures, per-call usage suffix
 * (`6.8k/128k → 340 · $0.0012`), and context-compaction events. Process-
 * level lifecycle events (startup, shutdown) go through `postDebugLine`
 * instead — see `src/io/postDebugLine.ts`.
 *
 * Pure subscriber. The caller hands us a `subscribe` callback that we
 * use to listen on `tool_execution_start` / `tool_execution_end` /
 * `message_end` / `compaction_start` / `compaction_end`. We post the
 * appropriate line for each. This covers ALL tools the session executes
 * — built-in, harness customs, and extension-registered (e.g.
 * `remember`) — uniformly, without per-tool wrapping. Failures thread
 * as Discord replies to their start line via a `toolCallId`-keyed map
 * holding the start-log message ID promise.
 *
 * Why the caller passes a `subscribe` function (instead of a session
 * directly): the logger is constructed before the session exists — pi
 * resolves model + extensions during `createAgentSession`, but we want
 * a single shared `DebugLogger` instance the pool can refer to from
 * the moment the channel is acquired. Threading a `subscribe` callback
 * lets the pool wire it to `session.subscribe(...)` once the session
 * is built.
 *
 * Why a separate module from `DiscordSender`:
 * - Different *target channel* (`config.debugChannelId`, may be unset).
 * - Different *failure model* — silently no-ops when no debug channel is
 *   configured, whereas `DiscordSender` always has a channel.
 *
 * Source-message linking: every tool log line is rendered as a markdown
 * link to either the user's wake message (set via `setSourceMessageUrl`
 * by the pool when handling a `messageCreate`) or the harness-injected
 * synthetic prompts (wakeUp paths, where there's no real source — we
 * fall back to a link to the channel itself so the entry stays
 * clickable).
 */
import type { Client, SendableChannels } from "discord.js";
import type { AgentEvent } from "@earendil-works/pi-agent-core";
import type { AgentSessionEvent } from "@earendil-works/pi-coding-agent";
import { config } from "../config.ts";
import { extractToolErrorText } from "./extractToolErrorText.ts";
import { fetchSendableChannel } from "./fetchSendableChannel.ts";
import { sendDebugMessage } from "./sendDebugMessage.ts";
import { formatCost } from "./formatCost.ts";
import { formatTokenLine } from "./formatTokenLine.ts";
import { formatToolArgs } from "./formatToolArgs.ts";
import { formatToolUsage } from "./formatToolUsage.ts";
import { isAssistantMessageEnd, type AssistantMessageEnd } from "./isAssistantMessageEnd.ts";
import type { CallUsageDisplay } from "./CallUsageDisplay.ts";
import { formatTokens } from "./formatTokens.ts";
import { truncate } from "./truncate.ts";
import { sanitizeBackticks } from "./sanitizeBackticks.ts";

const hardCharLimit = 1990;
/** Summary preview length on the post-compaction log line. Anything longer is truncated with an ellipsis. */
const compactionSummaryPreviewLimit = 120;

export interface DebugLogger {
  /** Set the source-message URL for the *current* run — every subsequent tool start log will link to it until the next `setSourceMessageUrl` call. */
  setSourceMessageUrl(url: string): void;
}

type SessionEventHandler = (event: AgentSessionEvent | AgentEvent) => void;

export function createDebugLogger(args: {
  client: Client;
  channelId: string;
  /** Caller-supplied subscription. Invoked once during construction with the logger's internal handler; the caller wires it to `session.subscribe(…)` once the session exists. */
  subscribe: (handler: SessionEventHandler) => void;
  /**
   * Caller-supplied accessor for the session's current context usage.
   * Returns `tokens` (null right after compaction, before the next LLM
   * response — per pi's docs) and `contextWindow` (the active model's
   * cap, used to render `total/cap` lines so context creep is visible at
   * a glance). The whole accessor is lazy so the logger doesn't need the
   * session to exist at construction time — pi resolves the model only
   * after `createAgentSession` runs.
   */
  getContextUsage: () => { tokens: number | null; contextWindow: number } | null;
}): DebugLogger {
  const { client, channelId, subscribe, getContextUsage } = args;
  let sourceMessageUrl: string | null = null;
  // Per-LLM-call usage display, keyed by the first tool call's id (sibling
  // tool calls in a batch share the cost — showing the cost on each would
  // double-count visually).
  const toolToUsage = new Map<string, CallUsageDisplay>();

  function getDebugChannel(): Promise<SendableChannels | null> {
    if (!config.debugChannelId) return Promise.resolve(null);
    return fetchSendableChannel(client, config.debugChannelId);
  }

  // Lazy-cached channel link for fallback when there's no source message
  // to point at (e.g. wakeUp turns). Resolved once per DebugLogger and reused.
  let channelLinkPromise: Promise<string | null> | null = null;
  function getChannelLink(): Promise<string | null> {
    if (channelLinkPromise) return channelLinkPromise;
    channelLinkPromise = client.channels
      .fetch(channelId)
      .then((channel) => {
        if (!channel || channel.isDMBased()) return null;
        if (!("guildId" in channel) || !channel.guildId) return null;
        return `https://discord.com/channels/${channel.guildId}/${channelId}`;
      })
      .catch((error) => {
        console.error(`[debugLogger] channel link fetch failed for ${channelId}:`, error);
        return null;
      });
    return channelLinkPromise;
  }

  function recordCallUsage(message: AssistantMessageEnd): void {
    if (!message.usage) return;
    const firstToolCall = message.content?.find((part) => part.type === "toolCall");
    if (!firstToolCall?.id) return;
    const tokensStr = formatTokenLine(message.usage, getContextUsage()?.contextWindow);
    const costStr = message.usage.cost.total > 0 ? formatCost(message.usage.cost.total) : null;
    toolToUsage.set(firstToolCall.id, { tokensStr, costStr });
  }

  // Tracks the in-flight compaction's start-log message ID (as a Promise
  // so the end-log can thread as a Discord reply even if its event fires
  // before the start-log's send resolves). Single slot — compactions are
  // sequential by nature, so a Map would be overkill. Cleared on
  // compaction_end.
  let pendingCompactionStartLog: Promise<string | null> | null = null;

  // Per-tool-call start-log message IDs (as Promises so a fast-finishing
  // tool's end event can thread its failure even if the start-log send
  // is still in flight). Keyed by `toolCallId`, which pi assigns once
  // per tool invocation and echoes on both `tool_execution_start` and
  // `tool_execution_end`. Cleared on the matching end event so the map
  // doesn't accumulate over a long session.
  const pendingToolStartLogs = new Map<string, Promise<string | null>>();

  // Wire the subscription via the caller-supplied callback. We dispatch
  // on five event types:
  //   - `message_end`           → usage tracking (the per-call cost suffix)
  //   - `tool_execution_start`  → "starting tool X with args Y" line
  //   - `tool_execution_end`    → failure follow-up if isError
  //   - `compaction_start`/`compaction_end` → compaction lifecycle pair
  // Every other event falls through to a no-op. Doing tool logging here
  // (instead of wrapping each `ToolDefinition` at the call site) covers
  // ALL tools the session executes — built-in, harness customs, AND
  // extension-registered (e.g. memory's `remember`) — without per-tool
  // wrapping at construction time.
  subscribe((event) => {
    if (event.type === "message_end" && isAssistantMessageEnd(event.message)) {
      recordCallUsage(event.message);
      return;
    }
    if (event.type === "tool_execution_start") {
      pendingToolStartLogs.set(
        event.toolCallId,
        postToolStart({ toolCallId: event.toolCallId, toolName: event.toolName, args: event.args }),
      );
      return;
    }
    if (event.type === "tool_execution_end") {
      const startLog = pendingToolStartLogs.get(event.toolCallId);
      pendingToolStartLogs.delete(event.toolCallId);
      if (event.isError) postToolFailure({ startLog, toolName: event.toolName, result: event.result });
      return;
    }
    if (event.type === "compaction_start") {
      pendingCompactionStartLog = postCompactionStart(event.reason);
      return;
    }
    if (event.type === "compaction_end") {
      const startLog = pendingCompactionStartLog;
      pendingCompactionStartLog = null;
      postCompactionEnd(event, startLog);
      return;
    }
    // Surface model-turn errors (auth failures, provider 5xx, malformed
    // responses) into the debug channel. The channel-facing `sendError`
    // is a single terse line in the *user* channel; without a copy here,
    // operators monitoring debug have no signal that anything went wrong.
    if (event.type === "turn_end" && isAssistantMessageEnd(event.message)) {
      const msg = event.message as {
        stopReason?: string;
        errorMessage?: string;
        provider?: string;
        model?: string;
      };
      if (msg.stopReason === "error" && msg.errorMessage) {
        postTurnError({
          errorMessage: msg.errorMessage,
          provider: msg.provider,
          model: msg.model,
        }).catch((error) => console.error("[debugLogger] turn-error post failed:", error));
      }
    }
  });

  async function postTurnError(args: {
    errorMessage: string;
    provider?: string;
    model?: string;
  }): Promise<void> {
    const channel = await getDebugChannel();
    if (!channel) return;
    const link = sourceMessageUrl ?? (await getChannelLink());
    const head = link ? `[agent error](<${link}>)` : "agent error";
    const modelTag =
      args.provider || args.model ? ` · ${args.provider ?? "?"}/${args.model ?? "?"}` : "";
    const text = `-# ⚠️ ${head}${modelTag}: ${sanitizeBackticks(args.errorMessage)}`.slice(
      0,
      hardCharLimit,
    );
    await sendDebugMessage({
      channel,
      content: text,
      errorContext: "turn-error post failed",
    });
  }

  async function postCompactionStart(reason: string): Promise<string | null> {
    const channel = await getDebugChannel();
    if (!channel) return null;
    const link = sourceMessageUrl ?? (await getChannelLink());
    const head = link ? `[compacting](<${link}>)` : "compacting";
    const tokens = getContextUsage()?.tokens ?? null;
    const tokensSegment = tokens !== null ? ` · ${formatTokens(tokens)}` : "";
    const text = `-# 🗜️ ${head} context${tokensSegment} · trigger=${reason}`.slice(0, hardCharLimit);
    const sent = await sendDebugMessage({
      channel,
      content: text,
      errorContext: "compaction-start post failed",
    });
    return sent?.id ?? null;
  }

  async function postCompactionEnd(
    event: {
      reason: string;
      result?: { tokensBefore?: number; summary?: string };
      aborted: boolean;
      willRetry: boolean;
      errorMessage?: string;
    },
    startLog: Promise<string | null> | null,
  ): Promise<void> {
    const channel = await getDebugChannel();
    if (!channel) return;
    let text: string;
    if (event.aborted) {
      const reason = event.errorMessage ? `: ${event.errorMessage}` : "";
      const retry = event.willRetry ? " (will retry)" : "";
      text = `-# 🗜️ compaction aborted${reason}${retry}`.slice(0, hardCharLimit);
    } else {
      const tokensBefore = event.result?.tokensBefore;
      const tokensAfter = getContextUsage()?.tokens ?? null;
      // Three formats depending on what's available:
      //   • before → after  — both known (pi's contextUsage updated already)
      //   • was before      — after is null (pi flags it as unknown right
      //                       after compaction, before the next LLM call)
      //   • (no transition) — pi gave us nothing useful
      let transition = "";
      if (typeof tokensBefore === "number" && tokensAfter !== null) {
        transition = ` · ${formatTokens(tokensBefore)} → ${formatTokens(tokensAfter)}`;
      } else if (typeof tokensBefore === "number") {
        transition = ` · was ${formatTokens(tokensBefore)}`;
      }
      const summary = event.result?.summary ?? "";
      const summaryPreview = summary.length > 0
        ? ` · "${truncate(sanitizeBackticks(summary).replace(/\n/g, " "), compactionSummaryPreviewLimit)}"`
        : "";
      text = `-# 🗜️ compacted${transition}${summaryPreview}`.slice(0, hardCharLimit);
    }
    // Await the start-log promise so we get the resolved message ID
    // even if its send was still in flight when this fired.
    const replyTo = startLog ? await startLog : null;
    await sendDebugMessage({
      channel,
      content: text,
      replyTo: replyTo ?? undefined,
      errorContext: "compaction-end post failed",
    });
  }

  async function postToolStart(args: {
    toolCallId: string;
    toolName: string;
    args: unknown;
  }): Promise<string | null> {
    const channel = await getDebugChannel();
    if (!channel) return null;
    // Prefer linking the specific source message; fall back to the channel
    // itself for synthetic-prompt turns (wakeUp paths) where there's no
    // user-message URL — that way every tool entry in the log is still
    // clickable to the room where the action happened.
    const link = sourceMessageUrl ?? (await getChannelLink());
    const head = link ? `[${args.toolName}](<${link}>)` : args.toolName;
    const argString = formatToolArgs(args.args);
    const usageString = formatToolUsage(args.toolCallId, toolToUsage);
    const text = `-# ${head} ${argString}${usageString}`.slice(0, hardCharLimit);
    const sent = await sendDebugMessage({
      channel,
      content: text,
      errorContext: "tool-start post failed",
    });
    return sent?.id ?? null;
  }

  async function postToolFailure(args: {
    /** Promise of the start-log message ID, used as the reply target so the failure threads as a Discord reply to its corresponding start line. May resolve to null if the start-log send failed or no debug channel was configured. */
    startLog: Promise<string | null> | undefined;
    toolName: string;
    result: unknown;
  }): Promise<void> {
    const channel = await getDebugChannel();
    if (!channel) return;
    const errorText = extractToolErrorText(args.result);
    const text = `-# ❌ ${args.toolName} failed: ${errorText}`.slice(0, hardCharLimit);
    // Await the start-log promise so we get the resolved message ID
    // even if its send was still in flight when this fired.
    const replyTo = args.startLog ? await args.startLog : null;
    await sendDebugMessage({
      channel,
      content: text,
      replyTo: replyTo ?? undefined,
      errorContext: "tool failure post failed",
    });
  }

  return {
    setSourceMessageUrl(url: string): void {
      sourceMessageUrl = url;
    },
  };
}
