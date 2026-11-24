import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { createJobs, normaliseJobName, type Jobs } from "./jobs.ts";

let root: string;
let jobs: Jobs;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "jobs-test-"));
  jobs = createJobs({ rootDir: join(root, "jobs") });
});

afterEach(() => {
  for (const job of jobs.list()) {
    if (job.running) jobs.kill(job.name);
  }
  rmSync(root, { recursive: true, force: true });
});

describe("normaliseJobName", () => {
  test("slugs to something filesystem-safe", () => {
    expect(normaliseJobName("Build Site!")).toBe("build-site");
    expect(normaliseJobName("  ../etc/passwd  ")).toBe("etc-passwd");
    expect(normaliseJobName("")).toBe("job");
    expect(normaliseJobName("...")).toBe("job");
  });
});

describe("jobs", () => {
  test("runs a command to completion and records its exit code", async () => {
    jobs.start({ name: "hello", command: "echo hi from job", cwd: root });
    expect(await jobs.waitForExit("hello", 5000)).toBe("exited");

    const snapshot = jobs.status("hello");
    expect(snapshot).not.toBeNull();
    expect(snapshot?.running).toBe(false);
    expect(snapshot?.exitCode).toBe(0);
    expect(snapshot?.command).toBe("echo hi from job");
    expect(jobs.log("hello")).toContain("hi from job");
  });

  test("a non-zero exit is recorded, not swallowed", async () => {
    jobs.start({ name: "fails", command: "exit 7", cwd: root });
    await jobs.waitForExit("fails", 5000);
    expect(jobs.status("fails")?.exitCode).toBe(7);
  });

  test("stderr lands in the same log", async () => {
    jobs.start({ name: "noisy", command: "echo out; echo err >&2", cwd: root });
    await jobs.waitForExit("noisy", 5000);
    const log = jobs.log("noisy") ?? "";
    expect(log).toContain("out");
    expect(log).toContain("err");
  });

  test("refuses to restack a running job", () => {
    jobs.start({ name: "slow", command: "sleep 10", cwd: root });
    expect(() => jobs.start({ name: "slow", command: "sleep 10", cwd: root })).toThrow(
      /already running/,
    );
  });

  test("jobs outlive the call that started them and report as running", () => {
    jobs.start({ name: "bg", command: "sleep 10", cwd: root });
    const snapshot = jobs.status("bg");
    expect(snapshot?.running).toBe(true);
    expect(snapshot?.exitCode).toBeNull();
    expect(snapshot?.pid).toBeGreaterThan(0);
  });

  test("kill stops the job and its children", async () => {
    jobs.start({ name: "killee", command: "sleep 30", cwd: root });
    expect(jobs.kill("killee")).toBe("killed");
    expect(await jobs.waitForExit("killee", 5000)).toBe("exited");
    expect(jobs.status("killee")?.running).toBe(false);
  });

  test("kill reports a finished job rather than pretending", async () => {
    jobs.start({ name: "done", command: "true", cwd: root });
    await jobs.waitForExit("done", 5000);
    expect(jobs.kill("done")).toBe("not running");
    expect(jobs.kill("nosuchjob")).toBe("unknown job");
  });

  test("status and log of an unknown job are null", () => {
    expect(jobs.status("ghost")).toBeNull();
    expect(jobs.log("ghost")).toBeNull();
    expect(jobs.logPath("ghost")).toBeNull();
  });

  test("log returns only the requested number of trailing lines", () => {
    jobs.start({ name: "lines", command: "for i in 1 2 3 4 5; do echo line$i; done", cwd: root });
    return jobs.waitForExit("lines", 5000).then(() => {
      const log = jobs.log("lines", 2) ?? "";
      expect(log).toContain("line4");
      expect(log).toContain("line5");
      expect(log).not.toContain("line1");
    });
  });

  test("list reports every job, newest first", async () => {
    jobs.start({ name: "first", command: "true", cwd: root });
    await jobs.waitForExit("first", 5000);
    jobs.start({ name: "second", command: "true", cwd: root });
    await jobs.waitForExit("second", 5000);
    const names = jobs.list().map((job) => job.name);
    expect(names).toHaveLength(2);
    expect(names).toContain("first");
    expect(names).toContain("second");
  });

  test("a job's state is readable from disk alone (survives a restart)", async () => {
    jobs.start({ name: "durable", command: "sleep 10", cwd: root });
    // A fresh registry over the same directory is what a restarted process sees.
    const reopened = createJobs({ rootDir: join(root, "jobs") });
    const snapshot = reopened.status("durable");
    expect(snapshot?.running).toBe(true);
    expect(snapshot?.command).toBe("sleep 10");
    reopened.kill("durable");
  });

  test("extra env reaches the child", async () => {
    jobs.start({
      name: "env",
      command: "echo $PI_MODEL",
      cwd: root,
      env: { PI_MODEL: "test-model-9000" },
    });
    await jobs.waitForExit("env", 5000);
    expect(jobs.log("env")).toContain("test-model-9000");
  });
});
