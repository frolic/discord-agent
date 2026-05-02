#!/usr/bin/env bun
/**
 * Agent entry point. Bootstraps the cwd:
 *   1. If required env is missing, run the interactive setup wizard
 *      (writes `.env` in cwd).
 *   2. Create a default `SYSTEM.md` if missing — pi auto-discovers it
 *      from agentDir, no path config needed.
 *   3. Run the harness.
 *
 * Bun auto-loads `.env` from cwd, so on subsequent runs env vars come
 * from `<agent-home>/.env` automatically.
 */
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { runSetupWizard } from "./setupWizard.ts";

if (missingRequiredEnv().length > 0) {
  await runSetupWizard();
}
ensureSystemPrompt();

// Dynamic import so wizard + SYSTEM.md bootstrap finish before
// config.ts loads (config validates env at import time).
await import("../index.ts");

function missingRequiredEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  // Any `*_API_KEY` env var counts — pi resolves the matching provider
  // automatically. We don't need to know which provider here; the wizard
  // would only run when nothing's set, in which case we ask the user.
  if (!Object.keys(process.env).some((name) => name.endsWith("_API_KEY"))) {
    missing.push("<PROVIDER>_API_KEY");
  }
  return missing;
}

function ensureSystemPrompt(): void {
  const path = resolve("SYSTEM.md");
  if (existsSync(path)) return;
  writeFileSync(
    path,
    "You are a teammate in a Discord server. Talk like a person, not a bot. Keep replies concise unless the work demands depth.\n",
  );
  console.log(
    "[bootstrap] created SYSTEM.md — edit it to define your bot's voice and behavior",
  );
}
