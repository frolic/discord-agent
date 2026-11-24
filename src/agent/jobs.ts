/**
 * Supervised background jobs — the harness's answer to "this command might take
 * ten minutes".
 *
 * The failure this exists to remove: a single long `bash` call holds the whole
 * turn. The agent can't reply, can't be steered into responding, and the channel
 * sits silent until the command finishes or a blanket timeout kills legitimate
 * work. So long commands run **detached with a log file** and the agent polls
 * them; the turn is free the moment the job starts.
 *
 * Properties that matter:
 *
 * - **Detached.** The child gets its own process group, so it survives the tool
 *   call, the turn, and an agent restart. Nothing here is tied to the event loop.
 * - **Self-describing.** Each job is a directory under `<agentDir>/jobs/<name>/`
 *   holding `log` (combined stdout+stderr), `pid`, and `meta.json` (command, cwd,
 *   started-at). A restarted agent discovers running jobs by reading that
 *   directory — no in-memory state to lose.
 * - **Exit code lands in the log.** The command runs under a tiny shell wrapper
 *   that appends `[job … exited with code N]`, so "did it succeed?" is answerable
 *   from the log rather than from a reaped process handle we no longer have.
 * - **Never auto-killed.** A job runs until it exits or the agent kills it.
 *   Killing a real build because a poll saw no output for a while is the
 *   behaviour this design exists to avoid.
 */
import { mkdirSync, openSync, readFileSync, writeFileSync, existsSync, readdirSync, statSync } from "node:fs";
import { resolve } from "node:path";

/** The wrapper's own last line — see `start`. */
const exitTrailerPattern = /^\[job .* exited with code -?\d+\]$/;

/** Lines of a job log shown by `status` / the bash hand-off. */
const statusTailLines = 12;

export interface JobRecord {
  name: string;
  command: string;
  cwd: string;
  pid: number;
  startedAt: number;
  logPath: string;
}

export interface JobSnapshot extends JobRecord {
  running: boolean;
  /** Last line of the log that looks like the wrapper's exit trailer, if any. */
  exitCode: number | null;
  tail: string;
}

export interface Jobs {
  /**
   * Start a detached job. Rejects when the name is already running — restacking
   * a second copy of a live job is how you get two builds writing the same
   * output.
   */
  start(args: {
    name: string;
    command: string;
    cwd: string;
    /** Extra env for the child (e.g. `PI_*` session context), merged over `process.env`. */
    env?: Record<string, string>;
  }): JobRecord;
  /** One job's live state plus a log tail. `null` when the name is unknown. */
  status(name: string): JobSnapshot | null;
  /** Tail of a job's log, newest `lines` lines. */
  log(name: string, lines?: number): string | null;
  /** SIGTERM the job's process group. Returns what actually happened. */
  kill(name: string): "killed" | "not running" | "unknown job" | "failed";
  /** Every known job, newest first. */
  list(): JobSnapshot[];
  /** Await a job's exit, or give up after `ceilingMs`. */
  waitForExit(name: string, ceilingMs: number): Promise<"exited" | "running" | "unknown job">;
  /** Path of a job's log — the full output, no truncation. */
  logPath(name: string): string | null;
}

/** Keep job names filesystem-safe and predictable. */
export function normaliseJobName(raw: string): string {
  const slug = raw
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9._-]+/g, "-")
    // Leading dots/dashes are stripped after the collapse: a surviving ".." or a
    // leading dot would escape or hide the job directory.
    .replace(/^[.-]+/, "")
    .replace(/-+$/, "")
    .slice(0, 48);
  return slug.length > 0 ? slug : "job";
}

