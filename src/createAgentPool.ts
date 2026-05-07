/**
 * Per-channel AgentSession pool with streaming text delivery.
 *
 * One PoolEntry per active channel/thread; the pool lazily acquires entries
 * on first contact and evicts them on idle/cap pressure. Each entry
 * wires three I/O subsystems on top of a fresh agent session:
 *
 * - `DiscordSender` — the bot's outbound user-channel writes: streamed
 *   text dispatchers, file attachments via the `attach` tool, error
 *   surfacing.
 * - `DebugLogger` — operational logging in the debug channel; subscribes
 *   to `message_end` for usage tracking.
 * - `TypingIndicator` — the typing-dots UX, self-contained.
 *
 * Each subsystem owns a narrow slice; `withToolLogging` only sees the
 * `DebugLogger`, the attach tool only sees the `DiscordSender`. The
 * streaming-sender install (`installStreamingSender`) routes assistant
 * text deltas into the sender and surfaces errors that fall outside the
 * normal tool path.
 */
import { mkdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Client, Message } from "discord.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createBashToolDefinition,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import { config } from "./config.ts";
import { createDiscordSender, type DiscordSender } from "./io/createDiscordSender.ts";
import { createDebugLogger, type DebugLogger } from "./io/createDebugLogger.ts";
import { installTypingIndicator } from "./io/installTypingIndicator.ts";
import { createAttachTool } from "./tools/attach.ts";
import { createReactTool } from "./tools/react.ts";
import { createHistoryTool } from "./tools/history.ts";
import { createThreadTool } from "./tools/thread.ts";
import { createRestartSelfTool } from "./tools/restartSelf.ts";
import { collectImageAttachments } from "./collectImageAttachments.ts";
import { formatMessage } from "./formatMessage.ts";
import { buildPromptOptions } from "./agent/buildPromptOptions.ts";
import { harnessRules } from "./agent/prompts.ts";
import { withToolLogging } from "./agent/withToolLogging.ts";
import { installStreamingSender } from "./agent/installStreamingSender.ts";
import { installActiveTracker } from "./active/installActiveTracker.ts";
import type { ActiveTracker } from "./active/createActiveTracker.ts";

/**
 * Self-modification hint appended to the system prompt — only added when
 * running from source (i.e., not from a compiled binary). Tells the agent
 * where its own framework code lives and that `restart_self` will pick up
 * edits. `process.env.COMPILED` is baked into binaries by the build script
 * (`COMPILED=true bun build --env=COMPILED ...`); undefined in source mode.
 */
const sourceHint = process.env.COMPILED
  ? null
  : `# Framework source

You are running from source at \`${resolve(dirname(import.meta.path), "..")}\`. You can read/edit framework files via your bash/edit/write tools. Changes take effect after a full process restart — call \`restart_self\` to apply. Be conservative; small targeted edits only.`;

/**
 * Per-channel pool entry — closure-internal bookkeeping. Bundles the
 * session with the I/O handles needed to dispatch through it, plus the
 * `lastActive` timestamp for the eviction sweep. Never exported: every
 * subsystem (streaming-sender, active-tracker, etc.) takes only the
 * specific handles it uses, not the whole struct.
 */
interface PoolEntry {
  session: AgentSession;
  sender: DiscordSender;
  logger: DebugLogger;
  lastActive: number;
  /**
   * Discord message ID to thread-reply the FIRST streamed message of the
   * next agent run under. Updated on each `handle` call (real user
   * message); cleared on `wakeUp` (synthetic prompts have no thread
   * target). Read once per run by `installStreamingSender`.
   */
  replyTarget: string | undefined;
}

/**
 * Construct the full tool set for a channel's session: pi's reconstructed
 * built-in coding tools (bash/read/write/edit) plus the harness's Discord
 * tools (attach/react/history/thread/restart_self). Plain text replies
 * stream automatically — no envelope tool needed.
 *
 * Every tool is run through `withToolLogging` so each call gets a start-
 * line in the log channel and a follow-up failure-line (threaded as a
 * Discord reply) when the result `isError`.
 *
 * Each `withToolLogging` call is inlined rather than going through a
 * wrapping helper because pi's typed tool builders return concrete
 * `ToolDefinition<TObject<…>, …>` types, and TypeScript's variance rules
 * around `renderCall(args: Static<TParams>, …)` reject collapsing them
 * through a single `ToolDefinition<any>` waypoint. Inlining lets each
 * call pick its own generic instantiation.
 */
function buildTools(args: {
  client: Client;
  channelId: string;
  workspaceDir: string;
  sender: DiscordSender;
  logger: DebugLogger;
  tracker: ActiveTracker;
  wakeUp: (channelId: string, prompt: string) => Promise<void>;
}): ToolDefinition[] {
  const { client, channelId, workspaceDir, sender, logger, tracker, wakeUp } = args;
  return [
    withToolLogging(createBashToolDefinition(workspaceDir), logger),
    withToolLogging(createReadToolDefinition(workspaceDir), logger),
    withToolLogging(createWriteToolDefinition(workspaceDir), logger),
    withToolLogging(createEditToolDefinition(workspaceDir), logger),
    withToolLogging(createAttachTool({ sender }), logger),
    withToolLogging(createReactTool({ client, channelId }), logger),
    withToolLogging(createHistoryTool({ client, channelId }), logger),
    withToolLogging(createThreadTool({ client, channelId, wakeUp }), logger),
    withToolLogging(createRestartSelfTool({ client, channelId, tracker }), logger),
  ];
}

