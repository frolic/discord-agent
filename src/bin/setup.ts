#!/usr/bin/env bun
/**
 * Interactive first-run setup. Walks the user through creating a Discord
 * application, inviting it to a server, picking a model provider, and
 * laying down a fresh agent home with `.env`, persona templates, and an
 * optional systemd unit.
 *
 * Setup never starts the bot — it prepares the agent home and prints
 * the run command. Keep setup and runtime separate.
 *
 * No `MODEL_PROVIDER` / `MODEL_NAME` here — pi resolves the provider
 * from whichever `*_API_KEY` we write (auth-driven). Tune model defaults
 * in `<agent-home>/settings.json`; see
 * https://github.com/badlogic/pi-mono/blob/v0.72.1/packages/coding-agent/docs/settings.md
 */
import { copyFileSync, existsSync, mkdirSync, writeFileSync } from "node:fs";
import { homedir, userInfo } from "node:os";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import * as p from "@clack/prompts";
import { PermissionFlagsBits, PermissionsBitField, RateLimitError, REST, Routes } from "discord.js";
import type { APIUser } from "discord.js";
import pkg from "../../package.json" with { type: "json" };

interface ApiKeyChoice {
  label: string;
  envName: string;
}

const apiKeyChoices: ApiKeyChoice[] = [
  { label: "Anthropic", envName: "ANTHROPIC_API_KEY" },
  { label: "OpenAI", envName: "OPENAI_API_KEY" },
  { label: "DeepSeek", envName: "DEEPSEEK_API_KEY" },
  { label: "OpenRouter", envName: "OPENROUTER_API_KEY" },
  { label: "Google", envName: "GOOGLE_API_KEY" },
];

// Permissions the bot needs at install time. Mirrors the README list.
// Computed once at import; the integer is stable until this list changes.
const invitePermissions = new PermissionsBitField([
  PermissionFlagsBits.ViewChannel,
  PermissionFlagsBits.SendMessages,
  PermissionFlagsBits.SendMessagesInThreads,
  PermissionFlagsBits.CreatePublicThreads,
  PermissionFlagsBits.EmbedLinks,
  PermissionFlagsBits.AttachFiles,
  PermissionFlagsBits.ReadMessageHistory,
  PermissionFlagsBits.AddReactions,
  PermissionFlagsBits.UseExternalEmojis,
]).bitfield.toString();

const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const templateDir = resolve(sourceDir, "agent-template");
const repoUrl = pkg.repository.url;

interface DiscoveryResult {
  user: APIUser;
  apiBase: string | null;
  fallbackReason: string | null;
}

await runSetup();

