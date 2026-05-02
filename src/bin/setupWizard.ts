/**
 * Interactive first-run setup. Prompts for the required env vars and
 * writes an `.env` file in cwd. Skipped entirely if env is already
 * complete. Uses `@clack/prompts` for the styled multi-step UX.
 *
 * The wizard is the friendly path; the README still documents the manual
 * `cp -r example-agent <agent-home>` flow for those who prefer to start
 * from a fuller template.
 *
 * No `MODEL_PROVIDER` / `MODEL_NAME` here — pi resolves the provider
 * from whichever `*_API_KEY` we write (auth-driven). Tune model defaults
 * in `<agent-home>/settings.json`; see
 * https://github.com/badlogic/pi-mono/blob/v0.72.1/packages/coding-agent/docs/settings.md
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import * as p from "@clack/prompts";

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

export async function runSetupWizard(): Promise<void> {
  p.intro("🤖 First-run setup");

  const discordToken = await p.password({
    message: "Discord bot token (Bot → Reset Token):",
    mask: "*",
  });
  cancelGuard(discordToken);

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

  const wantDebugChannel = await p.confirm({
    message: "Cross-post operational logs (tool calls, lifecycle, etc.) to a separate debug channel?",
    initialValue: false,
  });
  cancelGuard(wantDebugChannel);

  let debugChannelId = "";
  if (wantDebugChannel) {
    const id = await p.text({
      message: "Debug channel ID:",
    });
    cancelGuard(id);
    debugChannelId = id;
  }

  const envPath = resolve(".env");
  if (existsSync(envPath)) {
    const overwrite = await p.confirm({
      message: ".env already exists. Overwrite?",
      initialValue: false,
    });
    cancelGuard(overwrite);
    if (!overwrite) {
      p.cancel("Aborted — keeping existing .env. Edit it manually if needed.");
      process.exit(1);
    }
  }

  const lines = [
    `DISCORD_TOKEN=${discordToken}`,
    `${apiKeyEnv}=${apiKey}`,
  ];
  if (debugChannelId) lines.push(`DEBUG_CHANNEL_ID=${debugChannelId}`);

  writeFileSync(envPath, `${lines.join("\n")}\n`);

  // Inject into the running process so the bot starts without a restart.
  for (const line of lines) {
    const equalsIndex = line.indexOf("=");
    process.env[line.slice(0, equalsIndex)] = line.slice(equalsIndex + 1);
  }

  p.outro(`✓ wrote ${envPath} — starting the bot...`);
}

/** Clack returns a Symbol on Ctrl-C / Esc; bail cleanly when that happens. */
function cancelGuard<T>(value: T | symbol): asserts value is T {
  if (p.isCancel(value)) {
    p.cancel("Setup cancelled.");
    process.exit(1);
  }
}
