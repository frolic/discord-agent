/**
 * `bash` — pi's shell tool, but it cannot hold the turn hostage.
 *
 * The behaviour that broke: one `pnpm build` or `gh run watch` in a turn blocks
 * everything. The agent cannot answer the user, a steer has to wait for the
 * command, and the only alternatives were "wait forever" or "a shotgun timeout
 * that kills legitimate work".
 *
 * So a command runs as a **detached job from the start** (same machinery the
 * `job_*` tools use) and this tool waits for it only up to a ceiling:
 *
 * - finishes inside the ceiling → the output comes back exactly like a normal
 *   bash call. Short commands behave identically to before; nobody has to know
 *   this wrapper exists.
 * - still running at the ceiling → the call returns a job handle plus the tail so
 *   far, and the command keeps running detached (surviving the turn and a
 *   restart). The model polls with `job_status` / `job_log` and replies to the
 *   user meanwhile.
 *
 * An explicit `timeout` parameter still means what it always meant — kill after N
 * seconds — because a caller asking for a bound wants the bound, not a job.
 *
 * Output handling differs from pi's built-in bash in one way that matters: the
 * full output already exists as the job's log file, so truncation points at that
 * instead of writing a second temp file.
 *
 * The work lives in `runBashCommand` rather than inside `execute` so it can be
 * tested without constructing a pi tool context.
 */
import { readFileSync } from "node:fs";
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Jobs } from "../agent/jobs.ts";

/** Matches pi's bash tool: last 2000 lines or 50KB of output reaches the model. */
const maxLines = 2000;
const maxBytes = 50 * 1024;
/** Foreground window for auto-backgrounding, unless `BASH_CEILING_SECS` says otherwise. */
const defaultCeilingSecs = 110;
/** How often the foreground window emits an output update. */
const updateIntervalMs = 750;

export interface BashDetails {
  exitCode?: number | null;
  wallTimeSeconds?: number;
  truncated?: boolean;
  logPath?: string;
  jobName?: string;
  backgrounded?: boolean;
  killed?: boolean;
}

export interface BashResult {
  text: string;
  isError: boolean;
  details: BashDetails;
}

interface TruncatedOutput {
  text: string;
  truncated: boolean;
  totalLines: number;
}

/** Keep the LAST `maxLines`/`maxBytes` of the log, the way a shell tool should. */
export function truncateTail(raw: string): TruncatedOutput {
  if (raw.length === 0) return { text: "", truncated: false, totalLines: 0 };
  const lines = raw.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const totalLines = lines.length;

  let kept = lines.slice(-maxLines);
  let truncated = kept.length < totalLines;
  let text = kept.join("\n");
  if (Buffer.byteLength(text) > maxBytes) {
    // Drop whole lines from the front until it fits, then hard-cut if a single
    // line is itself over the limit.
    while (kept.length > 1 && Buffer.byteLength(kept.join("\n")) > maxBytes) kept = kept.slice(1);
    text = kept.join("\n");
    if (Buffer.byteLength(text) > maxBytes) {
      const buffer = Buffer.from(text);
      text = buffer.subarray(buffer.length - maxBytes).toString("utf8");
    }
    truncated = true;
  }
  return { text, truncated, totalLines };
}

function readLog(path: string): string {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return "";
  }
}

/** Drop the job wrapper's exit trailer — the tool reports the code itself. */
function stripExitTrailer(text: string): string {
  return text.replace(/\n*\[job [^\]]* exited with code -?\d+\]\s*$/, "");
}

function exitCodeFromLog(raw: string): number | null {
  const match = /\[job .* exited with code (-?\d+)\]\s*$/.exec(raw);
  return match ? Number.parseInt(match[1] ?? "", 10) : null;
}