async function runSetup(): Promise<void> {
  p.intro("🤖 discord-agent setup");

  // ── Step 1: Discord application ──────────────────────────────────────
  p.note(
    [
      "Open: https://discord.com/developers/applications",
      "  · New Application — the name becomes your bot's display name",
      "  · Bot tab → Reset Token → copy",
      "  · Bot tab → Privileged Gateway Intents → enable Message Content Intent → Save",
    ].join("\n"),
    "Step 1/4 · Create the Discord application",
  );

  const discovery = await promptForToken();

  // ── Step 2: invite the bot ───────────────────────────────────────────
  const inviteUrl = `https://discord.com/api/oauth2/authorize?client_id=${discovery.user.id}&scope=bot&permissions=${invitePermissions}`;
  p.note(
    [
      `Open this URL, pick a server, click Authorize:`,
      "",
      inviteUrl,
    ].join("\n"),
    `Step 2/4 · Invite "${discovery.user.username}" to your server`,
  );
  const invited = await p.confirm({
    message: "Bot added to your server?",
    initialValue: true,
  });
  cancelGuard(invited);
  if (!invited) {
    p.cancel("Add the bot first, then re-run `bun run setup`.");
    process.exit(1);
  }

  // ── Step 3: provider key ─────────────────────────────────────────────
  p.note(
    "Pi resolves the provider from whichever *_API_KEY is set. Switch later by editing .env.",
    "Step 3/4 · Model provider",
  );
  const apiKeyEnv = await p.select({
    message: "Which provider's API key will you use?",
    options: apiKeyChoices.map((entry) => ({ label: entry.label, value: entry.envName })),
  });
  cancelGuard(apiKeyEnv);
  const apiKey = await p.password({
    message: `${apiKeyEnv}:`,
    mask: "*",
  });
  cancelGuard(apiKey);

  // ── Step 4: agent home ───────────────────────────────────────────────
  const defaultHome = resolve(homedir(), "agents", sanitize(discovery.user.username));
  p.note(
    "Where this bot's persona, settings, sessions, and workspaces live. Kept outside the framework repo so the agent's state travels with the bot, not the source.",
    "Step 4/4 · Agent home directory",
  );
  const agentHomeInput = await p.text({
    message: "Agent home path:",
    initialValue: defaultHome,
    validate: (value) => (value && value.trim() ? undefined : "Path required"),
  });
  cancelGuard(agentHomeInput);
  const agentHome = expandHome(agentHomeInput.trim());

  if (existsSync(agentHome)) {
    const overwrite = await p.confirm({
      message: `${agentHome} already exists. Continue and write .env there?`,
      initialValue: false,
    });
    cancelGuard(overwrite);
    if (!overwrite) {
      p.cancel("Aborted — pick a different path and re-run.");
      process.exit(1);
    }
  } else {
    mkdirSync(agentHome, { recursive: true });
  }

  // Templates: SYSTEM.md and AGENTS.md ship the persona starting points;
  // .env.example is helpful for adding optional vars later.
  copyTemplate("SYSTEM.md", agentHome);
  copyTemplate("AGENTS.md", agentHome);
  copyTemplate(".env.example", agentHome);

  writeFileSync(
    resolve(agentHome, ".env"),
    buildEnvFile({
      discordToken: discovery.token,
      apiKeyEnv,
      apiKey,
      discordApiUrl: discovery.apiBase,
    }),
  );

  // ── Optional: systemd ────────────────────────────────────────────────
  let serviceFile: string | null = null;
  if (process.platform === "linux") {
    const wantService = await p.confirm({
      message: "Generate a systemd unit so the bot restarts on its own?",
      initialValue: true,
    });
    cancelGuard(wantService);
    if (wantService) {
      const serviceName = `${sanitize(discovery.user.username)}-discord-agent.service`;
      serviceFile = resolve(agentHome, serviceName);
      writeFileSync(serviceFile, renderServiceUnit({
        botName: discovery.user.username,
        agentHome,
        sourceDir,
        user: userInfo().username,
        bunPath: process.execPath,
      }));
    }
  }

  // ── Final summary ────────────────────────────────────────────────────
  const nextSteps = [
    `Agent home: ${agentHome}`,
    "",
    "To start the bot:",
    `  cd ${agentHome}`,
    `  bun ${sourceDir}/src/bin/agent.ts`,
  ];
  if (serviceFile) {
    nextSteps.push(
      "",
      "To run as a systemd service (requires sudo):",
      `  sudo cp ${serviceFile} /etc/systemd/system/`,
      `  sudo systemctl daemon-reload`,
      `  sudo systemctl enable --now ${serviceFile.split("/").pop()}`,
    );
  }
  nextSteps.push(
    "",
    `Edit ${agentHome}/SYSTEM.md to shape the bot's voice.`,
    `See ${repoUrl}/blob/main/docs/operating.md for the full operating guide.`,
  );
  p.note(nextSteps.join("\n"), "Done");
  p.outro("✓ setup complete");
}

async function promptForToken(): Promise<DiscoveryResult & { token: string }> {
  while (true) {
    const tokenRaw = await p.password({
      message: "Paste the bot token:",
      mask: "*",
    });
    cancelGuard(tokenRaw);
    const token = tokenRaw.trim();

    const spinner = p.spinner();
    spinner.start("Validating token with Discord");
    try {
      const result = await discoverBot(token);
      spinner.stop(`✓ token valid — bot is "${result.user.username}"`);
      if (result.apiBase) {
        p.log.info(
          `discord.com unreachable from this host (${result.fallbackReason}); using canary.discord.com instead.`,
        );
      }
      return { ...result, token };
    } catch (error) {
      spinner.stop("Token check failed");
      p.log.error(error instanceof Error ? error.message : String(error));
      const retry = await p.confirm({
        message: "Try again with a different token?",
        initialValue: true,
      });
      cancelGuard(retry);
      if (!retry) {
        p.cancel("Aborted.");
        process.exit(1);
      }
    }
  }
}

/**
 * Validate the bot token against Discord's REST API and return the bot's
 * identity. If the primary domain isn't usable from this host (network
 * blocked, or rate-limited with an absurd retry-after — common on cloud
 * VMs hitting discord.com from a shared IP range), fall back to
 * canary.discord.com so cloud-hosted setups don't need a separate manual
 * workaround.
 *
 * `rejectOnRateLimit: () => true` is what makes this work — without it,
 * discord.js queues the request and waits for the retry-after window
 * before retrying, which can be tens of thousands of seconds. With it,
 * 429s throw `RateLimitError` immediately and we can switch hosts.
 */
