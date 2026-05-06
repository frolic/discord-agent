/**
 * Entry point — composition root. Constructs the active-state tracker
 * once, threads it through the pool, the router, and the recovery
 * dispatcher, then logs in. All complexity lives in the sibling modules;
 * this file just wires them together.
 */
import { resolve } from "node:path";
import { Client, GatewayIntentBits } from "discord.js";
import { config } from "./config.ts";
import { installRouter } from "./installRouter.ts";
import { installSlashCommands } from "./installSlashCommands.ts";
import { createAgentPool } from "./createAgentPool.ts";
import { createActiveTracker } from "./active/createActiveTracker.ts";
import { recoverActive } from "./active/recoverActive.ts";
import { postDebugLine } from "./io/postDebugLine.ts";

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.MessageContent,
  ],
  // discord.js fetches the WebSocket gateway URL from the REST API, so
  // overriding `rest.api` redirects both REST and gateway traffic. Use
  // when discord.com is blocked from the host (e.g. some AWS ranges) —
  // see `DISCORD_API_URL` in the .env reference.
  ...(config.discordApiUrl ? { rest: { api: config.discordApiUrl } } : {}),
});

const tracker = createActiveTracker({ activeStateFile: resolve(config.agentDir, "active.json") });
const pool = createAgentPool({ client, tracker });
installRouter({ client, pool, tracker });
installSlashCommands({ client, pool, tracker });

client.once("clientReady", async (readyClient) => {
  console.log(`discord-agent online as ${readyClient.user.tag} — agentDir: ${config.agentDir}`);
  await postDebugLine({ client, content: "-# 🟢 online" });
  await recoverActive({ pool, tracker });
});

async function shutdown(signal: string): Promise<void> {
  console.log(`${signal} received, shutting down`);
  // Best-effort post — don't block exit if the channel is unreachable
  // or discord.js is mid-teardown. The post races against client.destroy()
  // below; whichever wins, the process still exits.
  await postDebugLine({ client, content: `-# 🔴 offline — exiting on ${signal}` }).catch(() => {});
  client.destroy();
  process.exit(0);
}
process.on("SIGINT", () => shutdown("SIGINT"));
process.on("SIGTERM", () => shutdown("SIGTERM"));

// discord.js auto-reads process.env.DISCORD_TOKEN — see src/config.ts.
await client.login();
