import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadAgentMcpConfig } from "./loadAgentMcpConfig.ts";

function dirWith(mcpJson: string | null): string {
  const dir = mkdtempSync(join(tmpdir(), "mcp-config-"));
  if (mcpJson !== null) writeFileSync(join(dir, "mcp.json"), mcpJson);
  return dir;
}

/** The single server a one-server config is expected to yield. Throws rather than
 *  handing the assertions an undefined (tsconfig runs `noUncheckedIndexedAccess`). */
function onlyServer(loaded: ReturnType<typeof loadAgentMcpConfig>) {
  const [server] = loaded.servers;
  if (!server) throw new Error(`expected one server, got ${loaded.servers.length}`);
  return server;
}

describe("loadAgentMcpConfig", () => {
  test("a missing mcp.json is not an error", () => {
    const loaded = loadAgentMcpConfig(dirWith(null));
    expect(loaded.servers).toEqual([]);
    expect(loaded.errors).toEqual([]);
  });

  test("reads an HTTP server with exposure and description", () => {
    const loaded = loadAgentMcpConfig(
      dirWith(
        JSON.stringify({
          mcpServers: {
            spec: {
              url: "https://mcp.example.com/mcp",
              exposure: "direct",
              description: "spec server",
              timeout: 30,
            },
          },
        }),
      ),
    );
    expect(loaded.errors).toEqual([]);
    expect(loaded.servers).toHaveLength(1);
    const server = onlyServer(loaded);
    expect(server.name).toBe("spec");
    expect(server.scope).toBe("global");
    expect(server.config).toMatchObject({
      url: "https://mcp.example.com/mcp",
      exposure: "direct",
      description: "spec server",
      timeout: 30,
    });
  });

  test("reads a stdio server with args and env", () => {
    const loaded = loadAgentMcpConfig(
      dirWith(
        JSON.stringify({
          mcpServers: { fs: { command: "npx", args: ["-y", "server-fs", "."], env: { TOKEN: "${T}" } } },
        }),
      ),
    );
    expect(loaded.servers).toHaveLength(1);
    expect(onlyServer(loaded).config).toMatchObject({
      command: "npx",
      args: ["-y", "server-fs", "."],
      env: { TOKEN: "${T}" },
    });
  });

  test("keeps a disabled server listed", () => {
    const loaded = loadAgentMcpConfig(
      dirWith(JSON.stringify({ mcpServers: { off: { url: "https://x.test/mcp", enabled: false } } })),
    );
    expect(loaded.servers).toHaveLength(1);
    expect(onlyServer(loaded).config).toMatchObject({ enabled: false });
  });

  test("reports an entry with neither command nor url, and keeps the rest", () => {
    const loaded = loadAgentMcpConfig(
      dirWith(
        JSON.stringify({
          mcpServers: { broken: { exposure: "direct" }, good: { url: "https://ok.test/mcp" } },
        }),
      ),
    );
    expect(loaded.servers.map((server) => server.name)).toEqual(["good"]);
    expect(loaded.errors).toHaveLength(1);
    expect(loaded.errors[0] ?? "").toContain("broken");
  });

  test("invalid JSON is reported, not thrown", () => {
    const loaded = loadAgentMcpConfig(dirWith("{ not json"));
    expect(loaded.servers).toEqual([]);
    expect(loaded.errors[0] ?? "").toContain("invalid JSON");
  });

  test("ignores non-string args and env values instead of failing", () => {
    const loaded = loadAgentMcpConfig(
      dirWith(
        JSON.stringify({
          mcpServers: { fs: { command: "node", args: ["a", 7, null], env: { GOOD: "1", BAD: 2 } } },
        }),
      ),
    );
    expect(onlyServer(loaded).config).toMatchObject({ args: ["a"], env: { GOOD: "1" } });
  });
});