export interface AgentPool {
  handle(channelId: string, message: Message): Promise<void>;
  abort(channelId: string): void;
  clear(channelId: string): Promise<void>;
  /**
   * Inject a synthetic user-role prompt into the channel's session and run a
   * turn. Used by every "the agent didn't get here through a Discord message"
   * pathway: thread seed messages, restart/crash recovery harness notices,
   * post-`!clear` context resets, catchup nudges. Mechanically identical to
   * `handle` minus the discord.js Message → formatted-line step.
   */
  wakeUp(channelId: string, prompt: string): Promise<void>;
  /**
   * Trigger pi's context compaction on this channel's session. Returns
   * `true` if a new compaction started, `false` if skipped (no warm
   * session, or one is already in flight). Concurrent calls are skipped
   * because pi's `AgentSession.compact()` doesn't guard against re-entry
   * — see upstream issue badlogic/pi-mono#4203.
   */
  compact(channelId: string): boolean;
  /** True iff a pool entry exists for this channel — used to gate edit-as-steering on live conversations. */
  hasActive(channelId: string): boolean;
}

export function createAgentPool(args: {
  client: Client;
  tracker: ActiveTracker;
}): AgentPool {
  const { client, tracker } = args;
  const entries = new Map<string, PoolEntry>();
  // Track the last value we pushed to Discord presence so we only call
  // `setActivity` when the resolved model actually changes (re-setting the
  // same string would still hit Discord's gateway). Pi resolves the model
  // per session; in practice every session in our pool sees the same one,
  // so this updates exactly once on the first session unless the user
  // edits `settings.json` mid-run.
  let currentPresenceModel: string | null = null;

  setInterval(evict, 60_000);

  function evict(): void {
    // Age pass: drop entries idle past idleEvictMs.
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (entry.session.agent.state.isStreaming) continue;
      if (now - entry.lastActive > config.agent.idleEvictMs) {
        entries.delete(id);
      }
    }
    // Cap pass: trim oldest non-streaming if still over maxWarm.
    if (entries.size <= config.agent.maxWarm) return;
    const sorted = [...entries.entries()].sort(([, a], [, b]) => a.lastActive - b.lastActive);
    for (const [id, entry] of sorted) {
      if (entries.size <= config.agent.maxWarm) break;
      if (entry.session.agent.state.isStreaming) continue;
      entries.delete(id);
    }
  }

  function sessionPathFor(channelId: string): string {
    return resolve(config.agentDir, "sessions", `${channelId}.jsonl`);
  }

  /**
   * Reflect the resolved provider+model in the bot's Discord presence so
   * it's visible in the member list at a glance. Skips redundant writes
   * to avoid pinging the gateway when the model hasn't changed.
   */
  function updateBotPresence(session: AgentSession): void {
    const model = session.model;
    if (!model) return;
    const text = `${model.provider}/${model.id}`;
    if (text === currentPresenceModel) return;
    currentPresenceModel = text;
    client.user?.setActivity(text);
  }

  async function acquirePoolEntry(channelId: string): Promise<PoolEntry> {
    const cached = entries.get(channelId);
    if (cached) return cached;

    const sessionPath = sessionPathFor(channelId);
    const workspaceDir = resolve(config.agentDir, "workspaces", channelId);
    await mkdir(workspaceDir, { recursive: true });

    const sender = createDiscordSender({ client, channelId });
    // Logger is constructed BEFORE the session because tools (built next)
    // need to capture it via `withToolLogging`. Everything the logger
    // needs *post*-session is deferred via callbacks — the logger captures
    // `subscribe` and `getContextUsage` closures, and we attach the
    // session once it exists.
    let sessionRef: AgentSession | null = null;
    let attachLoggerToSession: (session: AgentSession) => void = () => {};
    const logger = createDebugLogger({
      client,
      channelId,
      subscribe: (handler) => {
        attachLoggerToSession = (session) => session.subscribe(handler);
      },
      getContextUsage: () => sessionRef?.getContextUsage() ?? null,
    });
    const sessionManager = SessionManager.open(sessionPath, undefined, workspaceDir);

    // Pi's services helper builds AuthStorage, ModelRegistry,
    // SettingsManager, and a fully-loaded DefaultResourceLoader from
    // agentDir — same pattern its own CLI uses. The DefaultResourceLoader
    // auto-discovers SYSTEM.md and AGENTS.md, but skills require an
    // explicit path; passing `additionalSkillPaths` makes
    // `<agentDir>/skills/` auto-load without the user needing settings.json.
    // We inject harnessRules + sourceHint as the append-system-prompt so
    // the harness layer always lands at the end regardless of what the
    // user's SYSTEM.md says.
    const services = await createAgentSessionServices({
      cwd: workspaceDir,
      agentDir: config.agentDir,
      resourceLoaderOptions: {
        additionalSkillPaths: [resolve(config.agentDir, "skills")],
        appendSystemPrompt: sourceHint ? [harnessRules, sourceHint] : [harnessRules],
      },
    });

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      // Disable pi's auto-registered defaults so we can wrap every tool
      // (custom + builtin) with `withToolLogging` for uniform start/failure
      // logging in the debug channel. The defaults are reconstructed via
      // pi's exported factories below, using this channel's workspace as cwd.
      noTools: "builtin",
      customTools: buildTools({ client, channelId, workspaceDir, sender, logger, tracker, wakeUp }),
    });

    // Wire the deferred bindings now that the session exists.
    sessionRef = session;
    attachLoggerToSession(session);
    installTypingIndicator({ client, channelId, session });
    updateBotPresence(session);

    const entry: PoolEntry = {
      session,
      sender,
      logger,
      lastActive: Date.now(),
      replyTarget: undefined,
    };

    installStreamingSender({
      session,
      sender,
      getReplyTarget: () => entry.replyTarget,
    });
    installActiveTracker({ channelId, session, tracker });

    entries.set(channelId, entry);
    evict();
    return entry;
  }

  async function handle(channelId: string, message: Message): Promise<void> {
    const entry = await acquirePoolEntry(channelId);
    entry.lastActive = Date.now();
    // Point subsequent debug-channel log entries at this message — the
    // logger uses it as the link target so each tool entry is clickable
    // back to the user message that triggered the run.
    entry.logger.setSourceMessageUrl(message.url);
    // Thread the FIRST streamed message of the upcoming run under this
    // user message. installStreamingSender reads this once per run.
    entry.replyTarget = message.id;

    tracker.markPending(channelId);

    const images = await collectImageAttachments(message);
    const promptOptions = buildPromptOptions({
      images,
      isStreaming: entry.session.agent.state.isStreaming,
    });
    // Format wake/steer prompts the same way the `history` tool formats
    // its lines, so the agent always sees the source metadata — including
    // the message_id (for `react` / `send`'s in_reply_to) and edited_at
    // (set on edit-as-steering events). `client.user` is populated by the
    // time the pool handles messages — login completes before the router
    // wires up — so a missing `client.user` here is a bug worth crashing on.
    if (!client.user) throw new Error("client.user not set — login did not complete");
    const formattedPrompt = formatMessage(message, client.user.id);

    if (entry.session.agent.state.isStreaming) {
      // Steering: a turn is in flight → inject this as a steer. Ack with
      // 👀 immediately so the user knows the harness received their
      // interrupting message (the agent might still be deep in tool calls
      // and won't visibly respond for a while).
      message.react("👀").catch((error) =>
        console.error("[pool] steer ack reaction failed:", error),
      );
      await entry.session
        .prompt(formattedPrompt, promptOptions)
        .catch((error) => console.error("[pool] steer prompt failed:", error));
      return;
    }

    try {
      await entry.session.prompt(formattedPrompt, promptOptions);
    } catch (error) {
      await entry.sender.sendError(error);
    }
  }

  function abort(channelId: string): void {
    entries.get(channelId)?.session.abort();
  }

  function compact(channelId: string): boolean {
    // No-op when the channel has no warm session — there's nothing to
    // compact, and acquiring an entry just to compact it would be
    // pointless.
    const entry = entries.get(channelId);
    if (!entry) return false;
    // Concurrent compactions on the same session orphan pi's
    // `_compactionAbortController` and run two LLM summaries in parallel
    // (badlogic/pi-mono#4203). Skip if one is already in flight.
    if (entry.session.isCompacting) return false;
    // Pi can still throw "Already compacted" if the last session entry
    // is already a compaction — fire-and-forget but catch to avoid an
    // unhandled rejection.
    entry.session.compact().catch((error) => {
      console.error(`[pool] compact ${channelId} failed:`, error);
    });
    return true;
  }

  async function wakeUp(channelId: string, prompt: string): Promise<void> {
    const entry = await acquirePoolEntry(channelId);
    entry.lastActive = Date.now();
    // Synthetic wake — no real Discord message to thread under.
    entry.replyTarget = undefined;
    try {
      await entry.session.prompt(prompt);
    } catch (error) {
      await entry.sender.sendError(error);
    }
  }

  async function clear(channelId: string): Promise<void> {
    abort(channelId);
    entries.delete(channelId);
    tracker.clearChannel(channelId);
    const sessionPath = sessionPathFor(channelId);
    await rm(sessionPath, { force: true }).catch((error) =>
      console.error(`[pool] failed to remove ${sessionPath}:`, error),
    );
  }

  function hasActive(channelId: string): boolean {
    return entries.has(channelId);
  }

  return {
    handle,
    abort,
    clear,
    wakeUp,
    compact,
    hasActive,
  };
}
