/**
 * Per-channel AgentSession pool with streaming text delivery.
 *
 * One PoolEntry per active channel/thread; the pool lazily acquires entries
 * on first contact and evicts them on idle/cap pressure. Each entry
 * wires three I/O subsystems on top of a fresh agent session:
 *
 * - `DiscordSender` — the bot's outbound user-channel writes: streamed
 *   text dispatchers, file attachments via the `attach` tool, finished
 *   `send_message` payloads, error surfacing.
 * - `DebugLogger` — operational logging in the debug channel; pure
 *   subscriber to session events (`tool_execution_start/end`,
 *   `message_end`, `compaction_start/end`). Posts start, failure,
 *   usage, and compaction lines without the call sites needing to know,
 *   which means extension-registered tools (e.g. memory's `remember`)
 *   are logged uniformly with built-ins and harness customs.
 * - `TypingIndicator` — the typing-dots UX, self-contained.
 *
 * Each subsystem owns a narrow slice; the attach tool only sees the
 * `DiscordSender`, the debug logger only sees session events. The
 * streaming-sender install (`installStreamingSender`) routes assistant
 * text deltas into the sender and surfaces errors that fall outside the
 * normal tool path.
 *
 * `CHAT_MODE` decides which delivery path exists (see `agent/chatMode.ts`):
 *
 * - `stream` — assistant text deltas stream into Discord; the reply IS the text.
 * - `tools` — assistant text is not delivered at all; `send_message` posts the
 *   reply, `think` holds the reasoning, and the same typing effect comes from
 *   previewing the `send_message` argument stream
 *   (`createSendMessageDelivery`). Provider reasoning is switched off so `think`
 *   is the only reasoning outlet — thinking tokens and a reasoning tool would
 *   otherwise be two competing channels for the same job.
 */
import { mkdir } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type { Client, Message } from "discord.js";
import {
  createAgentSessionFromServices,
  createAgentSessionServices,
  createEditToolDefinition,
  createReadToolDefinition,
  createWriteToolDefinition,
  SessionManager,
  type AgentSession,
  type ToolDefinition,
} from "@earendil-works/pi-coding-agent";
import { config } from "./config.ts";
import { createDiscordSender, type DiscordSender } from "./io/createDiscordSender.ts";
import { createDebugLogger, type DebugLogger } from "./io/createDebugLogger.ts";
import { installTypingIndicator } from "./io/installTypingIndicator.ts";
import { createAttachTool } from "./tools/attach.ts";
import { createReactTool } from "./tools/react.ts";
import { createHistoryTool } from "./tools/history.ts";
import { createThreadTool } from "./tools/thread.ts";
import { createRestartSelfTool } from "./tools/restartSelf.ts";
import { createSendMessageTool } from "./tools/sendMessage.ts";
import { createEditMessageTool } from "./tools/editMessage.ts";
import { createThinkTool } from "./tools/think.ts";
import { collectImageAttachments } from "./collectImageAttachments.ts";
import { formatMessage } from "./formatMessage.ts";
import { buildPromptOptions } from "./agent/buildPromptOptions.ts";
import { withDeliveryHint } from "./agent/deliveryHint.ts";
import { buildHarnessRules } from "./agent/prompts.ts";
import { installStreamingSender } from "./agent/installStreamingSender.ts";
import { createSendMessageDelivery } from "./agent/createSendMessageDelivery.ts";
import type { ChatDelivery } from "./agent/chatDelivery.ts";
import { createJobs, type Jobs } from "./agent/jobs.ts";
import { createJobTools } from "./tools/job.ts";
import { createBackgroundableBashTool } from "./tools/bash.ts";
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
 * Tool-call logging happens in `DebugLogger` via session-event subscription,
 * so this function doesn't need per-tool wrapping.
 *
 * The array is widened to `ToolDefinition[]` (the default-typed bare form)
 * via a single cast at the end. Pi's typed builders return concrete
 * `ToolDefinition<TObject<…>, …>` types, and TypeScript's variance rules
 * around `renderCall(args: Static<TParams>, …)` reject collapsing them
 * through a single `ToolDefinition<TSchema, unknown, any>` waypoint.
 * One widening cast at the array level is the cheapest expression of
 * "we know these all satisfy pi's customTools contract" — pi itself
 * accepts this shape.
 */
