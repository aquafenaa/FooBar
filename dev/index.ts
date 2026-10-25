import Anthropic from '@anthropic-ai/sdk';
import {
  REST, Routes, Client, GatewayIntentBits, Partials, InteractionContextType,
} from 'discord.js';

import { OpenAI } from 'openai';
import { getEncoding } from 'js-tiktoken';

import { commandMap } from './commands';
import { dmCommandMap } from './dmCommands';
import clientEvents from './events';

// .env is loaded by node itself (--env-file in package.json), before any import runs
const { DISCORD_TOKEN, CLIENT_ID, OPEN_ROUTER_KEY } = process.env;
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

async function startup() {
  const commands: any[] = [];

  // server commands only show in servers, and the DM ones only in DMs with the bot, where only its owner can use them
  commandMap.forEach((command) => {
    commands.push({ ...command.data.toJSON(), contexts: [InteractionContextType.Guild] });
  });
  dmCommandMap.forEach((command) => {
    commands.push({ ...command.data.toJSON(), contexts: [InteractionContextType.BotDM] });
  });

  await rest.put(Routes.applicationCommands(CLIENT_ID!), { body: commands });
}

const discordClient = new Client({
  intents: [
    GatewayIntentBits.Guilds, GatewayIntentBits.GuildMessages, GatewayIntentBits.MessageContent,
    GatewayIntentBits.GuildMembers, // privileged: lets the user tools list every member, rather than only cached ones
    GatewayIntentBits.GuildMessageTyping,
    GatewayIntentBits.GuildVoiceStates, GatewayIntentBits.GuildMessageReactions,
    GatewayIntentBits.DirectMessages, GatewayIntentBits.DirectMessageReactions, // DMs with the bot's owner (see chatbot/dm.ts)
  ],
  // lets events fire for messages that aren't cached (e.g. sent before a restart), so deleting old messages is noticed.
  // these messages arrive partial: only their id, channel, and guild are known.
  // Channel, since a DM channel is never cached until it's used, and its first message wouldn't arrive without it.
  // Reaction and User, so reacting 🗑️ to one of the bot's DM messages from before it started still deletes it
  partials: [Partials.Message, Partials.Channel, Partials.Reaction, Partials.User],
  allowedMentions: { parse: [ 'users', 'roles' ], repliedUser: true }, // disallows @everyone & @here by default, but still pings whoever is replied to
});

discordClient.login(DISCORD_TOKEN);

const localEncoder = getEncoding('o200k_base');
const openAIClient = new OpenAI();

const anthropicClient = new Anthropic({
  baseURL: 'https://openrouter.ai/api',
  apiKey: OPEN_ROUTER_KEY,
});

// a failed Discord call that nothing waited on (e.g. no permission in a channel) is logged, rather than crashing the whole bot
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

clientEvents(discordClient);
startup();

export { discordClient, openAIClient, anthropicClient, localEncoder };
