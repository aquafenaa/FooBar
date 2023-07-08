/* eslint-disable no-console */
import {
  REST, Events, Routes, Client, GatewayIntentBits, TextChannel,
} from 'discord.js';
import path from 'node:path';

import { commandMap, startPlayer } from './commands';
import { Command, Server } from './types';
import { readConfig, writeConfig } from './data';

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { TOKEN, CLIENT_ID } = process.env;
const rest = new REST({ version: '10' }).setToken(TOKEN!);

async function startup() {
  const commands: any[] = [];

  commandMap.forEach((command) => {
    commands.push(command.data.toJSON());
  });

  await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
}

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.GuildVoiceStates,
  ],
});

client.login(TOKEN);

client.on('ready', () => {
  console.log(`Client logged in as ${client.user?.tag}!`);
  startPlayer(client);
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  const command: Command = commandMap.get(commandName)!;

  if (!command) { return; }

  try {
    const config = await readConfig();
    const tempConfig = await command.execute(interaction, config);
    if (tempConfig) {
      await writeConfig(tempConfig);
    }
  } catch (error) {
    console.error(error);
    await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
  }
});

client.on('voiceStateUpdate', async (oldState, newState) => {
  const config = await readConfig();
  const server = config?.servers?.find((s) => s.id === newState.guild?.id);

  if (!server || !server.voicePing.enabled) return;

  if (oldState.channelId == null && server.voicePing.inputChannels.find((id) => id === newState.channelId)
    && newState.channel?.members.size === 1) {
    const index = server.voicePing.inputChannels.findIndex((id) => id === newState.channelId);
    const channel: TextChannel | undefined = client.channels.cache.get(config.servers[index].voicePing.outputChannel) as TextChannel;
    const { voicePingMessage } = server.voicePing;

    if (channel) {
      channel.send(voicePingMessage.replace('{user}', `<@${newState.member?.user.id!}>`).replace('{channel}', `<#${newState.channelId!}>`));
    }
  }
});

// Create a base config when joining a new server
client.on('guildCreate', async (guild) => {
  const server: Server = {
    id: guild.id,
    voicePing: {
      enabled: false,
      voicePingMessage: 'Welcome to the voice channel, {user}',
      inputChannels: [],
      outputChannel: '',
    },
  };

  const config = await readConfig();

  config.servers.push(server);
  await writeConfig(config);
});

startup();