function buildTools(args: {
  client: Client;
  channelId: string;
  workspaceDir: string;
  sender: DiscordSender;
  tracker: ActiveTracker;
  wakeUp: (channelId: string, prompt: string) => Promise<void>;
  /**
   * Present only in `CHAT_MODE=tools`: the hand-off `send_message` claims its
   * already-streamed reply from.
   */
  chatDelivery: ChatDelivery | null;
  jobs: Jobs;
}): ToolDefinition[] {
  const { client, channelId, workspaceDir, sender, tracker, wakeUp, chatDelivery, jobs } = args;
  return [
    // pi's bash, wrapped so a long command hands itself to the job runner
    // instead of holding the turn (and the channel) hostage.
    createBackgroundableBashTool({
      workspaceDir,
      jobs,
      ceilingSeconds: config.bashCeilingSecs,
    }),
    ...createJobTools({ jobs, workspaceDir }),
    createReadToolDefinition(workspaceDir),
    createWriteToolDefinition(workspaceDir),
    createEditToolDefinition(workspaceDir),
    createAttachTool({ sender, mode: config.chatMode }),
    createReactTool({ client, channelId, mode: config.chatMode }),
    createHistoryTool({ client, channelId }),
    createThreadTool({ client, channelId, wakeUp }),
    createRestartSelfTool({ client, channelId, tracker }),
    // The reply path in `tools` mode — there is no equivalent in `stream` mode,
    // where assistant text is the reply.
    ...(chatDelivery
      ? [
          createSendMessageTool({ sender, delivery: chatDelivery }),
          createEditMessageTool({ client, channelId, sender }),
          createThinkTool({ channelId }),
        ]
      : []),
  ] as unknown as ToolDefinition[];
}

/**
 * Assert this mode's thinking level on every session acquisition.
 *
 * `tools` mode turns provider reasoning **off** (`session.setThinkingLevel`
 * clamps to what the model supports): the whole point of the mode is that the
 * `think` tool is the single, inspectable reasoning outlet. Leaving reasoning on
 * gives two competing outlets — invisible thinking tokens *and* `think` — and the
 * model splits the same job between them.
 *
 * `CHAT_THINKING_LEVEL` overrides both modes. It exists because reasoning-off is
 * not universally available: some endpoints reject it outright
 * ("Reasoning is mandatory for this endpoint and cannot be disabled"), and that
 * has to be fixable with an env change rather than a code change.
 *
 * `stream` mode asserts the configured default explicitly instead of relying on
 * the session file. pi persists a `thinking_level_change` entry, so a session
 * last used in `tools` mode would otherwise come back with reasoning off and
 * silently lose its reasoning in stream mode too — a mode switch has to be
 * symmetric, not a one-way trip.
 *
 * `setThinkingLevel` only writes a session entry when the level actually changes,
 * so the steady state costs nothing.
 */
function applyChatModeThinkingLevel(
  session: AgentSession,
  settingsDefault: Parameters<AgentSession["setThinkingLevel"]>[0] | undefined,
): void {
  if (config.chatThinkingLevel) {
    session.setThinkingLevel(config.chatThinkingLevel);
    return;
  }
  // Both modes: the configured default. `tools` mode used to force `off`; an A/B
  // showed that cost replies (see `agent/chatMode.ts`), so the mode no longer
  // has an opinion about reasoning depth.
  if (settingsDefault) session.setThinkingLevel(settingsDefault);
}

