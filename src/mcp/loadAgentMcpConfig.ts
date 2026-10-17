/**
 * Reads `<agentDir>/mcp.json` for the MCP extension.
 *
 * pi's MCP extension ships a loader, but it isn't part of the package's public
 * exports, and its default resolves the config against `getAgentDir()` (the
 * global `~/.pi/agent`) because the extension context carries no `agentDir`.
 * This harness runs with its own agentDir (`config.agentDir`), so it supplies
 * this loader instead — otherwise servers declared next to the bot's settings
 * would be invisible.
 *
 * `loadConfig` is synchronous by contract, hence the sync read. Shape mirrors
 * pi's `LoadedMcpConfig`: enabled and disabled servers are both returned
 * (`enabled: false` keeps an entry listed), and problems are collected in
 * `errors` rather than thrown, so one bad entry can't take the rest down.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import type {
  LoadedMcpConfig,
  McpExposure,
  McpServerConfig,
  McpServerEntry,
} from "@earendil-works/pi-coding-agent";

/** The HTTP and stdio variants of pi's server config (not re-exported by name). */
type HttpServerConfig = Extract<McpServerConfig, { url: string }>;
type StdioServerConfig = Extract<McpServerConfig, { command: string }>;
type OauthConfig = NonNullable<HttpServerConfig["oauth"]>;

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return null;
  return value as JsonObject;
}

function stringRecord(value: unknown): Record<string, string> | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const out: Record<string, string> = {};
  for (const [key, entry] of Object.entries(record)) {
    if (typeof entry === "string") out[key] = entry;
  }
  return out;
}

function stringArray(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === "string");
}

function readExposure(value: unknown): McpExposure | undefined {
  if (value === "codemode" || value === "deferred" || value === "direct" || value === "hidden") return value;
  return undefined;
}

function readToolExposure(value: unknown): Record<string, McpExposure> | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const out: Record<string, McpExposure> = {};
  for (const [tool, exposure] of Object.entries(record)) {
    const parsed = readExposure(exposure);
    if (parsed) out[tool] = parsed;
  }
  return out;
}

function readOauth(value: unknown): OauthConfig | undefined {
  const record = asObject(value);
  if (!record) return undefined;
  const oauth: OauthConfig = {};
  if (typeof record.clientId === "string") oauth.clientId = record.clientId;
  if (typeof record.clientSecret === "string") oauth.clientSecret = record.clientSecret;
  if (typeof record.scope === "string") oauth.scope = record.scope;
  if (Array.isArray(record.scopes)) {
    const scopes = stringArray(record.scopes);
    if (scopes) oauth.scope = scopes.join(" ");
  }
  return oauth;
}

/** Shared settings both server kinds accept. */
interface CommonServerConfig {
  exposure?: McpExposure;
  description?: string;
  toolExposure?: Record<string, McpExposure>;
  enabled?: boolean;
  timeout?: number;
}

function readCommon(record: JsonObject): CommonServerConfig {
  const common: CommonServerConfig = {};
  const exposure = readExposure(record.exposure);
  if (exposure) common.exposure = exposure;
  if (typeof record.description === "string") common.description = record.description;
  const toolExposure = readToolExposure(record.toolExposure);
  if (toolExposure) common.toolExposure = toolExposure;
  if (typeof record.enabled === "boolean") common.enabled = record.enabled;
  if (typeof record.timeout === "number") common.timeout = record.timeout;
  return common;
}

/** Build a typed server config, or null when the entry names neither transport. */
function toServerConfig(raw: unknown): McpServerConfig | null {
  const record = asObject(raw);
  if (!record) return null;
  const common = readCommon(record);

  if (typeof record.url === "string") {
    const http: HttpServerConfig = { ...common, url: record.url };
    const headers = stringRecord(record.headers);
    if (headers) http.headers = headers;
    const oauth = readOauth(record.oauth);
    if (oauth) http.oauth = oauth;
    return http;
  }

  if (typeof record.command === "string") {
    const stdio: StdioServerConfig = { ...common, command: record.command };
    const args = stringArray(record.args);
    if (args) stdio.args = args;
    const env = stringRecord(record.env);
    if (env) stdio.env = env;
    if (typeof record.cwd === "string") stdio.cwd = record.cwd;
    return stdio;
  }

  return null;
}

export function loadAgentMcpConfig(agentDir: string): LoadedMcpConfig {
  const path = join(agentDir, "mcp.json");

  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    // A missing file is the normal case: MCP is optional.
    if ((error as { code?: string }).code === "ENOENT") return { servers: [], errors: [] };
    const message = error instanceof Error ? error.message : String(error);
    return { servers: [], errors: [`${path}: ${message}`] };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { servers: [], errors: [`${path}: invalid JSON (${message})`] };
  }

  const root = asObject(parsed);
  if (!root) return { servers: [], errors: [`${path}: expected a JSON object`] };

  const declared = root.mcpServers;
  if (declared === undefined) return { servers: [], errors: [] };
  const declaredObject = asObject(declared);
  if (!declaredObject) return { servers: [], errors: [`${path}: "mcpServers" must be an object`] };

  const servers: McpServerEntry[] = [];
  const errors: string[] = [];
  for (const [name, raw] of Object.entries(declaredObject)) {
    const config = toServerConfig(raw);
    if (!config) {
      errors.push(`${path}: server "${name}" needs a "command" or a "url"`);
      continue;
    }
    servers.push({ name, config, source: path, scope: "global" });
  }
  return { servers, errors };
}
