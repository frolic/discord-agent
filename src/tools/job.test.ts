import { describe, expect, test } from "bun:test";
import { createJobTool } from "./job.ts";

function toolParams() {
  const tool = createJobTool();
  return { tool, schema: tool.parameters };
}

describe("job tool", () => {
  test("exposes expected actions", () => {
    const { schema } = toolParams();
    // The TypeBox schema encodes the action union — verify the literals made it in.
    const str = JSON.stringify(schema);
    expect(str).toContain('"start"');
    expect(str).toContain('"status"');
    expect(str).toContain('"log"');
    expect(str).toContain('"kill"');
    expect(str).toContain('"list"');
  });

  test("start requires name + command", async () => {
    const { tool } = toolParams();
    expect(() =>
      // @ts-expect-error exercising validation path directly
      tool.execute("c1", { action: "start", name: "x" }),
    ).toThrow("start requires name + command");
  });

  test("status/log/kill require a name", async () => {
    const { tool } = toolParams();
    for (const action of ["status", "log", "kill"]) {
      expect(() =>
        // @ts-expect-error exercising validation path directly
        tool.execute("c1", { action }),
      ).toThrow(`${action} requires a job name`);
    }
  });

  test("list does not require a name", async () => {
    const { tool } = toolParams();
    // Should reach execFile (which may fail if job.sh missing) rather than
    // throwing the name-required error — verify the error is NOT the guard.
    const result = await tool
      // @ts-expect-error exercising validation path directly
      .execute("c1", { action: "list" })
      .then(() => "ok")
      .catch((error: Error) => error.message);
    expect(result).not.toContain("requires a job name");
  });
});