async function discoverBot(token: string): Promise<DiscoveryResult> {
  const primary = "https://discord.com/api";
  const canary = "https://canary.discord.com/api";
  try {
    const user = await fetchSelf(token, primary);
    return { user, apiBase: null, fallbackReason: null };
  } catch (error) {
    if (isAuthError(error)) throw new Error(formatAuthError(error));
    const reason = describeFallbackReason(error);
    try {
      const user = await fetchSelf(token, canary);
      return { user, apiBase: canary, fallbackReason: reason };
    } catch (canaryError) {
      if (isAuthError(canaryError)) throw new Error(formatAuthError(canaryError));
      throw new Error(
        `Could not reach Discord on either discord.com or canary.discord.com. ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function fetchSelf(token: string, api: string): Promise<APIUser> {
  const rest = new REST({
    version: "10",
    api,
    // Throw `RateLimitError` instead of waiting out the retry-after window.
    // discord.com sometimes returns multi-hour retry-afters to cloud IP
    // ranges, which would otherwise hang the wizard indefinitely.
    rejectOnRateLimit: () => true,
  }).setToken(token);
  return (await rest.get(Routes.user())) as APIUser;
}

function describeFallbackReason(error: unknown): string {
  if (error instanceof RateLimitError) {
    return `rate-limited, retry-after ${Math.round(error.retryAfter / 1000)}s`;
  }
  return error instanceof Error ? error.message : String(error);
}

function isAuthError(error: unknown): boolean {
  if (typeof error !== "object" || error === null) return false;
  const status = (error as { status?: unknown }).status;
  return status === 401 || status === 403;
}

function formatAuthError(error: unknown): string {
  const status = (error as { status?: number }).status;
  return `Discord rejected the token (HTTP ${status}). Reset the token in the developer portal and try again.`;
}

function buildEnvFile(input: {
  discordToken: string;
  apiKeyEnv: string;
  apiKey: string;
  discordApiUrl: string | null;
}): string {
  const lines = [
    `DISCORD_TOKEN=${input.discordToken}`,
    `${input.apiKeyEnv}=${input.apiKey}`,
  ];
  if (input.discordApiUrl) {
    lines.push(`DISCORD_API_URL=${input.discordApiUrl}`);
  }
  return `${lines.join("\n")}\n`;
}

function renderServiceUnit(input: {
  botName: string;
  agentHome: string;
  sourceDir: string;
  user: string;
  bunPath: string;
}): string {
  return `# systemd unit for discord-agent — generated by \`bun run setup\`.
#
# StartLimitIntervalSec=0 disables the default restart rate limit (5/10s),
# which a tight self-edit loop can trip. Restart=always covers the clean
# process.exit(0) the agent uses when self-restarting.

[Unit]
Description=discord-agent (${input.botName})
After=network-online.target
Wants=network-online.target
StartLimitIntervalSec=0

[Service]
Type=simple
User=${input.user}
WorkingDirectory=${input.agentHome}
EnvironmentFile=${input.agentHome}/.env
ExecStart=${input.bunPath} ${input.sourceDir}/src/bin/agent.ts
Restart=always
RestartSec=2
StandardOutput=journal
StandardError=journal

# Hardening
NoNewPrivileges=true
ProtectSystem=strict
ProtectHome=read-only
# Two write paths: agent home (sessions, workspaces) AND source repo (so
# the agent can edit its own framework code via bash/edit/write).
ReadWritePaths=${input.agentHome} ${input.sourceDir}
PrivateTmp=true

[Install]
WantedBy=multi-user.target
`;
}

function copyTemplate(name: string, agentHome: string): void {
  const src = resolve(templateDir, name);
  const dest = resolve(agentHome, name);
  if (existsSync(dest)) return;
  copyFileSync(src, dest);
}

function expandHome(input: string): string {
  if (input === "~") return homedir();
  if (input.startsWith("~/")) return resolve(homedir(), input.slice(2));
  return resolve(input);
}

/** Reduce a Discord username to a path-safe slug. */
function sanitize(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "discord-agent";
}

/** Clack returns a Symbol on Ctrl-C / Esc; bail cleanly when that happens. */
function cancelGuard<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(1);
  }
}
