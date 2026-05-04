#!/usr/bin/env bun
/**
 * Agent entry point. Cwd must be an agent home with a populated `.env`
 * (Bun auto-loads it). If required env is missing, exit with a pointer
 * to the setup wizard rather than running it inline — `bun run setup`
 * is the one and only path that creates an agent home.
 */
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const missing = missingRequiredEnv();
if (missing.length > 0) {
  const sourceDir = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
  console.error(
    `discord-agent: missing required env (${missing.join(", ")}) in ${process.cwd()}.\n` +
      `Run the setup wizard from the framework repo:\n` +
      `  cd ${sourceDir} && bun run setup`,
  );
  process.exit(1);
}

await import("../index.ts");

function missingRequiredEnv(): string[] {
  const missing: string[] = [];
  if (!process.env.DISCORD_TOKEN) missing.push("DISCORD_TOKEN");
  // Any `*_API_KEY` env var counts — pi resolves the matching provider
  // automatically.
  if (!Object.keys(process.env).some((name) => name.endsWith("_API_KEY"))) {
    missing.push("<PROVIDER>_API_KEY");
  }
  return missing;
}
