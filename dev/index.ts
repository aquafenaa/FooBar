import Anthropic from '@anthropic-ai/sdk';
import {
  REST, Routes, Client, GatewayIntentBits, Partials,
} from 'discord.js';
import path from 'node:path';

import { OpenAI } from 'openai';
import { getEncoding } from 'js-tiktoken';

import { commandMap } from './commands';
import clientEvents from './events';

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { DISCORD_TOKEN, CLIENT_ID, OPEN_ROUTER_KEY } = process.env;
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

async function startup() {
  const commands: any[] = [];

  commandMap.forEach((command) => {
    commands.push(command.data.toJSON());
  });

  await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
}

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions,
  ],
  // lets events fire for messages that aren't cached (e.g. sent before a restart), so deleting old messages is noticed.
  // these messages arrive partial: only their id, channel, and guild are known
  partials: [Partials.Message],
});

discordClient.login(DISCORD_TOKEN);

const localEncoder = getEncoding('o200k_base');
const openAIClient = new OpenAI();

const anthropicClient = new Anthropic({
  baseURL: 'https://openrouter.ai/api',
  apiKey: OPEN_ROUTER_KEY,
});

clientEvents(discordClient);
startup();

export { discordClient, openAIClient, anthropicClient, localEncoder };
