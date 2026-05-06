/**
 * Slash command surface — registers /stop, /compact, /clear, /restart with
 * Discord and dispatches `interactionCreate` events to the shared handlers
 * in `./commands.ts`.
 *
 * Registration is guild-scoped (instant propagation, vs. up to 1h for
 * global commands). We register on `clientReady` for every guild already
 * joined, and on `guildCreate` for any new guild — so commands appear
 * immediately wherever the bot lives.
 *
 * Idempotent: PUT /applications/{app}/guilds/{g}/commands replaces the
 * whole set every call, so re-running leaves Discord in a known good
 * state without duplicates.
 *
 * Note on OAuth scope: this requires the bot to have been invited with
 * the `applications.commands` scope. Existing installs (invited with
 * just `bot`) need to re-authorize via the new invite URL — Discord
 * accepts incremental scope grants without removing the bot. See README.
 */
import type { Client, ChatInputCommandInteraction, Guild } from "discord.js";
import { MessageFlags, REST, Routes, SlashCommandBuilder } from "discord.js";
import type { AgentPool } from "./createAgentPool.ts";
import type { ActiveTracker } from "./active/createActiveTracker.ts";
import { commandDefinitions, runCommand, type CommandName } from "./commands.ts";

export function installSlashCommands(args: {
  client: Client;
  pool: AgentPool;
  tracker: ActiveTracker;
}): void {
  const { client, pool, tracker } = args;

  const commandBodies = commandDefinitions.map((def) =>
    new SlashCommandBuilder()
      .setName(def.name)
      .setDescription(def.description)
      .toJSON(),
  );

  client.once("clientReady", async (ready) => {
    const rest = new REST({ version: "10" }).setToken(ready.token);
    const guilds = [...ready.guilds.cache.values()];
    if (guilds.length === 0) {
      console.log("[slash] no guilds to register commands in yet");
      return;
    }
    await Promise.all(guilds.map((guild) => registerForGuild({ rest, guild, applicationId: ready.user.id, body: commandBodies })));
  });

  client.on("guildCreate", async (guild) => {
    if (!client.user) return;
    const rest = new REST({ version: "10" }).setToken(client.token ?? "");
    await registerForGuild({ rest, guild, applicationId: client.user.id, body: commandBodies });
  });

  client.on("interactionCreate", async (interaction) => {
    if (!interaction.isChatInputCommand()) return;
    if (!interaction.guildId) return; // DMs aren't supported

    const name = interaction.commandName;
    if (!isKnownCommand(name)) return;

    await runCommand(name, {
      channelId: interaction.channelId,
      client: interaction.client,
      pool,
      tracker,
      reply: async (message) => {
        // Ephemeral reply — visible only to the invoker, keeps the channel
        // uncluttered. Each command supplies its own short ack string with
        // an emoji marker + a few words on what happened.
        if (interaction.replied || interaction.deferred) return;
        await interaction
          .reply({ content: message, flags: MessageFlags.Ephemeral })
          .catch((error) => console.error(`[slash] reply failed: ${message}`, error));
      },
    });
  });
}

async function registerForGuild(args: {
  rest: REST;
  guild: Guild;
  applicationId: string;
  body: ReturnType<SlashCommandBuilder["toJSON"]>[];
}): Promise<void> {
  const { rest, guild, applicationId, body } = args;
  try {
    await rest.put(Routes.applicationGuildCommands(applicationId, guild.id), { body });
    console.log(`[slash] registered ${body.length} commands in guild ${guild.name} (${guild.id})`);
  } catch (error) {
    console.error(`[slash] register failed for guild ${guild.id}:`, error);
  }
}

function isKnownCommand(name: string): name is CommandName {
  return commandDefinitions.some((def) => def.name === name);
}