export function createJobs(args: { rootDir: string }): Jobs {
  const rootDir = args.rootDir;

  function jobDir(name: string): string {
    return resolve(rootDir, normaliseJobName(name));
  }

  function record(name: string): JobRecord | null {
    const dir = jobDir(name);
    const metaPath = resolve(dir, "meta.json");
    if (!existsSync(metaPath)) return null;
    try {
      const meta = JSON.parse(readFileSync(metaPath, "utf8")) as {
        command?: string;
        cwd?: string;
        pid?: number;
        startedAt?: number;
      };
      if (typeof meta.pid !== "number") return null;
      return {
        name: normaliseJobName(name),
        command: meta.command ?? "",
        cwd: meta.cwd ?? "",
        pid: meta.pid,
        startedAt: meta.startedAt ?? 0,
        logPath: resolve(dir, "log"),
      };
    } catch {
      return null;
    }
  }

  function isAlive(pid: number): boolean {
    try {
      process.kill(pid, 0);
      return true;
    } catch {
      return false;
    }
  }

  function readTail(path: string, lines: number): string {
    if (!existsSync(path)) return "";
    const text = readFileSync(path, "utf8");
    if (text.length === 0) return "";
    const all = text.split("\n");
    // Drop the wrapper's exit trailer and the blank line that separates it: it is
    // metadata about the run, not output the caller asked to read. Leaving it in
    // would let it eat a tail line and hide the actual result.
    while (all.length > 0 && (all.at(-1) === "" || exitTrailerPattern.test(all.at(-1) ?? ""))) all.pop();
    return all.slice(-lines).join("\n");
  }

  function exitCodeFromLog(path: string): number | null {
    if (!existsSync(path)) return null;
    const text = readFileSync(path, "utf8");
    const match = /\[job .* exited with code (-?\d+)\]\s*$/.exec(text);
    return match ? Number.parseInt(match[1] ?? "", 10) : null;
  }

  function snapshot(job: JobRecord): JobSnapshot {
    const running = isAlive(job.pid);
    return {
      ...job,
      running,
      exitCode: running ? null : exitCodeFromLog(job.logPath),
      tail: readTail(job.logPath, statusTailLines),
    };
  }

  return {
    start({ name, command, cwd, env }) {
      const normalised = normaliseJobName(name);
      const existing = record(normalised);
      if (existing && isAlive(existing.pid)) {
        throw new Error(
          `job "${normalised}" is already running (pid ${existing.pid}) — poll it with job_status instead of starting a second copy`,
        );
      }

      const dir = jobDir(normalised);
      mkdirSync(dir, { recursive: true });
      const logPath = resolve(dir, "log");
      // Truncate, then hand the child a plain fd: the process writes straight to
      // the file, so a job keeps logging after this process exits.
      const logFd = openSync(logPath, "w");
      // The wrapper records the exit code in the log — the job outlives the
      // handle that could otherwise be waited on.
      // The command runs in a subshell so a bare `exit 7` leaves through the
      // subshell only — otherwise the wrapper's trailer (and the exit code with
      // it) would never run.
      const script = `(\n${command}\n)\nexit_code=$?\nprintf '\\n[job %s exited with code %s]\\n' ${JSON.stringify(normalised)} "$exit_code"\nexit "$exit_code"\n`;
      const child = Bun.spawn({
        cmd: ["bash", "-c", script],
        cwd,
        env: env ? { ...process.env, ...env } : process.env,
        stdin: "ignore",
        stdout: logFd,
        stderr: logFd,
        detached: true,
      });

      const job: JobRecord = {
        name: normalised,
        command,
        cwd,
        pid: child.pid,
        startedAt: Date.now(),
        logPath,
      };
      writeFileSync(
        resolve(dir, "meta.json"),
        `${JSON.stringify({ command, cwd, pid: job.pid, startedAt: job.startedAt }, null, 2)}\n`,
      );
      writeFileSync(resolve(dir, "pid"), `${job.pid}\n`);
      // Detached: the parent must not wait for it. Keep no handle that could.
      child.unref();
      return job;
    },

    status(name) {
      const job = record(name);
      return job ? snapshot(job) : null;
    },

    log(name, lines = 40) {
      const job = record(name);
      if (!job) return null;
      return readTail(job.logPath, lines);
    },

    logPath(name) {
      const job = record(name);
      return job ? job.logPath : null;
    },

    kill(name) {
      const job = record(name);
      if (!job) return "unknown job";
      if (!isAlive(job.pid)) return "not running";
      try {
        // Detached jobs lead their own process group, so the negative pid takes
        // the whole tree (a build's children, not just the shell).
        process.kill(-job.pid, "SIGTERM");
        return "killed";
      } catch {
        try {
          process.kill(job.pid, "SIGTERM");
          return "killed";
        } catch {
          return "failed";
        }
      }
    },

    list() {
      if (!existsSync(rootDir)) return [];
      const snapshots: JobSnapshot[] = [];
      for (const entry of readdirSync(rootDir)) {
        const dir = resolve(rootDir, entry);
        try {
          if (!statSync(dir).isDirectory()) continue;
        } catch {
          continue;
        }
        const job = record(entry);
        if (job) snapshots.push(snapshot(job));
      }
      return snapshots.sort((left, right) => right.startedAt - left.startedAt);
    },

    async waitForExit(name, ceilingMs) {
      const job = record(name);
      if (!job) return "unknown job";
      const deadline = Date.now() + ceilingMs;
      // Poll the pid rather than holding the spawn handle: the job may have been
      // started by an earlier process (or before a restart).
      while (Date.now() < deadline) {
        if (!isAlive(job.pid)) return "exited";
        await new Promise((done) => setTimeout(done, Math.min(250, Math.max(50, deadline - Date.now()))));
      }
      return isAlive(job.pid) ? "running" : "exited";
    },
  };
}