export interface AgentPool {
  /**
   * Receive a real Discord user message: format it, route to the channel's
   * session, run a turn. Streaming output is wired into the entry's sender;
   * tool calls land on the LLM normally.
   */
  handle(channelId: string, message: Message): Promise<void>;
  /**
   * Inject a synthetic user-role prompt into the channel's session and run a
   * turn. Used by every "the agent didn't get here through a Discord message"
   * pathway: thread seed messages, restart/crash recovery harness notices,
   * post-`!clear` context resets, catchup nudges. Mechanically identical to
   * `handle` minus the discord.js Message → formatted-line step.
   */
  wakeUp(channelId: string, prompt: string): Promise<void>;
  /** True iff a pool entry exists for this channel — used to gate edit-as-steering on live conversations. */
  hasActive(channelId: string): boolean;
  /**
   * Return the warm `AgentSession` for this channel, or `undefined` if none.
   * Exposed so command handlers (`!stop`, `!compact`) can act on the session
   * directly without wrapping each operation in a pool method. The pool
   * itself doesn't expose abort/compact — those are caller-orchestrated.
   */
  session(channelId: string): AgentSession | undefined;
  /**
   * Remove the warm entry for this channel from the in-memory pool. Used by
   * `!clear` after archiving the on-disk session, so the next message
   * acquires a fresh entry. Does not touch the on-disk session file — that's
   * the caller's job (`archiveSession` or equivalent).
   */
  dropEntry(channelId: string): void;
}

/**
 * Absolute path to the session JSONL for a given Discord channel/thread.
 * Exported so callers outside the pool (e.g. `!clear` archive logic) can
 * compute the path without reaching into pool internals.
 */
export function sessionPathFor(channelId: string): string {
  return resolve(config.agentDir, "sessions", `${channelId}.jsonl`);
}

/**
 * Whether the session counts as busy — a run is starting, running, or in
 * post-run continuation. Wraps `AgentSession.isStreaming`, deliberately:
 * gating on `session.agent.state.isStreaming` instead leaves a window where a
 * user message misroutes.
 *
 * pi has two busy flags and they flip at different points. The session's own
 * flag (`_isAgentRunActive`, exposed as `isStreaming`) is set on the first line
 * of pi's run-start sequence, which then awaits the compaction check and the
 * `before_agent_start` handlers. `agent.state.isStreaming` only becomes true
 * inside the later `agent.prompt()` call. So a message arriving in between
 * finds the agent flag false — we would conclude nothing is in flight and
 * submit a plain prompt into a run that is already starting, which pi rejects
 * with "Agent is already processing. Specify streamingBehavior …". The user's
 * message is then lost, surfacing as a channel error instead of being steered.
 *
 * pi widened that window in 1.2.0 (session counts as busy while a run starts);
 * before that the two flags flipped one statement apart and the race was
 * effectively unreachable. The session flag has no such window.
 */
function isSessionBusy(session: AgentSession): boolean {
  return session.isStreaming;
}

/**
 * Resolve immediately if the session isn't compacting; otherwise wait for
 * the next `compaction_end` event. Pi's auto-compaction runs inline in
 * `_processAgentEvent`'s `agent_end` handler before `finishRun()` resolves,
 * so the session's internal `activeRun` is still set during the
 * summarization window. Calling `prompt(...)` then throws
 * "Agent is already processing", which used to surface as a channel-
 * visible error if the user typed during compaction (#26). Gating
 * `prompt(...)` on this helper closes the race.
 */
function whenNotCompacting(session: AgentSession): Promise<void> {
  if (!session.isCompacting) return Promise.resolve();
  return new Promise((resolve) => {
    const unsubscribe = session.subscribe((event) => {
      if (event.type === "compaction_end") {
        unsubscribe();
        resolve();
      }
    });
  });
}

