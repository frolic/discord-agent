import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createJobs, type Jobs } from "../agent/jobs.ts";
import { runBashCommand, truncateTail } from "./bash.ts";

let root: string;
let jobs: Jobs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "bash-test-"));
  jobs = createJobs({ rootDir: join(root, "jobs") });
});

afterEach(() => {
  for (const job of jobs.list()) {
    if (job.running) jobs.kill(job.name);
  }
  rmSync(root, { recursive: true, force: true });
});

function run(args: Parameters<typeof runBashCommand>[0] extends infer _T ? Partial<Parameters<typeof runBashCommand>[0]> : never) {
  return runBashCommand({
    workspaceDir: root,
    jobs,
    ceilingSeconds: 5,
    command: "true",
    ...args,
  });
}

describe("truncateTail", () => {
  test("keeps short output untouched", () => {
    expect(truncateTail("a\nb\n")).toEqual({ text: "a\nb", truncated: false, totalLines: 2 });
  });

  test("keeps only the last 2000 lines", () => {
    const raw = Array.from({ length: 2500 }, (_, index) => `line${index + 1}`).join("\n");
    const result = truncateTail(raw);
    expect(result.truncated).toBe(true);
    expect(result.totalLines).toBe(2500);
    expect(result.text.split("\n")).toHaveLength(2000);
    expect(result.text).toContain("line2500");
    expect(result.text.split("\n")[0]).toBe("line501");
  });

  test("keeps only the last 50KB when a line is huge", () => {
    const result = truncateTail("x".repeat(80 * 1024));
    expect(result.truncated).toBe(true);
    expect(Buffer.byteLength(result.text)).toBeLessThanOrEqual(50 * 1024);
  });

  test("empty output stays empty", () => {
    expect(truncateTail("")).toEqual({ text: "", truncated: false, totalLines: 0 });
  });
});

describe("backgroundable bash", () => {
  test("a short command behaves like a normal bash call", async () => {
    const result = await run({ command: "echo hello && pwd" });
    expect(result.text).toContain("hello");
    expect(result.text).toContain(root);
    expect(result.text).toContain("[exit code 0");
    expect(result.isError).toBe(false);
  });

  test("the wrapper's exit trailer is not shown as output", async () => {
    const result = await run({ command: "echo done" });
    expect(result.text).not.toContain("exited with code");
  });

  test("a failing command comes back as an error with its code", async () => {
    const result = await run({ command: "echo before; exit 3" });
    expect(result.text).toContain("before");
    expect(result.text).toContain("Command exited with code 3");
    expect(result.isError).toBe(true);
  });

  test("a command past the ceiling is handed to the job runner and kept running", async () => {
    const startedAt = Date.now();
    const result = await run({ command: "sleep 30", ceilingSeconds: 1 });
    const elapsedMs = Date.now() - startedAt;

    // The whole point: the call returns at the ceiling, not when the command ends.
    expect(elapsedMs).toBeLessThan(8000);
    expect(result.isError).toBe(false);
    expect(result.text).toContain("handed off to the background");
    expect(result.text).toContain("job_status");

    const name = result.details.jobName ?? "";
    expect(name.length).toBeGreaterThan(0);
    expect(jobs.status(name)?.running).toBe(true);
    jobs.kill(name);
  });

  test("the backgrounded job keeps running after the call returns", async () => {
    const result = await run({ command: "sleep 1; echo finished-late", ceilingSeconds: 0.3 });
    const name = result.details.jobName ?? "";
    expect(jobs.status(name)?.running).toBe(true);
    expect(await jobs.waitForExit(name, 8000)).toBe("exited");
    expect(jobs.log(name)).toContain("finished-late");
    expect(jobs.status(name)?.exitCode).toBe(0);
  });

  test("an explicit timeout still kills instead of backgrounding", async () => {
    const result = await run({ command: "sleep 30", timeout: 0.3 });
    expect(result.text).toContain("timed out");
    expect(result.isError).toBe(true);
    const name = result.details.jobName ?? "";
    expect(await jobs.waitForExit(name, 5000)).toBe("exited");
    expect(jobs.status(name)?.running).toBe(false);
  });

  test("job names do not collide across calls", async () => {
    const first = await run({ command: "sleep 30", ceilingSeconds: 0.3 });
    const second = await run({ command: "sleep 30", ceilingSeconds: 0.3 });
    expect(first.details.backgrounded).toBe(true);
    expect(second.details.backgrounded).toBe(true);
    expect(first.details.jobName).not.toBe(second.details.jobName);
  });

  test("progress updates are emitted while the command runs", async () => {
    const updates: string[] = [];
    const result = await run({
      command: "echo first; sleep 1.6; echo second; sleep 1.6; echo third",
      ceilingSeconds: 10,
      onUpdate: (update) => {
        updates.push(update.content.map((part) => part.text).join(""));
      },
    });
    expect(result.text).toContain("third");
    expect(updates.length).toBeGreaterThan(0);
    expect(updates.at(-1)).toContain("third");
  });

  test("extra env reaches the command", async () => {
    const result = await run({ command: "echo $PI_MODEL", extraEnv: { PI_MODEL: "test-model-9000" } });
    expect(result.text).toContain("test-model-9000");
  });
});
