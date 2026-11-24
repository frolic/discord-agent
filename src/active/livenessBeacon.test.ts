/**
 * Tests for the liveness beacon — the files the out-of-band supervisor
 * polls. The contract that matters: heartbeat appears immediately and keeps
 * refreshing, `ready` only appears on demand, and a marker left over from a
 * previous boot can never masquerade as this boot's readiness.
 */
import { describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startLivenessBeacon } from "./livenessBeacon.ts";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "liveness-beacon-"));
}

interface ReadyMarker {
  at: string;
  bootedAt: string;
  pid: number;
  sha: string;
}

function readReady(path: string): ReadyMarker {
  const parsed: unknown = JSON.parse(readFileSync(path, "utf-8"));
  if (!parsed || typeof parsed !== "object") throw new Error("ready marker is not an object");
  if (!("sha" in parsed) || typeof parsed.sha !== "string") throw new Error("ready marker has no sha");
  if (!("pid" in parsed) || typeof parsed.pid !== "number") throw new Error("ready marker has no pid");
  if (!("bootedAt" in parsed) || typeof parsed.bootedAt !== "string") {
    throw new Error("ready marker has no bootedAt");
  }
  if (!("at" in parsed) || typeof parsed.at !== "string") throw new Error("ready marker has no at");
  return { at: parsed.at, bootedAt: parsed.bootedAt, pid: parsed.pid, sha: parsed.sha };
}

function initRepo(dir: string): string {
  const run = (command: string[]) => {
    const result = Bun.spawnSync(command, { cwd: dir, stdout: "pipe", stderr: "pipe" });
    if (result.exitCode !== 0) throw new Error(`${command.join(" ")} failed: ${result.stderr.toString()}`);
    return result.stdout.toString().trim();
  };
  run(["git", "init", "-q"]);
  run(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "one"]);
  run(["git", "-c", "user.email=test@example.com", "-c", "user.name=test", "commit", "-q", "--allow-empty", "-m", "two"]);
  return run(["git", "rev-parse", "HEAD"]);
}

describe("startLivenessBeacon", () => {
  test("writes a heartbeat straight away and keeps it fresh", async () => {
    const dir = tempDir();
    const beacon = startLivenessBeacon({ dir, harnessDir: dir, intervalMs: 20 });
    try {
      expect(existsSync(beacon.files.heartbeat)).toBe(true);
      const firstBeat = readFileSync(beacon.files.heartbeat, "utf-8");
      await Bun.sleep(60);
      const laterBeat = readFileSync(beacon.files.heartbeat, "utf-8");
      expect(laterBeat).not.toBe(firstBeat);
    } finally {
      beacon.stop();
    }
  });

  test("does not write ready until markReady is called", () => {
    const dir = tempDir();
    const beacon = startLivenessBeacon({ dir, harnessDir: dir, intervalMs: 1_000 });
    try {
      expect(existsSync(beacon.files.ready)).toBe(false);
      beacon.markReady();
      expect(existsSync(beacon.files.ready)).toBe(true);
    } finally {
      beacon.stop();
    }
  });

  test("clears a stale ready marker from a previous boot", () => {
    const dir = tempDir();
    const first = startLivenessBeacon({ dir, harnessDir: dir, intervalMs: 1_000 });
    first.markReady();
    first.stop();
    expect(existsSync(first.files.ready)).toBe(true);

    const second = startLivenessBeacon({ dir, harnessDir: dir, intervalMs: 1_000 });
    try {
      expect(existsSync(second.files.ready)).toBe(false);
    } finally {
      second.stop();
    }
  });

  test("stamps the harness HEAD sha and is idempotent", () => {
    const dir = tempDir();
    const headSha = initRepo(dir);
    const beacon = startLivenessBeacon({ dir, harnessDir: dir, intervalMs: 1_000 });
    try {
      beacon.markReady();
      const marker = readReady(beacon.files.ready);
      expect(marker.sha).toBe(headSha);
      expect(marker.pid).toBe(process.pid);

      const before = readFileSync(beacon.files.ready, "utf-8");
      beacon.markReady();
      expect(readFileSync(beacon.files.ready, "utf-8")).toBe(before);
    } finally {
      beacon.stop();
    }
  });

  test("reports sha unknown outside a git work tree", () => {
    const dir = tempDir();
    writeFileSync(join(dir, "not-a-repo"), "x");
    const beacon = startLivenessBeacon({ dir, harnessDir: tempDir(), intervalMs: 1_000 });
    try {
      beacon.markReady();
      expect(readReady(beacon.files.ready).sha).toBe("unknown");
    } finally {
      beacon.stop();
    }
  });

  test("creates a missing signal dir", () => {
    const dir = join(tempDir(), "nested", "pollux");
    const beacon = startLivenessBeacon({ dir, harnessDir: dir, intervalMs: 1_000 });
    try {
      expect(existsSync(beacon.files.heartbeat)).toBe(true);
    } finally {
      beacon.stop();
    }
  });
});
