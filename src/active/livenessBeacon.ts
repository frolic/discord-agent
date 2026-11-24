/**
 * Liveness beacon — the only signal the dead-man's switch outside this
 * checkout trusts. Two files in the signal dir (`~/.pollux` by default):
 *
 *   heartbeat — rewritten every 30s for as long as the process runs.
 *   ready     — written once per boot, after Discord is connected and the
 *               session pool is bound. Carries the harness git SHA.
 *
 * Deliberate asymmetry: the beacon can only say "I am alive". It has no
 * way to say "do not revert me" — the revert policy lives outside this
 * repo in `/usr/local/sbin/pollux-deadmans-switch.sh`, so broken code in
 * here cannot also be the thing that judges whether it should be
 * reverted. See `docs/liveness-signals.md`.
 *
 * Every write is best-effort: liveness bookkeeping must never be the
 * reason the harness dies.
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";

export const HEARTBEAT_INTERVAL_MS = 30_000;

export interface LivenessBeacon {
  /** Files in use — handy for logs, tests, and docs. */
  readonly files: { heartbeat: string; ready: string };
  /** Write the ready marker. Call once, after Discord is connected. */
  markReady(): void;
  /** Stop the heartbeat timer (tests, teardown). */
  stop(): void;
}

export function startLivenessBeacon(args: {
  /** Where the signal files live, e.g. `~/.pollux`. */
  dir: string;
  /** Harness checkout root — its HEAD SHA lands in the ready file. */
  harnessDir: string;
  /** Heartbeat period. Overridden only by tests. */
  intervalMs?: number;
}): LivenessBeacon {
  const { dir, harnessDir, intervalMs = HEARTBEAT_INTERVAL_MS } = args;
  const heartbeatFile = resolve(dir, "heartbeat");
  const readyFile = resolve(dir, "ready");
  const bootedAt = new Date().toISOString();

  const files = { heartbeat: heartbeatFile, ready: readyFile };
  mkdirSync(dir, { recursive: true });

  // A ready marker left over from the previous boot would read as "this
  // process is serving" before it has connected. Drop it first, then beat.
  removeQuietly(readyFile);

  let readyWritten = false;
  let timer: ReturnType<typeof setInterval> | undefined;

  function beat(): void {
    try {
      writeFileSync(heartbeatFile, `${new Date().toISOString()}\n`);
    } catch (error) {
      console.error("[liveness] heartbeat write failed:", error);
    }
  }

  beat();
  timer = setInterval(beat, intervalMs);
  // Bookkeeping must not be the reason the process stays alive.
  timer.unref?.();

  return {
    files,
    markReady() {
      if (readyWritten) return;
      readyWritten = true;
      try {
        const marker = {
          at: new Date().toISOString(),
          bootedAt,
          pid: process.pid,
          sha: harnessSha(harnessDir),
        };
        writeFileSync(readyFile, `${JSON.stringify(marker, null, 2)}\n`);
      } catch (error) {
        console.error("[liveness] ready write failed:", error);
      }
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

/** HEAD of the harness checkout, or "unknown" outside a git work tree. */
function harnessSha(harnessDir: string): string {
  try {
    return execFileSync("git", ["-C", harnessDir, "rev-parse", "HEAD"], {
      encoding: "utf-8",
      timeout: 2_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
  } catch {
    return "unknown";
  }
}

function removeQuietly(path: string): void {
  try {
    rmSync(path, { force: true });
  } catch (error) {
    console.error(`[liveness] could not clear ${path}:`, error);
  }
}
