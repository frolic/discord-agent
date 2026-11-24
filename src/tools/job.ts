/**
 * The job tools: `job_start`, `job_status`, `job_log`, `job_kill`.
 *
 * Four separate tools rather than one with an `action` union — a union makes the
 * model pick an action *and* guess required parameters from prose, and it makes
 * "which jobs are running?" a mode of a tool that mostly does something else.
 *
 * Why these exist at all: a turn that blocks on a ten-minute command cannot
 * answer the user, and cannot be steered into answering. Everything long runs
 * detached (see `agent/jobs.ts`) and gets polled from here. `bash` auto-detaches
 * at its ceiling, so the jobs the model polls are usually ones it never
 * explicitly started.
 */
import { defineTool, type AgentToolResult } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";
import type { Jobs, JobSnapshot } from "../agent/jobs.ts";

/**
 * `details` must have a single shape across every return of one tool — pi infers
 * the result type from all of them. Everything optional, filled per branch.
 */
interface JobDetails {
  name?: string;
  pid?: number;
  running?: boolean;
  exitCode?: number | null;
  count?: number;
  outcome?: string;
  logPath?: string;
}

const pollHint =
  "Poll every 15-30 seconds rather than in a tight loop. No output change across two checks means it is probably stuck — read the log, then kill it if it is.";

function renderSnapshot(snapshot: JobSnapshot): string {
  const state = snapshot.running ? `running (pid ${snapshot.pid})` : `finished${snapshot.exitCode === null ? "" : ` — exit code ${snapshot.exitCode}`}`;
  const tail = snapshot.tail.length > 0 ? `\n--- log tail ---\n${snapshot.tail}` : "\n(no output yet)";
  return `job "${snapshot.name}" ${state}, started ${new Date(snapshot.startedAt).toISOString()}\ncommand: ${snapshot.command}${tail}`;
}

export function createJobStartTool(args: { jobs: Jobs; workspaceDir: string }) {
  const { jobs, workspaceDir } = args;
  return defineTool({
    name: "job_start",
    label: "start background job",
    description: `Start a command as a background job and get control back immediately. Use this — or a \`bash\` call that runs past its ceiling and hands off here automatically — for anything that may take more than a couple of minutes: builds, installs, test suites, deploys, big fetches, log scans.

The command runs detached with its output in a log file, so it survives this turn and even an agent restart. ${pollHint}

Reply to the user while it runs: starting a job never blocks a message.`,
    parameters: Type.Object({
      name: Type.String({
        description:
          "Short handle for the job (`build`, `install-deps`). Reused names must not collide with a running job.",
      }),
      command: Type.String({ description: "Shell command to run in the conversation workspace." }),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<JobDetails>> => {
      const job = jobs.start({ name: params.name, command: params.command, cwd: workspaceDir });
      return {
        content: [
          {
            type: "text",
            text: `started job "${job.name}" (pid ${job.pid}), log at ${job.logPath}\nPoll with job_status, read with job_log, stop with job_kill.`,
          },
        ],
        details: { name: job.name, pid: job.pid, logPath: job.logPath },
        terminate: false,
      };
    },
  });
}

export function createJobStatusTool(args: { jobs: Jobs }) {
  const { jobs } = args;
  return defineTool({
    name: "job_status",
    label: "job status",
    description: `Check a background job: running or finished (with its exit code) plus a short log tail. Omit \`name\` to list every job, newest first.

Use this to decide what to do next — keep polling while it makes progress, kill and investigate when it stalls, read the full log when it finishes.`,
    parameters: Type.Object({
      name: Type.Optional(
        Type.String({ description: "Job name. Omit to list all jobs with their state." }),
      ),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<JobDetails>> => {
      if (params.name === undefined || params.name.trim().length === 0) {
        const all = jobs.list();
        if (all.length === 0) {
          return {
            content: [{ type: "text", text: "no jobs" }],
            details: { count: 0 },
            terminate: false,
          };
        }
        const lines = all.map((snapshot) => {
          const state = snapshot.running
            ? "running"
            : `finished (exit ${snapshot.exitCode ?? "?"})`;
          return `- ${snapshot.name}: ${state} — ${snapshot.command.slice(0, 80)}`;
        });
        return {
          content: [{ type: "text", text: lines.join("\n") }],
          details: { count: all.length },
          terminate: false,
        };
      }
      const snapshot = jobs.status(params.name);
      if (!snapshot) {
        return {
          content: [{ type: "text", text: `no job named "${params.name}"` }],
          details: { name: params.name },
          isError: true,
          terminate: false,
        };
      }
      return {
        content: [{ type: "text", text: renderSnapshot(snapshot) }],
        details: {
          name: snapshot.name,
          running: snapshot.running,
          exitCode: snapshot.exitCode,
        },
        terminate: false,
      };
    },
  });
}

export function createJobLogTool(args: { jobs: Jobs }) {
  const { jobs } = args;
  return defineTool({
    name: "job_log",
    label: "job log",
    description: `Read the tail of a background job's log (the full output is on disk; this returns the last N lines). Use it to see progress while a job runs, or the whole result once it finishes.`,
    parameters: Type.Object({
      name: Type.String({ description: "Job name." }),
      lines: Type.Optional(
        Type.Number({ description: "How many trailing lines to return (default 40)." }),
      ),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<JobDetails>> => {
      const text = jobs.log(params.name, params.lines ?? 40);
      if (text === null) {
        return {
          content: [{ type: "text", text: `no job named "${params.name}"` }],
          details: { name: params.name },
          isError: true,
          terminate: false,
        };
      }
      return {
        content: [{ type: "text", text: text.length > 0 ? text : "(no output yet)" }],
        details: { name: params.name, logPath: jobs.logPath(params.name) ?? undefined },
        terminate: false,
      };
    },
  });
}

export function createJobKillTool(args: { jobs: Jobs }) {
  const { jobs } = args;
  return defineTool({
    name: "job_kill",
    label: "kill job",
    description: `Stop a running background job (SIGTERM to its process group, so a build's children go too). Use it when polling shows the job is stuck, or when the user asks you to stop. Never kill a job just because it is slow.`,
    parameters: Type.Object({
      name: Type.String({ description: "Job name." }),
    }),
    execute: async (_toolCallId, params): Promise<AgentToolResult<JobDetails>> => {
      const outcome = jobs.kill(params.name);
      const message =
        outcome === "killed"
          ? `killed job "${params.name}"`
          : outcome === "not running"
            ? `job "${params.name}" is not running`
            : outcome === "unknown job"
              ? `no job named "${params.name}"`
              : `failed to kill job "${params.name}"`;
      return {
        content: [{ type: "text", text: message }],
        details: { name: params.name, outcome },
        isError: outcome === "unknown job" || outcome === "failed",
        terminate: false,
      };
    },
  });
}

export function createJobTools(args: { jobs: Jobs; workspaceDir: string }) {
  return [
    createJobStartTool(args),
    createJobStatusTool(args),
    createJobLogTool(args),
    createJobKillTool(args),
  ];
}
