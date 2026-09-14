import {
  REST, Routes, Client, GatewayIntentBits,
} from 'discord.js';
import path from 'node:path';

import { commandMap } from './commands';
import clientEvents from './events';

require('dotenv').config({ path: path.join(__dirname, '../.env') });

const { DISCORD_TOKEN, CLIENT_ID } = process.env;
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
});

discordClient.login(DISCORD_TOKEN);

clientEvents(discordClient);
startup();