export function createAgentPool(args: {
  client: Client;
  tracker: ActiveTracker;
}): AgentPool {
  const { client, tracker } = args;
  const entries = new Map<string, PoolEntry>();
  // One job registry for the whole process: jobs are not per-channel, and a job
  // started while answering in one channel must be pollable from another.
  const jobs = createJobs({ rootDir: resolve(config.agentDir, "jobs") });
  // Track the last value we pushed to Discord presence so we only call
  // `setActivity` when the resolved model actually changes (re-setting the
  // same string would still hit Discord's gateway). Pi resolves the model
  // per session; in practice every session in our pool sees the same one,
  // so this updates exactly once on the first session unless the user
  // edits `settings.json` mid-run.
  let currentPresenceText: string | null = null;

  setInterval(evict, 60_000);

  function evict(): void {
    // Age pass: drop entries idle past idleEvictMs.
    const now = Date.now();
    for (const [id, entry] of entries) {
      if (isSessionBusy(entry.session)) continue;
      if (now - entry.lastActive > config.agent.idleEvictMs) {
        entries.delete(id);
      }
    }
    // Cap pass: trim oldest non-busy if still over maxWarm.
    if (entries.size <= config.agent.maxWarm) return;
    const sorted = [...entries.entries()].sort(([, a], [, b]) => a.lastActive - b.lastActive);
    for (const [id, entry] of sorted) {
      if (entries.size <= config.agent.maxWarm) break;
      if (isSessionBusy(entry.session)) continue;
      entries.delete(id);
    }
  }

  /**
   * Reflect the resolved model in the bot's Discord presence so it's visible
   * in the member list at a glance. Shows the model name only (no provider
   * prefix). Skips redundant writes to avoid pinging the gateway when the
   * model hasn't changed.
   */
  function updateBotPresence(session: AgentSession): void {
    const model = session.model;
    if (!model) return;
    // Just the model name — drop the provider prefix ("deepseek/foo" → "foo").
    // Discord truncates long activity strings anyway, and the provider is
    // noise in the member list.
    const text = model.id.split("/").pop() || model.id;
    if (text === currentPresenceText) return;
    currentPresenceText = text;
    client.user?.setActivity(text);
  }

  async function acquirePoolEntry(channelId: string): Promise<PoolEntry> {
    const cached = entries.get(channelId);
    if (cached) return cached;

    const sessionPath = sessionPathFor(channelId);
    const workspaceDir = resolve(config.agentDir, "workspaces", channelId);
    await mkdir(workspaceDir, { recursive: true });

    const sender = createDiscordSender({ client, channelId });
    // Logger is constructed BEFORE the session because we want a single
    // shared `DebugLogger` reference the pool entry can hold even if
    // session creation fails. Post-session bindings (`subscribe`,
    // `getContextUsage`) are deferred via closures so the logger doesn't
    // need the session at construction time.
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
    // Tools-mode reply path. Constructed before the session (the tool array is
    // an argument to session creation) and wired to it afterwards — the same
    // deferred-subscription shape the debug logger uses.
    let attachDeliveryToSession: (session: AgentSession) => void = () => {};
    const chatDelivery =
      config.chatMode === "tools"
        ? createSendMessageDelivery({
            sender,
            getReplyTarget: () => entries.get(channelId)?.replyTarget,
            subscribe: (handler) => {
              attachDeliveryToSession = (session) => session.subscribe(handler);
            },
          })
        : null;
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
    const harnessRules = buildHarnessRules(config.chatMode);
    const services = await createAgentSessionServices({
      cwd: workspaceDir,
      agentDir: config.agentDir,
      resourceLoaderOptions: {
        additionalSkillPaths: [resolve(config.agentDir, "skills")],
        appendSystemPrompt: sourceHint
        ? [harnessRules, sourceHint]
        : [harnessRules],
      },
    });

    // Sessions persist their model across restarts: pi restores the last
    // model_change from the session file on resume, so editing
    // `settings.json` defaultModel wouldn't take effect for existing
    // sessions. Passing the default explicitly at creation fixes that —
    // sdk.js only restores when options.model is unset, so the settings
    // default always wins here.
    const defaultProvider = services.settingsManager.getDefaultProvider();
    const defaultModel = services.settingsManager.getDefaultModel();
    // The settings store provider and model id separately; the model registry
    // keys models the same way (provider + id, e.g. openrouter + deepseek/…).
    // Join via registry.find — the string form is provider/modelId here but
    // defaultModel alone omits the provider, so a string-compare find wouldn't
    // match.
    const sessionModel =
      defaultProvider && defaultModel
        ? services.modelRuntime?.getModel(defaultProvider, defaultModel) ?? undefined
        : undefined;

    const { session } = await createAgentSessionFromServices({
      services,
      sessionManager,
      model: sessionModel,
      // Disable pi's auto-registered defaults so the harness reconstructs
      // each built-in tool with this channel's workspace as cwd. Tool-call
      // logging happens via session-event subscription in `DebugLogger`,
      // not per-tool wrapping — so the customTools list passes through
      // unwrapped.
      noTools: "builtin",
      customTools: buildTools({
        jobs,
        client,
        channelId,
        workspaceDir,
        sender,
        tracker,
        wakeUp,
        chatDelivery,
      }),
    });

    // Wire the deferred bindings now that the session exists.
    sessionRef = session;
    attachLoggerToSession(session);
    attachDeliveryToSession(session);
    applyChatModeThinkingLevel(session, services.settingsManager.getDefaultThinkingLevel());
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
      mode: config.chatMode,
      client,
      channelId,
      chatDelivery,
    });
    installActiveTracker({ channelId, session, tracker, mode: config.chatMode });

    entries.set(channelId, entry);
    evict();
    return entry;
  }

  async function handle(channelId: string, message: Message): Promise<void> {
    const entry = await acquirePoolEntry(channelId);
    entry.lastActive = Date.now();
    // Wait out any in-flight compaction before calling `session.prompt(...)`.
    // Pi's `_processAgentEvent` runs compaction inline in the `agent_end`
    // handler before `finishRun()` resolves, so `activeRun` is still set
    // and `prompt()` would throw "Agent is already processing". See #26.
    await whenNotCompacting(entry.session);
    // Point subsequent debug-channel log entries at this message — the
    // logger uses it as the link target so each tool entry is clickable
    // back to the user message that triggered the run.
    entry.logger.setSourceMessageUrl(message.url);
    // Thread the FIRST streamed message of the upcoming run under this
    // user message. installStreamingSender reads this once per run.
    entry.replyTarget = message.id;

    tracker.markPending(channelId);

    const images = await collectImageAttachments(message);
    // Read the busy flag once, then use that same value for both the option we
    // build and the branch we take — the two must agree, or the submitted
    // prompt carries the wrong disposition. See `isSessionBusy`.
    const isBusy = isSessionBusy(entry.session);
    const promptOptions = buildPromptOptions({ images, isBusy });
    // Format wake/steer prompts the same way the `history` tool formats
    // its lines, so the agent always sees the source metadata — including
    // the message_id (for `react` / `send`'s in_reply_to) and edited_at
    // (set on edit-as-steering events). `client.user` is populated by the
    // time the pool handles messages — login completes before the router
    // wires up — so a missing `client.user` here is a bug worth crashing on.
    if (!client.user) throw new Error("client.user not set — login did not complete");
    // The delivery rule rides along with every inbound message: by the time a
    // long session is deep in, the system prompt rule is far away and the newest
    // message is right here.
    const formattedPrompt = withDeliveryHint(
      formatMessage(message, client.user.id),
      config.chatMode,
    );

    if (isBusy) {
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

  function session(channelId: string): AgentSession | undefined {
    return entries.get(channelId)?.session;
  }

  function dropEntry(channelId: string): void {
    entries.delete(channelId);
  }

  async function wakeUp(channelId: string, prompt: string): Promise<void> {
    const entry = await acquirePoolEntry(channelId);
    entry.lastActive = Date.now();
    // Synthetic wake — no real Discord message to thread under.
    entry.replyTarget = undefined;
    // Same compaction guard as `handle` — see #26.
    await whenNotCompacting(entry.session);
    try {
      await entry.session.prompt(prompt);
    } catch (error) {
      await entry.sender.sendError(error);
    }
  }

  function hasActive(channelId: string): boolean {
    return entries.has(channelId);
  }

  return {
    handle,
    wakeUp,
    hasActive,
    session,
    dropEntry,
  };
}
