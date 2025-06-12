import {
  REST, Routes, Client, GatewayIntentBits,
} from 'discord.js';
import path from 'node:path';

import OpenAI from 'openai';

import { commandMap } from './commands';
import clientEvents from './events';

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { DISCORD_TOKEN, CLIENT_ID, GROK_KEY } = process.env;
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

async function startup() {
  const commands: any[] = [];

  commandMap.forEach((command) => {
    commands.push(command.data.toJSON());
  });

  await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
}

const grokClient = new OpenAI({
  apiKey: GROK_KEY,
  baseURL: 'https://api.x.ai/v1',
});
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions,
  ],
});

client.login(DISCORD_TOKEN);

clientEvents(client, grokClient);
startup();
