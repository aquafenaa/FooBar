import { OpenRouter } from '@openrouter/sdk';
import {
  REST, Routes, Client, GatewayIntentBits, Partials, InteractionContextType,
} from 'discord.js';

import { getEncoding } from 'js-tiktoken';

import { commandMap, dmCommandMap } from './commands';
import clientEvents from './events';

// .env is loaded by node itself (--env-file in package.json), before any import runs
const { DISCORD_TOKEN, CLIENT_ID, OPEN_ROUTER_KEY } = process.env;
const rest = new REST({ version: '10' }).setToken(DISCORD_TOKEN!);

async function startup() {
  const commands: any[] = [];

  // only some also show in DMs with the bot, where only its owner can use them
  commandMap.forEach((command, name) => {
    commands.push({ ...command.data.toJSON(), contexts: dmCommandMap.has(name) ? [InteractionContextType.Guild, InteractionContextType.BotDM] : [InteractionContextType.Guild] });
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
const openRouter = new OpenRouter({
  apiKey: OPEN_ROUTER_KEY,
  // a brief hiccup at OpenRouter shouldn't fail a reply
  retryConfig: { strategy: 'backoff', backoff: { initialInterval: 500, maxInterval: 8_000, exponent: 2, maxElapsedTime: 30_000 }, retryConnectionErrors: true },
});

// a failed Discord call that nothing waited on (e.g. no permission in a channel) is logged, rather than crashing the whole bot
process.on('unhandledRejection', (error) => console.error('Unhandled rejection:', error));

clientEvents(discordClient);
startup();

export { discordClient, openRouter, localEncoder };