export async function runBashCommand(args: {
  command: string;
  /** Hard kill bound in seconds (the model's `timeout` parameter). */
  timeout?: number;
  workspaceDir: string;
  jobs: Jobs;
  ceilingSeconds: number;
  /** Extra environment for the child (the harness passes `PI_*` session context). */
  extraEnv?: Record<string, string>;
  onUpdate?: (update: { content: { type: "text"; text: string }[] }) => void;
  /** Name for the job; defaults to a generated one. */
  jobName?: string;
}): Promise<BashResult> {
  const { command, workspaceDir, jobs, ceilingSeconds, extraEnv, onUpdate } = args;
  const startedAt = Date.now();
  const name = args.jobName ?? nextJobName(jobs, command);
  const job = jobs.start({
    name,
    command,
    cwd: workspaceDir,
    ...(extraEnv ? { env: extraEnv } : {}),
  });

  // Explicit timeout: hold the foreground window to it, then kill (pi's
  // semantics — the caller asked for a bound, not for a job).
  const hardKillMs = args.timeout !== undefined ? Math.max(1, args.timeout * 1000) : null;
  const windowMs = hardKillMs ?? ceilingSeconds * 1000;

  // Emit progress while we wait, so a slow-but-moving command looks alive.
  let lastReported = "";
  const timer = setInterval(() => {
    if (!onUpdate) return;
    const tail = truncateTail(readLog(job.logPath)).text;
    if (tail === lastReported) return;
    lastReported = tail;
    onUpdate({ content: [{ type: "text", text: tail }] });
  }, updateIntervalMs);

  let outcome: "exited" | "running" | "unknown job";
  try {
    outcome = await jobs.waitForExit(job.name, windowMs);
  } finally {
    clearInterval(timer);
    // One last update so the caller sees the tail as of the hand-off.
    if (onUpdate) {
      const tail = truncateTail(readLog(job.logPath)).text;
      if (tail !== lastReported) onUpdate({ content: [{ type: "text", text: tail }] });
    }
  }

  const raw = readLog(job.logPath);
  const { text, truncated, totalLines } = truncateTail(raw);
  const truncatedNote = truncated
    ? `\n\n[Showing last ${maxLines} lines of ${totalLines}. Full output: ${job.logPath}]`
    : "";
  const wallTimeSeconds = Math.round((Date.now() - startedAt) / 100) / 10;

  if (outcome === "running" && hardKillMs !== null) {
    jobs.kill(job.name);
    return {
      text: `Command timed out after ${hardKillMs / 1000}s and was killed.\n\n${stripExitTrailer(text)}${truncatedNote}`,
      isError: true,
      details: { jobName: job.name, killed: true, logPath: job.logPath, wallTimeSeconds },
    };
  }

  if (outcome === "running") {
    const tail = jobs.status(job.name)?.tail ?? "";
    return {
      text:
        `Still running after ${ceilingSeconds}s — handed off to the background as job "${job.name}".\n` +
        `Poll it with job_status("${job.name}"), read it with job_log, stop it with job_kill. It keeps running if this turn ends.\n` +
        (tail.length > 0 ? `\n--- log tail ---\n${tail}` : ""),
      isError: false,
      details: {
        jobName: job.name,
        backgrounded: true,
        logPath: job.logPath,
        wallTimeSeconds,
      },
    };
  }

  const exitCode = jobs.status(job.name)?.exitCode ?? exitCodeFromLog(raw);
  const body = text.length > 0 ? text : "(no output)";
  return {
    text:
      `${stripExitTrailer(body)}\n\n[exit code ${exitCode ?? "?"}, ${wallTimeSeconds}s]` +
      `${truncatedNote}${exitCode !== null && exitCode !== 0 ? `\nCommand exited with code ${exitCode}` : ""}`,
    isError: exitCode !== 0,
    details: { exitCode, wallTimeSeconds, truncated, logPath: job.logPath },
  };
}

/** Pick a name that does not collide with a live job. */
function nextJobName(jobs: Jobs, command: string): string {
  const firstWord = command.trim().split(/\s+/)[0] ?? "command";
  const slug = firstWord.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 16) || "command";
  for (let attempt = 1; attempt <= 100; attempt++) {
    const name = `bash-${slug}-${Date.now().toString(36)}-${attempt}`;
    const existing = jobs.status(name);
    if (!existing || !existing.running) return name;
  }
  return `bash-${Date.now()}`;
}

export function createBackgroundableBashTool(args: {
  workspaceDir: string;
  jobs: Jobs;
  /** Foreground window in seconds before the command is handed to the job runner. */
  ceilingSeconds?: number;
}) {
  const { workspaceDir, jobs } = args;
  const ceilingSeconds = args.ceilingSeconds ?? defaultCeilingSecs;

  return defineTool({
    name: "bash",
    label: "bash",
    description: `Execute a bash command in the conversation workspace. Returns stdout and stderr.

Long commands do not hold up the conversation: a command still running after ~${ceilingSeconds}s is handed off to the background automatically and you get a job handle back (poll it with \`job_status\`, read \`job_log\`, stop it with \`job_kill\`). Prefer \`job_start\` when you already expect the work to be long — then you can reply to the user without waiting at all.

Output is truncated to the last ${maxLines} lines or ${maxBytes / 1024}KB; the full output is always available at the job's log path.

An explicit \`timeout\` (seconds) still kills the command at that point — use it for things that must not run away, not for things you simply expect to be slow.`,
    parameters: Type.Object({
      command: Type.String({ description: "Shell command to execute" }),
      timeout: Type.Optional(
        Type.Number({
          description:
            "Kill the command after this many seconds (hard bound). Omit for the default: hand off to the background after the ceiling instead of killing.",
        }),
      ),
    }),
    execute: async (_toolCallId, params, _signal, onUpdate, ctx): Promise<AgentToolResult<BashDetails>> => {
      // Mirror pi's bash: the child sees which session/model it belongs to.
      const extraEnv: Record<string, string> = {};
      if (ctx?.sessionManager) extraEnv.PI_SESSION_ID = ctx.sessionManager.getSessionId();
      const sessionFile = ctx?.sessionManager?.getSessionFile?.();
      if (sessionFile) extraEnv.PI_SESSION_FILE = sessionFile;
      const model = ctx?.model;
      if (model) {
        extraEnv.PI_PROVIDER = model.provider;
        extraEnv.PI_MODEL = model.id;
      }
      if (ctx?.thinkingLevel) extraEnv.PI_REASONING_LEVEL = ctx.thinkingLevel;

      const result = await runBashCommand({
        command: params.command,
        ...(params.timeout !== undefined ? { timeout: params.timeout } : {}),
        workspaceDir,
        jobs,
        ceilingSeconds,
        extraEnv,
        ...(onUpdate
          ? { onUpdate: (update: { content: { type: "text"; text: string }[] }) => onUpdate({ content: update.content, details: {} }) }
          : {}),
      });

      return {
        content: [{ type: "text", text: result.text }],
        details: result.details,
        isError: result.isError,
        terminate: false,
      };
    },
  });
}
