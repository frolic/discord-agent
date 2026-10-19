/**
 * Job tool — supervised background jobs for long-running work.
 *
 * The runner should never block a turn on a single long tool call (it can
 * hang forever) and never shotgun-kill legitimate work with a blanket
 * timeout. Instead: kick the job off in the background, get control back
 * immediately, then poll `status`/`log` every 15-30s and decide as it
 * runs — keep polling on progress, kill when stalled, read the log when
 * done. Job state (pid + log file) survives tool calls, turns, and agent
 * restarts, so a crashed run can be resumed by reading the job's log.
 *
 * Backed by `infra/scripts/job.sh` in the agent home (the repo keeps the
 * canonical implementation; this tool is its harness-facing facade).
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { homedir } from "node:os";
import { join } from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

const execFileAsync = promisify(execFile);
const JOB_SCRIPT = join(homedir(), "agents", "pollux", "infra", "scripts", "job.sh");

export function createJobTool() {
  return defineTool({
    name: "job",
    label: "run background job",
    description:
      "Supervised background jobs for work that will run longer than ~2-3 minutes (builds, installs, CI, big fetches, diffs). Before using the regular bash tool for anything long, use this: `job start <name> -- <command>` returns immediately and runs the command detached with a log file; then poll with `job status <name>` / `job log <name>` every 15-30 seconds and decide as it runs — progress: keep polling; no change two checks in a row: kill and investigate; finished: read the log and continue. Job state survives agent restarts. Never block the turn with a multi-minute bash call and never kill long work with a shotgun timeout.",
    parameters: Type.Object({
      action: Type.Union(
        [
          Type.Literal("start", { description: "start a background job" }),
          Type.Literal("status", { description: "running/done + log tail for one job, or all jobs when name omitted" }),
          Type.Literal("log", { description: "tail a job's log" }),
          Type.Literal("kill", { description: "kill a running job (use when polling shows it stuck)" }),
          Type.Literal("list", { description: "list all jobs with status" }),
        ],
        { description: "what to do with the job" },
      ),
      name: Type.Optional(
        Type.String({ description: "job name (required for start/status/log/kill of a specific job)" }),
      ),
      command: Type.Optional(
        Type.String({
          description: "the command to run, required for `start`. Any command that works in bash.",
        }),
      ),
      lines: Type.Optional(
        Type.Number({ description: "how many log lines to show (default 20)", default: 20 }),
      ),
    }),
    execute: async (_id, params) => {
      const args: string[] = [params.action];
      if (params.action === "start") {
        if (!params.name || !params.command) throw new Error("start requires name + command");
        args.push(params.name, "--", params.command);
      } else if (params.action === "list") {
        // list = status with no name
      } else {
        if (!params.name) throw new Error(`${params.action} requires a job name`);
        args.push(params.name);
        if (params.action === "log" && params.lines) args.push(String(params.lines));
      }

      const { stdout, stderr } = await execFileAsync("bash", [JOB_SCRIPT, ...args], {
        timeout: 15_000,
      }).catch((error) => {
        // execFile rejects with { stdout, stderr, code } on non-zero exit —
        // job.sh already formats failures for humans; surface that.
        if (error && typeof error === "object" && "stdout" in error) {
          return { stdout: String(error.stdout ?? ""), stderr: String(error.stderr ?? "") };
        }
        throw error;
      });

      const text = [stdout.trim(), stderr.trim()].filter(Boolean).join("\n");
      return {
        content: [{ type: "text", text: text || "(no output)" }],
        details: { action: params.action, name: params.name ?? null },
      };
    },
  });
}