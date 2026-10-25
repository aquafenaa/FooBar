// direct messages with the bot's owner: only users listed in DM_USERS (in .env) can DM it, and they get full control.
// each DM is treated as a server of its own, keyed by its owner's user id, so everything per-server (settings, memories, summaries) just works.
// it starts attached, sharing the main context both ways, and the /private text command detaches it. /clear-summaries forgets its conversations.
// those two are text, rather than slash commands, so nobody else ever sees them. the DM's other settings have slash commands, in dmCommands.ts
import { Channel, ChannelType, DMChannel, Message, PartialDMChannel, Snowflake } from 'discord.js';
import cron from 'node-cron';

import { discordClient } from '..';
import { deleteConversation, getChatbot, getConversationSummariesBySource, getConversationsBySource, getDMServers, getServer, insertDMServer, upsertChatbot } from '../data';
import { ChatbotTable } from '../types/schema';
import { safeFetch } from '../utils';
import { MAIN_SOURCE } from './context';
import { SOURCE_SEPARATOR } from './conversation';

const DM_USERS = (process.env.DM_USERS ?? '').split(',').map((id) => id.trim()).filter(Boolean);

function isDMUser(userID: Snowflake): boolean {
  return DM_USERS.includes(userID);
}

// whether a "server" is really a DM with the bot. its id is its owner's user id
function isDMServer(serverID: Snowflake): boolean {
  return !!getServer(serverID)?.dm_user_id;
}

/**
 * Who a DM is with, other than the bot. A DM channel the bot only knows by its id doesn't know that yet, and asking discord.js
 * for its recipientId then throws, so it's fetched instead. Undefined if it still can't be told
 */
async function dmRecipient(channel: DMChannel | PartialDMChannel): Promise<Snowflake | undefined> {
  const botID = channel.client.user.id;
  const known = channel.recipientIds?.find((id) => id !== botID);
  if (known) return known;

  const fetched = await safeFetch(() => channel.fetch(true));
  return fetched?.recipientIds?.find((id) => id !== botID);
}

/**
 * A channel that reminders and heartbeats post in: one in that server, or for a DM, the DM with its owner.
 * Undefined if it can't be found, or is someone else's DM
 */
async function fetchServerChannel(serverID: Snowflake, channelID: Snowflake): Promise<Channel | undefined> {
  if (isDMServer(serverID)) {
    const channel = await safeFetch(() => discordClient.channels.fetch(channelID));
    return channel?.type === ChannelType.DM && (await dmRecipient(channel)) === serverID ? channel : undefined;
  }

  const guild = await safeFetch(() => discordClient.guilds.fetch(serverID));
  return (await safeFetch(() => guild!.channels.fetch(channelID))) ?? undefined;
}

/**
 * The DM's chatbot, made the first time its owner messages it or uses one of its commands: enabled, with tools, and attached,
 * so it shares the main context. Settings already changed are kept
 */
function ensureDMServer(userID: Snowflake): ChatbotTable {
  insertDMServer(userID);
  const existing = getChatbot(userID);
  if (existing) return existing;

  upsertChatbot({ server_id: userID, chatbot_enabled: true, tools_enabled: true, detached: false, chatbot_prompt: '' });
  return getChatbot(userID)!;
}

const plural = (count: number, singular: string, pluralForm = `${singular}s`) => `${count.toLocaleString()} ${count === 1 ? singular : pluralForm}`;

// /private: switches the DM between sharing memory with every attached server, and keeping it to itself
function togglePrivate(chatbot: ChatbotTable): string {
  chatbot.detached = !chatbot.detached;
  upsertChatbot(chatbot);
  return chatbot.detached
    ? '🔒 **Private.** New memories and summaries from this DM stay here, and I only see this DM\'s own. What was already shared stays shared. Send `/private` again to share.'
    : '🔓 **Shared.** This DM shares memories and summaries with every attached server again, both ways.';
}

/**
 * /clear-summaries: forgets every conversation in the user's DM, the one in progress too, along with their summaries, local and shared,
 * and their tool results. The Discord messages and the memories are kept. It only says what it would delete, unless it's confirmed.
 * It also covers DMs from before they were keyed by user id, which were keyed by the DM channel's id
 */
function clearSummaries(userID: Snowflake, confirmed: boolean): string {
  const dmServers = getDMServers().filter((server) => server.dm_user_id === userID).map((server) => server.server_id);
  const conversations = dmServers.flatMap((serverID) => getConversationsBySource(serverID));
  if (conversations.length === 0) return 'There\'s nothing to clear: this DM has no saved conversations or summaries.';

  // deleting a conversation also deletes its summaries, the local one and the copy shared with other servers
  const conversationIDs = new Set(conversations.map((conversation) => conversation.conversation_id));
  const summaryCount = dmServers
    .flatMap((serverID) => [...getConversationSummariesBySource(serverID), ...getConversationSummariesBySource(`${MAIN_SOURCE}${SOURCE_SEPARATOR}${serverID}`)])
    .filter((summary) => conversationIDs.has(summary.conversation_id)).length;
  const what = `**${plural(conversations.length, 'conversation')}** and **${plural(summaryCount, 'summary', 'summaries')}** from this DM, including the shared copies and the current conversation`;

  if (!confirmed) return `This deletes ${what}. Your messages and my memories are kept.\nSend \`/clear-summaries confirm\` to go ahead.`;

  // their pending "summarize once it expires" tasks too, since there'll be nothing left to summarize
  cron.getTasks().forEach((task) => {
    if (task.name && conversationIDs.has(task.name)) task.destroy();
  });
  conversations.forEach((conversation) => deleteConversation(conversation.conversation_id));
  return `🧹 Cleared ${what}. The next message starts a fresh conversation.`;
}

/**
 * Answers the DM text commands, returning whether the message was one: /private, and /clear-summaries (with "confirm" to go through with it).
 * They're text rather than slash commands, so nobody else ever sees them. Anything else is left for the bot to reply to as usual
 */
async function handleDMCommand(message: Message, chatbot: ChatbotTable): Promise<boolean> {
  const content = message.content.trim().toLowerCase();
  let reply: string;
  if (content === '/private') reply = togglePrivate(chatbot);
  else if (content === '/clear-summaries' || content === '/clear-summaries confirm') reply = clearSummaries(message.author.id, content.endsWith('confirm'));
  else return false;

  await message.reply({ content: reply, allowedMentions: { parse: [] } });
  return true;
}

export { isDMUser, isDMServer, dmRecipient, fetchServerChannel, ensureDMServer, handleDMCommand };
