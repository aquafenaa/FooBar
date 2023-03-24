/* eslint-disable no-console */
import {
  REST, Events, Routes, Client, GatewayIntentBits, TextChannel,
} from 'discord.js';
import * as fs from 'fs/promises';
import path from 'node:path';

import { commandMap } from './Commands';
import { Command, Config, Server } from './Types';

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { TOKEN, CLIENT_ID } = process.env;
const CONFIG_PATH = path.join(__dirname, '../config.json');
const rest = new REST({ version: '10' }).setToken(TOKEN!);

let configBeingChanged = false;

async function changeConfig(conf: Config) {
  configBeingChanged = true;
  await fs.writeFile(CONFIG_PATH, JSON.stringify(conf, null, 2));
  configBeingChanged = false;
}

async function readConfig(): Promise<Config> {
  if (configBeingChanged) {
    return new Promise((resolve) => {
      setTimeout(async () => {
        // eslint-disable-next-line no-plusplus
        resolve(await readConfig());
      }, 100);
    });
  }

  return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
}

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
});

client.on(Events.InteractionCreate, async (interaction) => {
  if (!interaction.isCommand()) return;

  const { commandName } = interaction;

  const command: Command = commandMap.get(commandName)!;

  if (!command) { console.log(`No command found! Command Name: ${commandName}`); return; }

  try {
    const config = await readConfig();
    const tempConfig = await command.execute(interaction, config);

    if (tempConfig) {
      await changeConfig(tempConfig);
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
  await changeConfig(config);
});

startup();
