import {
  REST, Routes, Client, GatewayIntentBits,
} from 'discord.js';
import path from 'node:path';

import { Ollama } from 'ollama';

import { commandMap } from './commands';
import clientEvents from './events';

// require('dotenv').config({ path: path.join(__dirname, '../.env') }); // main config
require('dotenv').config({ path: path.join(__dirname, '../testing.env') }); // testing config

const { TOKEN, CLIENT_ID } = process.env;
const rest = new REST({ version: '10' }).setToken(TOKEN!);

async function startup() {
  const commands: any[] = [];

  commandMap.forEach((command) => {
    commands.push(command.data.toJSON());
  });

  await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
}

const grokClient = new Ollama({ host: 'http://127.0.0.1:11434' });
const client = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions,
  ],
});

client.login(TOKEN);

clientEvents(client, grokClient);
startup();
