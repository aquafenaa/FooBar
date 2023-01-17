/* eslint-disable no-console */
import {
  REST, Events, Routes, Client, GatewayIntentBits, TextChannel,
} from 'discord.js';
import * as fs from 'fs/promises';

import * as Commands from './Commands';
import { Command, Config, Server } from './Types';

require('dotenv').config();

const { TOKEN, CLIENT_ID } = process.env;
const CONFIG_PATH = './config.json';
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
        resolve(await readConfig());
      }, 100);
    });
  }

  return JSON.parse(await fs.readFile(CONFIG_PATH, 'utf8'));
}

async function startup() {
  const commands = [
    Commands.Help.data.toJSON(),
    Commands.VoicePing.data.toJSON(),
  ];

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

  const command: Command = Commands.commandMap.get(commandName)!;

  if (!command) { return; }

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
    const channel: TextChannel | undefined = client.channels.cache.get('920071596469788772') as TextChannel;
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

// Remove server from config when bot is removed from server
client.on('guildDelete', async (guild) => {
  const config = await readConfig();
  config.servers = config.servers.filter((s) => s.id !== guild.id);
  await changeConfig(config);
});

startup();
