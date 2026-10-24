import path from 'node:path';
import { ChannelType, Guild, GuildChannel, GuildTextBasedChannel, Message, MessageMentionOptions, SendableChannels, Snowflake } from 'discord.js';
import { ModelMessage, Tool } from 'ai';
import cron from 'node-cron';
import { z as zod } from 'zod';
import { Anthropic } from '@anthropic-ai/sdk';

import { MessageParam, OutputConfig, ServerToolUseBlock, ToolResultBlockParam, ToolUnion, ToolUseBlock } from '@anthropic-ai/sdk/resources';

import { existsSync, readFileSync } from 'fs';

import { getChatbot, getConversationByChannel, getConversationMessages, getConversationTokenCount, getIndexChannel, getIndexMessage, getIndexRole, getIndexUser, getNextChannelRef, getNextMessageRef, getNextRoleRef, getNextUserRef, getSubscribersAmong, insertConversationMessage, insertConversationToolResult, insertIndexChannel, insertIndexMessage, insertIndexRole, insertIndexUser, resolveChannelRef, resolveRoleRef, resolveUserRef, upsertConversation } from '../data';
import { ChatbotTable, ConversationMessageTable, ConversationTable, ConversationToolResultTable, HeartbeatTable } from '../types/schema';
import { estimateTokens, millisToCronSchedule, safeFetch, splitPoint, trackFence } from '../utils';
import { anthropicClient, discordClient, openAIClient } from '..';
import { endConversation, getRelevantSummaries, getVisibleToolResults, summarizeConversation } from './conversation';
import localTools from './tools';
import { getVisibleMemories, isAttached, isShareable } from './context';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_TEMPERATURE, supportsTools, temperatureFor } from './models';
import { isSandboxEnabled, readNotes } from './sandbox';
import { withCaptions } from './vision';

const promptPath = path.join(__dirname, '../../data/SYSTEM.md'); // two levels up: this file is in dev/chatbot/ (src/chatbot/ once built)
const { DISCORD_ID } = process.env;

const MAX_MESSAGE_LENGTH = 2000;
const PADDING_LENGTH = 8;
const MAX_TOOL_STEPS = 50; // number of model calls allowed per reply, when it keeps asking for tools
// only whitespace, or characters that show as nothing (zero-width spaces, the braille blank...)
const BLANK_MESSAGE = /^[\s\u200B-\u200D\u2060\uFEFF\u2800]*$/;
const MAX_TOOL_SYNOPSIS_LENGTH = 300; // characters of the line under the tool list, saying what they were used for
const HEARTBEAT_OK = 'HEARTBEAT_OK'; // what the model replies to a heartbeat with nothing worth posting
const DELETED_MEMORY_DURATION = 10 * 60_000; // 10 minutes, far longer than a reply takes to generate
const MAX_PROMPT_TOOL_RESULTS = 10; // most recent tool results given back to the model each reply
const MAX_PROMPT_TOOL_RESULT_LENGTH = 4000; // characters of each one. the full result stays in the database
const MAX_CONVERSATION_TOKENS = 10_000; // ~125 messages. past this, the conversation is summarized and a new one starts
const MESSAGE_BREAK_GAP = 60 * 60_000; // 1 hour. a longer silence between two messages is marked, so the model knows time has passed

// shown as each channel's type in the index, so the model knows what it can do there (e.g. threads can't hold threads)
const CHANNEL_TYPE_NAMES: Partial<Record<ChannelType, string>> = {
  [ChannelType.GuildText]: 'text',
  [ChannelType.GuildAnnouncement]: 'announcement',
  [ChannelType.GuildForum]: 'forum',
  [ChannelType.GuildMedia]: 'media',
  [ChannelType.GuildVoice]: 'voice',
  [ChannelType.GuildStageVoice]: 'stage',
  [ChannelType.GuildCategory]: 'category',
  [ChannelType.PublicThread]: 'thread',
  [ChannelType.AnnouncementThread]: 'thread',
  [ChannelType.PrivateThread]: 'private thread',
};

// only works within my servers, sorry! otherwise it's a waste of tokens & money :/
const ALLOWED_SERVERS = ['917588427959058462', '1064698336185172010', '708642778300547142', '1148069131711680633', '1547088936256671866'];
function isAllowedServer(serverID: Snowflake): boolean {
  return ALLOWED_SERVERS.includes(serverID);
}

// messages deleted recently, so a reply that's still generating doesn't save them afterwards
const recentlyDeleted = new Set<string>();
function markMessageDeleted(message_id: string): void {
  recentlyDeleted.add(message_id);
  setTimeout(() => recentlyDeleted.delete(message_id), DELETED_MEMORY_DURATION).unref(); // unref, so it never holds up shutdown
}

// converts one of our AI SDK tools into the shape the Anthropic SDK expects
function toAnthropicTool(name: string, localTool: Tool<any, any>): Anthropic.Tool {
  // the Anthropic format has no field for examples, so they're added to the end of the description
  const examples = (localTool.inputExamples ?? []).map((example) => JSON.stringify(example.input)).join('\n');
  const description = typeof localTool.description === 'string' ? localTool.description : '';

  return {
    name,
    description: (examples ? `${description}\n\nExample inputs:\n${examples}` : description) || undefined,
    input_schema: zod.toJSONSchema(localTool.inputSchema as unknown as zod.ZodType) as Anthropic.Tool.InputSchema,
  };
}

/**
 * The base system prompt, from SYSTEM.md. Read fresh each time, so edits apply without a restart.
 * SYSTEM.md is gitignored, so a fresh clone won't have one. That's fine, it just means no base prompt
 */
function getBaseSystemPrompt(): string {
  if (!existsSync(promptPath)) return '';
  return readFileSync(promptPath, 'utf-8').replace('<discord-id>', DISCORD_ID ?? 'undefined');
}
async function getDefaultSystemPrompt(): Promise<string> {
  return getBaseSystemPrompt();
}
// the server's override if it has one, otherwise SYSTEM.md
function getSystemPrompt(chatbot: ChatbotTable): string {
  return chatbot.system_prompt_override || getBaseSystemPrompt();
}

async function getEmbedding(text: string): Promise<number[]> {
  const embedding = await openAIClient.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float',
  });

  return embedding.data[0].embedding;
}

// a message's reactions, e.g. "😭 3 (you) · :pepeLaugh: 2". empty if it has none
function formatReactions(message: Message<boolean>): string {
  return message.reactions.cache.map((reaction) => {
    const emoji = reaction.emoji.id ? `:${reaction.emoji.name}:` : reaction.emoji.name; // custom emoji by name, rather than the long <:name:id>
    return `${emoji} ${reaction.count}${reaction.me ? ' (you)' : ''}`;
  }).join(' · ');
}

// a rough, readable length of time, e.g. "3 hours" or "2 days"
function formatElapsed(millis: number): string {
  const hours = Math.round(millis / (60 * 60_000));
  if (hours < 24) return `${hours} hour${hours === 1 ? '' : 's'}`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'}`;
}

/**
 * Given short term memories, return a formatted chatbot input
 * Resolves user, channel, and role mentions.
*/
async function formatInput(guild: Guild, currentChannel: SendableChannels, conversation: ConversationTable, referenceMessage: ConversationMessageTable | undefined, toolList: ConversationToolResultTable[], convoContext: ConversationMessageTable[]): Promise<ModelMessage[]> {
  if (!convoContext) return [];

  const MENTION_RE = /<(?:@!?(\d{17,20})|#(\d{17,20})|@&(\d{17,20}))>/g; // 3 capture groups for users, channels, & role mentions respectively
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // e.g. no permission to read pins in this channel. not worth failing the reply over
  const pinnedMessages = (await safeFetch(() => currentChannel.messages.fetchPins()))?.items ?? [];
  // the referenced message too, so its author and anyone it mentions are known, even when it's from outside the context
  const allMessages = referenceMessage ? [referenceMessage, ...convoContext] : convoContext;
  const mentionedUserIDs: Snowflake[] = allMessages.map((m) => m.author_id);
  const mentionedChannelIDs: Snowflake[] = [];
  const mentionedRoleIDs: Snowflake[] = [];

  // get all references from each message
  allMessages.forEach((msg) => {
    for (const m of msg.message_content.matchAll(MENTION_RE)) {
      const [, userId, channelId, roleId] = m; // exactly one of the three is defined
      if (userId) mentionedUserIDs.push(userId);
      if (channelId) mentionedChannelIDs.push(channelId);
      if (roleId) mentionedRoleIDs.push(roleId);
    }
  });

  // resolve mentionables in guild from IDs
  const mentionedUsers = Array.from((await Promise.all([...new Set(mentionedUserIDs)].map((user) => safeFetch(() => guild.members.fetch(user))))).filter((m) => m !== undefined && m !== null).values());
  let mentionedChannels = Array.from((await Promise.all([...new Set(mentionedChannelIDs)].map((channel) => safeFetch(() => guild.channels.fetch(channel))))).filter((m) => m !== undefined && m !== null).values()) as GuildChannel[];
  const mentionedRoles = Array.from((await Promise.all([...new Set(mentionedRoleIDs)].map((role) => safeFetch(() => guild.roles.fetch(role))))).filter((m) => m !== undefined && m !== null).values());

  const referenceMap = new Map<string, string>();

  // populate all references with their relevant symbols, and add to map
  mentionedUsers.map((user) => {
    let indexUser = getIndexUser(conversation.conversation_id, user.id);
    if (indexUser) {
      referenceMap.set(indexUser.user_id, indexUser.shorthand);
      return indexUser;
    }

    // if it doesn't exist, we must create it and insert it
    indexUser = {
      conversation_id: conversation.conversation_id,
      user_id: user.id,
      shorthand: `[@${getNextUserRef(conversation.conversation_id)}]`,
    };
    insertIndexUser(indexUser);
    referenceMap.set(indexUser.user_id, indexUser.shorthand);

    return indexUser;
  });
  // in a thread, the channel it's in gets a ref too, so the model can use it (e.g. for a new forum post, since a thread can't hold threads)
  if (currentChannel.isThread() && currentChannel.parent && !mentionedChannels.some((channel) => channel.id === currentChannel.parentId)) {
    mentionedChannels.push(currentChannel.parent);
  }

  mentionedChannels.map((channel) => {
    let indexChannel = getIndexChannel(conversation.conversation_id, channel.id);
    if (indexChannel) {
      referenceMap.set(indexChannel.channel_id, indexChannel.shorthand);
      return indexChannel;
    }

    // if it doesn't exist, we must create it and insert it
    indexChannel = {
      conversation_id: conversation.conversation_id,
      channel_id: channel.id,
      shorthand: `[#${getNextChannelRef(conversation.conversation_id)}]`,
    };
    insertIndexChannel(indexChannel);
    referenceMap.set(indexChannel.channel_id, indexChannel.shorthand);

    return indexChannel;
  });
  mentionedRoles.map((role) => {
    let indexRole = getIndexRole(conversation.conversation_id, role.id);
    if (indexRole) {
      referenceMap.set(indexRole.role_id, indexRole.shorthand);
      return indexRole;
    }

    // if it doesn't exist, we must create it and insert it
    indexRole = {
      conversation_id: conversation.conversation_id,
      role_id: role.id,
      shorthand: `[&${getNextRoleRef(conversation.conversation_id)}]`,
    };
    insertIndexRole(indexRole);
    referenceMap.set(indexRole.role_id, indexRole.shorthand);

    return indexRole;
  });
  convoContext.map((message) => {
    let indexMessage = getIndexMessage(conversation.conversation_id, message.message_id);
    if (indexMessage) {
      referenceMap.set(indexMessage.message_id, indexMessage.shorthand);
      return indexMessage;
    }

    // if it doesn't exist, we must create it and insert it
    indexMessage = {
      conversation_id: conversation.conversation_id,
      message_id: message.message_id,
      shorthand: `[$${getNextMessageRef(conversation.conversation_id)}]`,
    };
    insertIndexMessage(indexMessage);
    referenceMap.set(indexMessage.message_id, indexMessage.shorthand);

    return indexMessage;
  });

  // if there's a reference message, but not currently in the conversation's context, we must insert it to both the list and the map
  const outOfContextReference = referenceMessage !== undefined && !referenceMap.get(referenceMessage.message_id);
  if (referenceMessage && outOfContextReference) {
    referenceMap.set(referenceMessage.message_id, '[$0]');
    convoContext.unshift(referenceMessage);
  }

  // the current channel is always [#0], so drop it if it was also mentioned, or it'd be listed twice
  mentionedChannels = mentionedChannels.filter((channel) => channel.id !== currentChannel.id);
  mentionedChannels.unshift(currentChannel as GuildChannel);
  referenceMap.set(currentChannel.id, '[#0]');

  // replaces mentioned IDs with their shorter references. (saves a HUGE number of input tokens, since long numbers tokenize poorly)
  const stm = convoContext.map((msg) => ({
    ...msg,
    message_content: msg.message_content.replace(/^> -# .*(?:\r?\n|$)/gm, '').replace(MENTION_RE, (_, u, c, r) => referenceMap.get(u ?? c ?? r) ?? 'unknown'),
  }));

  // reactions are read live, since saved messages were frozen before most of theirs came in.
  // one fetch refreshes the recent messages in the cache, and discord.js keeps cached messages' reactions up to date after that
  await safeFetch(() => currentChannel.messages.fetch({ limit: 100 }));
  const reactionsOf = (messageID: string): string => {
    const message = currentChannel.messages.cache.get(messageID);
    return message ? formatReactions(message) : '';
  };
  // reactions to the bot's own messages go in the index instead, since a tag in its own turns would invite it to write one
  const reactionsToBot: string[] = [];

  // format the message to include message number, and reference message number
  const modelMessages: ModelMessage[] = stm.flatMap((msg, i): ModelMessage[] => {
    const messageShorthand = referenceMap.get(msg.message_id) ?? '[$unknown]';
    const reactions = reactionsOf(msg.message_id);

    // a long silence gets its own user turn, so it also works before the bot's messages (e.g. heartbeats). the out-of-context reference is skipped, since it's out of order
    const previous = i > 0 && !(i === 1 && outOfContextReference) ? stm[i - 1] : undefined;
    const gap = previous ? msg.timestamp - previous.timestamp : 0;
    const messageBreak: ModelMessage[] = gap > MESSAGE_BREAK_GAP ? [{ role: 'user', content: `<message_break elapsed="${formatElapsed(gap)}" />` }] : [];

    if (msg.author_id === discordClient.user!.id) {
      if (reactions) reactionsToBot.push(`<reactions message="${messageShorthand}">${reactions}</reactions>`);
      return [...messageBreak, { role: 'assistant', content: `${messageShorthand} ${msg.message_content}` }];
    }

    return [...messageBreak, {
      role: 'user',
      content: `${messageShorthand} ${referenceMap.get(msg.reference_id ?? '') !== undefined ? `↪ ${referenceMap.get(msg.reference_id!)} ` : ''}${msg.author_name}: ${msg.message_content}${reactions ? ` <reactions>${reactions}</reactions>` : ''}`,
    }];
  });

  const indexMsg: ModelMessage = {
    role: 'system',
    content:
    `<index>
    ${mentionedUsers.length === 0
    ? ''
    : `<users>
      ${mentionedUsers.map((user) => `<user id="${user.id}" name="${esc(user.user.displayName)}" nick="${esc(user.nickname ?? '')}" bot="${user.user.bot}" refID="${referenceMap.get(user.id)}" />`).join('\n\t')}
    </users>`}
    ${mentionedChannels.length === 0
    ? ''
    : `<channels>
      ${mentionedChannels.map((channel) => {
    // a thread points to the channel it's in, when that has a ref
    const isThread = [ChannelType.PublicThread, ChannelType.AnnouncementThread, ChannelType.PrivateThread].includes(channel.type);
    const parentRef = isThread && channel.parentId ? referenceMap.get(channel.parentId) : undefined;
    return `<channel id="${channel.id}" name="${esc(channel.name ?? '')}" refID="${referenceMap.get(channel.id)}" type="${CHANNEL_TYPE_NAMES[channel.type] ?? 'other'}"${parentRef ? ` parent="${parentRef}"` : ''} />`;
  }).join('\n\t')}
    </channels>`}
    ${mentionedRoles.length === 0
    ? ''
    : `<roles>
      ${mentionedRoles.map((role) => `<role id="${role.id}" name="${esc(role.name)}" mentionable="${role.mentionable}" refID="${referenceMap.get(role.id)}" />`).join('\n\t')}
      </roles>`}
    ${toolList.length === 0 // past tool results go here, since the Anthropic API only accepts a tool result right after the call that made it
    ? ''
    : `<tool_results>
      ${toolList.map((tool) => `<tool_result name="${esc(tool.tool_name)}" time="${new Date(tool.timestamp).toLocaleString()}"${tool.output.length > MAX_PROMPT_TOOL_RESULT_LENGTH ? ' truncated="true"' : ''}>${esc(tool.output.substring(0, MAX_PROMPT_TOOL_RESULT_LENGTH))}</tool_result>`).join('\n\t')}
    </tool_results>`}
    ${pinnedMessages.length === 0
    ? ''
    : `<pinned_messages>
      ${pinnedMessages.map((msg) => `<msg authorID="${msg.message.author.id}">${esc(msg.message.content)}</msg>`).join('\n\t')}
    </pinned_messages>`}
    ${reactionsToBot.length === 0
    ? ''
    : `<reactions_to_your_messages>
      ${reactionsToBot.join('\n\t')}
    </reactions_to_your_messages>`}
    </index>`,
  };
  modelMessages.unshift(indexMsg);

  return modelMessages;
}

/**
 * Who a message from the chatbot may ping: only the users it mentions who have subscribed in this server, so it can't ping people who never opted in.
 * Anyone else it mentions still shows as a mention, just without a notification. Roles ping as usual, and @everyone and @here never do.
 * Only the mentioned users are listed, which also keeps it under discord's limit of 100
 */
function chatbotMentions(serverID: Snowflake, content: string): MessageMentionOptions {
  const mentioned = [...new Set([...content.matchAll(/<@!?(\d{17,20})>/g)].map((match) => match[1]))];
  return { parse: ['roles'], users: [...getSubscribersAmong(serverID, mentioned)].slice(0, 100), repliedUser: true };
}

/**
 * Splits a finished LLM response into Discord-safe message chunks (<= 2000 chars),
 * preserving open code fences across the split.
*/
async function formatResponse(conversationID: string, agentResponse: string): Promise<string[]> {
  const chunks: string[] = [];
  let rest = agentResponse
    // turn user, channel, & role shorthands back into Discord mentions. unknown ones are left as written
    .replace(/\[@\d+\]/g, (ref) => { const id = resolveUserRef(conversationID, ref); return id ? `<@${id}>` : ref; })
    .replace(/\[#\d+\]/g, (ref) => { const id = resolveChannelRef(conversationID, ref); return id ? `<#${id}>` : ref; })
    .replace(/\[&\d+\]/g, (ref) => { const id = resolveRoleRef(conversationID, ref); return id ? `<@&${id}>` : ref; })
    .replace(/(?<!")\[\$\d+\]|\[\$\d+\](?!")/g, '') // replace local message numbers from output
    .replace(/<reactions\b[^>]*>[\s\S]*?<\/reactions>/g, '') // in case it copies the reaction tags it's shown
    .replace(/<message_break\b[^>]*\/>/g, ''); // same for the message breaks
  let open: string | null = null; // fence line still open at the start of `rest`

  while (rest.length > 0) {
    const prefix = open ? `${open}\n` : '';

    if (prefix.length + rest.length <= MAX_MESSAGE_LENGTH) {
      chunks.push(prefix + rest);
      break;
    }

    const window = rest.slice(0, MAX_MESSAGE_LENGTH - prefix.length - PADDING_LENGTH);
    const cut = splitPoint(window, open !== null);
    const piece = rest.slice(0, cut);

    const stillOpen = trackFence(piece, open);
    const closer = stillOpen ? `\n${/^`+/.exec(stillOpen)![0]}` : '';

    if (piece.trim()) chunks.push(prefix + piece.trimEnd() + closer);

    open = stillOpen;
    // Consume exactly one separator so code indentation on the next line survives
    rest = rest.slice(cut).replace(/^(\n\n|\n| )/, '');
  }

  // a message with nothing visible in it is never sent, or saved
  return chunks.filter((chunk) => !BLANK_MESSAGE.test(chunk));
}

// what a reply is generated for: a message someone sent the bot, or a heartbeat, which has no message to answer
type ReplyTrigger = {
  channel: GuildTextBasedChannel,
  onStatus?: (status: string) => void, // told what the reply is doing (e.g. which tool it's using), for a live status message
  control?: ReplyControl, // its Stop and Cancel buttons
} & (
  { message: Message<true>, reference?: Message<boolean>, context: Message<boolean>[] } // context: recent messages before it
  // a heartbeat isn't shown the channel. it can look with fetch_channel or search_channel
  // the caller picks the heartbeat's conversation id, so it can settle the conversation even if this fails partway
  | { heartbeat: HeartbeatTable, conversation_id: string });

interface GeneratedReply {
  conversation_id: string,
  chunks: string[], // the reply split into Discord-sized messages. empty if there's nothing to send
}

// how a reply still being written can be cut short, by the buttons on its status message (see replies.ts)
interface ReplyControl {
  stop: AbortSignal, // no more tools: what's running is given up on, and the model answers right away with what it has
  cancel: AbortSignal, // drop the reply entirely. generateReply throws, and whatever started it cleans up
  // its author added a message while it was being written: this attempt is dropped, but what its tools did is kept for the next one
  restart?: AbortSignal,
  toolCallIDs: string[], // the tool results it saved, filled in as it goes, so a cancelled reply's can be marked as such
  toolCalls: { name: string, input: unknown }[], // the tools it's used, for the summary above it. kept across restarts
}

// what a reply being written shows, on its status message, or in place of the reply while it's retried. under the tools it's used so far
const THINKING_STATUS = '-# thinking...';
const TYPING_STATUS = '-# typing...';
const STOPPED_STATUS = '-# ⏹️ stopped using tools, typing the reply...';
// in place of a reply that's still being written, wherever the model would otherwise see its status message
const WRITING_PLACEHOLDER = '[a reply the bot was still writing]';

// status messages and retried replies still being written. they show a status rather than anything said, so the model sees a placeholder
const writingMessages = new Set<Snowflake>();
function setWriting(messageID: Snowflake, writing: boolean): void {
  if (writing) writingMessages.add(messageID);
  else writingMessages.delete(messageID);
}

const STOPPED_TOOL_RESULT = 'Stopped by the user before it finished, so there is no result. It may still have taken effect.';
const STOPPED_NOTE = 'The user pressed Stop: no more tools. Reply now, with what you have so far.';
const STOPPED_EMPTY_REPLY = '-# stopped before it could reply';

// what a heartbeat was given, as saved for its summary
function heartbeatText(heartbeat: HeartbeatTable): string {
  return heartbeat.context ? `${heartbeat.prompt}\n\nContext: ${heartbeat.context}` : heartbeat.prompt;
}

// a heartbeat's final turn, in place of a message to answer
function heartbeatTurn(heartbeat: HeartbeatTable): string {
  return `<heartbeat name="${heartbeat.heartbeat_name}" time="${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' })}">
${heartbeat.prompt}
</heartbeat>
${heartbeat.context ? `<heartbeat_context>
${heartbeat.context}
</heartbeat_context>
` : ''}This is a scheduled heartbeat, not a message from anyone. Nothing from the channel is shown, so use fetch_channel or search_channel if you need to see what's been said.
${heartbeat.silent
    ? 'This heartbeat is silent: your reply isn\'t posted anywhere, so do what it asks with your tools. If something is worth saying in Discord, use send_message. End with a short note of what you did, for your own memory.'
    : `Your reply is posted in [#0]. If there's nothing worth posting, reply with exactly ${HEARTBEAT_OK} and nothing will be sent.`}`;
}

/**
 * Whether a tool call could have changed something (sent a message, saved a memory, ran a command...), rather than only looked something up.
 * A dirty result is never forgotten, even when its reply is cancelled or regenerated, since what it did still happened.
 * Anything not listed counts as dirty, so a new tool is never silently forgotten
 */
function isDirtyCall(name: string, input: any): boolean {
  switch (name) {
    case 'fetch_channel':
    case 'search_channel':
    case 'fetch_embed':
    case 'search_users':
    case 'list_users':
    case 'view_user':
    case 'list_reminders':
    case 'view_reminder':
    case 'list_memories':
    case 'view_memory':
    case 'search_summaries':
    case 'caption_image':
    case 'x_search':
    case 'bluesky':
    case 'web_search':
      return false;
    case 'counter':
    case 'heartbeat':
      return input?.action !== 'list';
    case 'bluesky_dms': return input?.action === 'send';
    case 'fetch_url': return (input?.method ?? 'GET') !== 'GET';
    default: return true;
  }
}

// a short phrase for what one tool call did, e.g. ['searched', '"weather today"']. calls with the same verb are listed together
function describeToolCall(name: string, input: any): [string, string] {
  // plain text only, since it's shown as discord markdown, where backticks or a <@id> would break or ping.
  // user and role refs too, since the header goes through formatResponse with the reply, which turns them into pings
  const clip = (value: unknown, max = 40) => {
    const text = String(value ?? '').replace(/\s+/g, ' ').replace(/[`*_~|<>\\]/g, '')
      .replace(/\[@\d+\]/g, 'a user')
      .replace(/\[&\d+\]/g, 'a role')
      .trim();
    const clipped = text.length > max ? `${text.substring(0, max - 1)}…` : text;
    return clipped.replace(/https?:\/\/\S+/g, (url) => `<${url}>`); // after clipping, so the brackets are never cut off. <> stops discord embedding links
  };
  const quote = (value: unknown) => (value ? `"${clip(value)}"` : '');
  const host = (url: unknown) => {
    try { return new URL(String(url)).hostname; } catch { return clip(url); }
  };
  const actionVerbs: Record<string, string> = { create: 'created', add: 'updated', set: 'set', edit: 'edited', delete: 'deleted' };

  switch (name) {
    case 'web_search': return ['searched', quote(input.query)];
    case 'x_search': return ['searched X for', quote(input.query)];
    case 'bluesky':
      if (input.action === 'search') return ['searched Bluesky for', quote(input.target)];
      if (input.action === 'notifications') return ['checked Bluesky notifications', ''];
      return [`${input.more ? 'scrolled' : 'read'} Bluesky`, clip(input.target) || input.action];
    case 'bluesky_act': {
      const blueskyVerbs: Record<string, string> = {
        post: 'posted on Bluesky',
        reply: 'replied on Bluesky',
        delete: 'deleted a Bluesky post',
        like: 'liked a Bluesky post',
        unlike: 'unliked a Bluesky post',
        repost: 'reposted on Bluesky',
        unrepost: 'undid a Bluesky repost',
        mark_read: 'marked Bluesky notifications read',
        edit_profile: 'edited Bluesky profile',
        // these say who
        follow: 'followed on Bluesky',
        unfollow: 'unfollowed on Bluesky',
        mute: 'muted on Bluesky',
        unmute: 'unmuted on Bluesky',
        block: 'blocked on Bluesky',
        unblock: 'unblocked on Bluesky',
      };
      const verb = blueskyVerbs[input.action] ?? `used ${name}`;
      if (input.action === 'post' || input.action === 'reply') return [verb, quote(input.text)];
      return [verb, ['follow', 'unfollow', 'mute', 'unmute', 'block', 'unblock'].includes(input.action) ? clip(input.target) : ''];
    }
    case 'bluesky_dms':
      if (input.action === 'send') return ['sent a Bluesky DM to', clip(input.with)];
      if (input.action === 'read') return ['read Bluesky DMs with', clip(input.with)];
      return ['checked Bluesky DMs', ''];
    case 'fetch_url': return ['fetched', host(input.url)];
    case 'caption_image': return ['looked at images', ''];
    case 'shell':
    case 'run_command': return ['ran', quote(input.command ?? (Array.isArray(input.commands) ? input.commands.join('; ') : ''))];
    case 'write_file': return ['wrote', clip(input.path)];
    // channel refs like [#3] are left as written, so they're turned into channel links with the rest of the reply
    case 'fetch_channel': return ['read', clip(input.channel) || 'this channel'];
    case 'search_channel': return [`searched ${clip(input.channel) || 'this channel'} for`, quote(input.query ?? input.author)];
    case 'send_message': return ['sent a message in', clip(input.channel) || 'this channel'];
    case 'create_thread': return ['created thread', quote(input.name)];
    case 'react_to_message': return ['reacted', clip(input.emoji, 8)];
    case 'change_nickname': return ['changed nickname to', quote(input.nickname) || 'default'];
    case 'create_reminder': return ['created reminder', quote(input.reminder_name)];
    case 'edit_reminder': return ['edited reminder', quote(input.reminder_name)];
    case 'view_reminder': return ['checked reminder', quote(input.reminder_name)];
    case 'remove_reminder': return ['removed reminder', quote(input.reminder_name)];
    case 'list_reminders': return ['listed reminders', ''];
    case 'create_memory': return ['saved memory', quote(input.name)];
    case 'edit_memory': return ['updated memory', quote(input.name)];
    case 'view_memory': return ['read memory', quote(input.name)];
    case 'remove_memory': return ['forgot memory', quote(input.name)];
    case 'list_memories': return ['listed memories', ''];
    case 'search_summaries': return ['searched summaries for', quote(input.query)];
    case 'counter':
    case 'heartbeat':
      if (input.action === 'list') return [`listed ${name}s`, ''];
      return [`${actionVerbs[input.action] ?? input.action} ${name}`, quote(input.name)];
    default: return [`used ${name}`, ''];
  }
}

// shown above the reply: each tool once, with how many times it was used, then a line on what they were used for
function formatToolHeader(calls: { name: string, input: unknown }[]): string {
  if (calls.length === 0) return '';

  const counts = new Map<string, number>();
  calls.forEach((call) => counts.set(call.name, (counts.get(call.name) ?? 0) + 1));
  const used = [...counts].map(([name, count]) => (count > 1 ? `${name} ×${count}` : name)).join(', ');

  const byVerb = new Map<string, string[]>();
  calls.forEach((call) => {
    const [verb, detail] = describeToolCall(call.name, call.input ?? {});
    const details = byVerb.get(verb) ?? [];
    if (detail && !details.includes(detail)) details.push(detail);
    byVerb.set(verb, details);
  });
  let synopsis = [...byVerb].map(([verb, details]) => (details.length > 0 ? `${verb} ${details.join(', ')}` : verb)).join(' · ');
  if (synopsis.length > MAX_TOOL_SYNOPSIS_LENGTH) synopsis = `${synopsis.substring(0, MAX_TOOL_SYNOPSIS_LENGTH - 1)}…`;
  if (synopsis.lastIndexOf('<') > synopsis.lastIndexOf('>')) synopsis += '>'; // cut partway through a link, so it'd embed without its closing bracket

  return `> -# used ${used}\n> -# ${synopsis}`;
}

/**
 * Generates the chatbot's reply, and saves the conversation it's part of.
 * A heartbeat gets a conversation of its own, which the caller summarizes once it has sent the reply.
 * Sending, and handling errors, is left to the caller
 */
async function generateReply(serverID: Snowflake, trigger: ReplyTrigger): Promise<GeneratedReply> {
  const { channel } = trigger;
  const userMessage = 'message' in trigger ? trigger.message : undefined;
  const messageReference = 'message' in trigger ? trigger.reference : undefined;
  const recentMessages = 'context' in trigger ? trigger.context : [];
  const heartbeat = 'heartbeat' in trigger ? trigger.heartbeat : undefined;
  const heartbeatConversationID = 'heartbeat' in trigger ? trigger.conversation_id : undefined;

  const chatbot = getChatbot(serverID)!;
  const guild = await discordClient.guilds.fetch(serverID)!;

  let conversation = heartbeat ? undefined : getConversationByChannel(channel.id);
  if (heartbeat) {
    // already expired, so it's never taken as the channel's active conversation. if the bot stops mid-beat, startup summarizes it
    conversation = {
      conversation_id: heartbeatConversationID!,
      channel_id: channel.id,
      source_id: serverID,
      platform: 'discord',
      expires_at: Date.now(),
    };
  } else if (!conversation) { // if no active conversations, create a new one
    conversation = {
      conversation_id: `${channel.id}${userMessage!.id}`,
      channel_id: channel.id,
      source_id: serverID,
      platform: 'discord',
      expires_at: Date.now() + 3_600_000, // expires in an hour
    };
  } else {
    conversation.expires_at = Date.now() + 3_600_000; // expires in an hour
    // delete any current archival task for this conversation
    cron.getTasks().forEach((task) => {
      if (task.name === conversation?.conversation_id) {
        task.destroy();
      }
    });
  }

  // save the conversation (or its new expiry), so its index and messages have something to reference
  upsertConversation(conversation);

  // schedule new archive task. a heartbeat's is summarized by its caller instead
  if (!heartbeat) {
    cron.schedule(millisToCronSchedule(conversation.expires_at)!, () => summarizeConversation(conversation.conversation_id), {
      name: conversation.conversation_id,
    });
  }

  const conversationContext = getConversationMessages(conversation.conversation_id);
  // filtered before captioning, so messages already saved (with their captions) aren't captioned again
  const uniqueContext: ConversationMessageTable[] = await Promise.all(recentMessages.filter((txt) => !conversationContext.find((convoTxt) => convoTxt.message_id === txt.id))
    .map(async (ctx) => {
      const content = writingMessages.has(ctx.id) ? WRITING_PLACEHOLDER : await withCaptions(ctx);

      return {
        conversation_id: conversation.conversation_id,
        message_id: ctx.id,
        // context includes the bot's own earlier replies. as 'user', they'd count as someone who hasn't opted in to sharing
        role: ctx.author.id === discordClient.user?.id ? 'assistant' : 'user',

        author_id: ctx.author.id,
        author_name: ctx.author.displayName,
        timestamp: ctx.createdTimestamp,

        reference_id: ctx.reference?.messageId ?? undefined,
        message_content: content,
        token_count: estimateTokens(content),
      };
    }));
  // a retried reply's message is already saved, with its captions, so it's reused rather than captioned and added again
  const savedUserMessage = userMessage && conversationContext.find((msg) => msg.message_id === userMessage.id);
  const userContent = userMessage && !savedUserMessage ? await withCaptions(userMessage) : '';
  const userConvoMessage: ConversationMessageTable | undefined = savedUserMessage ?? (userMessage && {
    conversation_id: conversation.conversation_id,
    role: 'user',
    author_name: userMessage.author.displayName,
    author_id: userMessage.author.id,
    message_id: userMessage.id,
    reference_id: messageReference?.id ?? undefined,
    timestamp: userMessage.createdTimestamp,
    message_content: userContent,
    token_count: estimateTokens(userContent),
  });

  conversationContext.push(...uniqueContext);
  if (userConvoMessage && !savedUserMessage) conversationContext.push(userConvoMessage);

  // saved so the summary knows why the bot posted, but kept out of conversationContext, since it's given as the last turn instead.
  // saved now, rather than with the rest, so it's there even if the reply fails partway
  const heartbeatContent = heartbeat ? heartbeatText(heartbeat) : '';
  const heartbeatMessage: ConversationMessageTable | undefined = heartbeat && {
    conversation_id: conversation.conversation_id,
    role: 'user',
    author_name: 'heartbeat',
    author_id: 'heartbeat',
    message_id: `heartbeat${Date.now()}`,
    timestamp: Date.now(),
    message_content: heartbeatContent,
    token_count: estimateTokens(heartbeatContent),
  };
  if (heartbeatMessage) insertConversationMessage(heartbeatMessage);

  // summaries are found by similarity to what's being answered: the user's message, or the heartbeat's prompt
  const promptMessage = (userConvoMessage ?? heartbeatMessage)!;
  // summaries are a nice-to-have, so a failed embedding call shouldn't stop the reply
  const relevantSummaries = await getRelevantSummaries(conversation, promptMessage).catch((error) => {
    console.error(error);
    return [];
  });

  // add the referenced message to beginning of context if it isn't already included
  let referenceMessage: ConversationMessageTable | undefined;

  if (messageReference) {
    if (!conversationContext.find((stm) => messageReference.id === stm.message_id)) {
      referenceMessage = {
        role: messageReference.author.id === discordClient.user?.id ? 'assistant' : 'user',
        conversation_id: conversation.conversation_id,
        timestamp: messageReference.createdTimestamp,
        author_id: messageReference.author.id,
        author_name: messageReference.author.displayName,
        message_content: writingMessages.has(messageReference.id) ? WRITING_PLACEHOLDER : await withCaptions(messageReference),
        message_id: messageReference.id,
      };
    }
  }

  // sort by chronological order
  conversationContext.sort((msg1, msg2) => msg1.timestamp - msg2.timestamp);

  // only the latest results, so a long conversation's prompt doesn't keep growing. all of them are still kept for the summary
  const toolContext = getVisibleToolResults(conversation.conversation_id).slice(-MAX_PROMPT_TOOL_RESULTS);
  const agentInput = await formatInput(guild, channel, conversation, referenceMessage, toolContext, conversationContext);
  const indexMsg = agentInput.shift()!;
  // dated, so the model can tell how long ago it was
  const summaryStr = relevantSummaries.map((summary) => `<summary date="${new Date(summary.timestamp).toLocaleDateString('en-US', { dateStyle: 'medium' })}">${summary.summary}</summary>`).join('\n');
  const memories = getVisibleMemories(serverID);
  // the workspace is shared like the main memories, so detached servers don't get it
  const useSandbox = isSandboxEnabled() && isAttached(serverID);
  const workspaceNotes = useSandbox ? await readNotes() : '';
  // given to every tool by the bot, never by the model
  const replyContext = {
    server_id: serverID,
    channel_id: channel.id, // where heartbeats the bot schedules will post, and the default channel for channel tools
    conversation_id: conversation.conversation_id, // for resolving refs like [#3], and saving what send_message sends
    // memory tools only save to the shared context when everyone in this conversation has opted in.
    // a heartbeat has no one to ask, and its prompt may have come from someone who didn't, so it never shares
    shareable: !heartbeat && isShareable(serverID, conversationContext.filter((msg) => msg.role === 'user').map((msg) => msg.author_id)),
    reference_message_id: messageReference?.id, // the message the user is replying to, shown to the model as [$0]
  };

  // SYSTEM.md (or the server's override), with the server's persona layered on top
  const systemPrompt = `<system>
      ${getSystemPrompt(chatbot)}
    </system>
    ${chatbot.chatbot_prompt ? `<persona>
      ${chatbot.chatbot_prompt}
    </persona>` : ''}
    <relevant_summaries>
      ${summaryStr}
    </relevant_summaries>
    <memory_list>
      ${memories.map((memory) => memory.name).join('\n')}
    </memory_list>
    ${workspaceNotes ? `<workspace_notes>
      ${workspaceNotes}
    </workspace_notes>` : ''}
    <conversation conversation_id="${conversation.conversation_id}" server_id="${serverID}" current_date="${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' })}" />
    <index>
      ${indexMsg.content}
    </index>`;

  const model = chatbot.model ?? DEFAULT_MODEL;
  // models without tool support get none, rather than an error
  const tools: ToolUnion[] | undefined = chatbot.tools_enabled && supportsTools(model) ? [
    {
      type: 'openrouter:web_search',
      parameters: { engine: 'native', max_results: 20 }, // "native" on Grok includes X search
    } as unknown as ToolUnion,
    // our own persistent workspace when it's set up and the server is attached. otherwise openrouter's shell, which is a fresh container each reply
    ...(useSandbox ? [
      toAnthropicTool('run_command', localTools.runCommand),
      toAnthropicTool('write_file', localTools.writeFile),
    ] : [{
      // runs commands in a sandbox on openrouter's side (python 3.11 and node 22 are installed), never on this machine.
      // network is limited to package registries, so it can still pip/npm install
      type: 'openrouter:shell',
      parameters: {
        engine: 'openrouter',
        environment: {
          type: 'container_auto',
          network_policy: { type: 'allowlist', allowed_domains: ['*'] },
        },
      },
    } as unknown as ToolUnion]),
    toAnthropicTool('react_to_message', localTools.reactToMessage),
    toAnthropicTool('change_nickname', localTools.changeNickname),
    toAnthropicTool('create_reminder', localTools.createReminder),
    toAnthropicTool('edit_reminder', localTools.editReminder),
    toAnthropicTool('list_reminders', localTools.listReminders),
    toAnthropicTool('view_reminder', localTools.viewReminder),
    toAnthropicTool('remove_reminder', localTools.removeReminder),
    toAnthropicTool('heartbeat', localTools.heartbeat),
    toAnthropicTool('fetch_channel', localTools.fetchChannel),
    toAnthropicTool('search_channel', localTools.searchChannel),
    toAnthropicTool('fetch_embed', localTools.fetchEmbed),
    toAnthropicTool('search_users', localTools.searchUsers),
    toAnthropicTool('list_users', localTools.listUsers),
    toAnthropicTool('view_user', localTools.viewUser),
    toAnthropicTool('send_message', localTools.sendMessage),
    toAnthropicTool('create_thread', localTools.createThread),
    toAnthropicTool('create_memory', localTools.createMemory),
    toAnthropicTool('edit_memory', localTools.editMemory),
    toAnthropicTool('list_memories', localTools.listMemories),
    toAnthropicTool('view_memory', localTools.viewMemory),
    toAnthropicTool('remove_memory', localTools.removeMemory),
    toAnthropicTool('search_summaries', localTools.searchSummaries),
    toAnthropicTool('fetch_url', localTools.fetchURL),
    toAnthropicTool('caption_image', localTools.captionImage),
    toAnthropicTool('counter', localTools.counter),
    // only offered once the key is in .env, so the model doesn't reach for a tool that can't work
    ...(process.env.TWITTER_API_KEY ? [toAnthropicTool('x_search', localTools.xSearch)] : []),
    toAnthropicTool('bluesky', localTools.bluesky), // always offered, since most of it works through the public API without a login
    // acting as the bot's account is public, and its DMs are private, so only attached servers get these, and only once there's a login
    ...(process.env.BLUESKY_HANDLE && isAttached(serverID) ? [
      // toAnthropicTool('bluesky_act', localTools.blueskyAct),
      // toAnthropicTool('bluesky_dms', localTools.blueskyDMs),
    ] : []),
  ] : undefined;

  // tools we execute ourselves. web search runs on OpenRouter's side
  const localToolMap: Record<string, Tool<any, any>> = {
    react_to_message: localTools.reactToMessage,
    change_nickname: localTools.changeNickname,

    create_reminder: localTools.createReminder,
    edit_reminder: localTools.editReminder,
    list_reminders: localTools.listReminders,
    view_reminder: localTools.viewReminder,
    remove_reminder: localTools.removeReminder,
    heartbeat: localTools.heartbeat,

    fetch_channel: localTools.fetchChannel,
    search_channel: localTools.searchChannel,
    fetch_embed: localTools.fetchEmbed,
    search_users: localTools.searchUsers,
    list_users: localTools.listUsers,
    view_user: localTools.viewUser,
    send_message: localTools.sendMessage,
    create_thread: localTools.createThread,

    create_memory: localTools.createMemory,
    edit_memory: localTools.editMemory,
    list_memories: localTools.listMemories,
    view_memory: localTools.viewMemory,
    remove_memory: localTools.removeMemory,
    search_summaries: localTools.searchSummaries,

    fetch_url: localTools.fetchURL,
    caption_image: localTools.captionImage,
    counter: localTools.counter,
    x_search: localTools.xSearch,
    bluesky: localTools.bluesky,
    bluesky_act: localTools.blueskyAct,
    bluesky_dms: localTools.blueskyDMs,

    run_command: localTools.runCommand,
    write_file: localTools.writeFile,
  };

  const messages = agentInput as MessageParam[];
  // the heartbeat goes in as the last turn, in place of a message to answer. it isn't saved, so it never looks like something a person said
  if (heartbeat) messages.push({ role: 'user', content: heartbeatTurn(heartbeat) });

  let streamStr = '';
  const toolCalls = trigger.control?.toolCalls ?? []; // for the header above the reply, and the live one on its status

  const { stop, cancel, restart, toolCallIDs } = trigger.control ?? {};
  // Cancel, or a restart, cut the model off mid-stream, and end this attempt
  const abort = cancel && restart ? AbortSignal.any([cancel, restart]) : cancel;
  // settles the moment Stop, Cancel, or a restart happens, so tools still running are given up on right away, rather than waited for
  const interrupted = new Promise<void>((resolve) => {
    [stop, abort].forEach((signal) => {
      if (signal?.aborted) resolve();
      signal?.addEventListener('abort', () => resolve(), { once: true });
    });
  });

  // the status: the tools used so far, then what it's doing now. once stopped, it says so until the reply is done
  let stage = THINKING_STATUS;
  const showStatus = (newStage?: string) => {
    if (newStage && !stop?.aborted) stage = newStage;
    trigger.onStatus?.([formatToolHeader(toolCalls), stage].filter(Boolean).join('\n'));
  };
  stop?.addEventListener('abort', () => { stage = STOPPED_STATUS; showStatus(); }, { once: true });
  if (stop?.aborted) stage = STOPPED_STATUS;
  showStatus(); // a restarted reply's status shows the tools from before it
  // saved as each one runs, so a reply that fails partway still has a record of what it did. once it's cancelled, only what could have
  // changed something is kept, marked as from a cancelled reply. a lookup that finishes late is dropped
  const saveToolResult = (result: ConversationToolResultTable, input: unknown) => {
    const dirty = isDirtyCall(result.tool_name, input);
    if (cancel?.aborted && !dirty) return;
    insertConversationToolResult({ ...result, dirty, discarded: cancel?.aborted ? 'cancelled' : undefined });
    toolCallIDs?.push(result.tool_call_id);
  };

  // unlike streamText, the Anthropic SDK doesn't run tools for us, so loop until the model stops asking for them
  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    abort?.throwIfAborted();
    // the tools it was using are done, so it's back to thinking, until the stream says it's typing or using another one
    if (step > 0) showStatus(THINKING_STATUS);
    // after Stop, this is the last call, whatever comes back
    const finishing = !!stop?.aborted;
    const stream = anthropicClient.messages.stream({
      model,
      temperature: temperatureFor(model, chatbot.temperature ?? DEFAULT_TEMPERATURE),
      // reasoning counts toward it too. openrouter treats 0 as no limit, and refuses the request if the credits can't cover that much output
      max_tokens: 20_000,
      system: systemPrompt,
      // openrouter quietly ignores efforts a model can't use. it also accepts 'none' and 'minimal', which the sdk's type doesn't list
      output_config: { effort: (chatbot.reasoning_effort ?? DEFAULT_REASONING_EFFORT) as OutputConfig['effort'] },
      messages,
      tools,
      // after Stop, it has to answer rather than call another tool
      ...(finishing && tools ? { tool_choice: { type: 'none' as const } } : {}),
    }, { signal: abort });

    let stepText = ''; // text from this round only, so a "let me check" before a tool call doesn't get posted alongside the real answer
    let afterToolUse = false; // server tools (web search, shell) run mid-response, so text can continue right after one
    // server tools run on OpenRouter's side, in the middle of the response. each is listed as soon as the stream moves past it,
    // to its result (shell), or to whatever the model does next (web search, which has no result block), rather than once the response ends
    const runningServerTools: string[] = []; // ids of ones not listed yet
    const listedServerTools = new Set<string>();
    const listServerTools = () => {
      if (runningServerTools.length === 0) return;
      runningServerTools.splice(0).forEach((id) => {
        const block = stream.currentMessage?.content.find((other: any) => other.id === id) as ServerToolUseBlock | undefined;
        if (!block) return;
        listedServerTools.add(id);
        toolCalls.push({ name: String(block.name).replace(/^openrouter:/, ''), input: block.input });
      });
      showStatus();
    };
    for await (const event of stream) {
      if (event.type === 'content_block_start') listServerTools(); // whatever ran before this block is done
      if (event.type === 'content_block_start' && event.content_block.type === 'server_tool_use') runningServerTools.push(event.content_block.id);

      if (event.type === 'content_block_start' && 'tool_use_id' in event.content_block) {
        showStatus(THINKING_STATUS); // a server tool's result: it's done, and the model carries on
      } else if (event.type === 'content_block_start' && (event.content_block.type === 'tool_use' || event.content_block.type === 'server_tool_use')) {
        showStatus(`-# using ${String(event.content_block.name).replace(/^openrouter:/, '')}...`); // e.g. openrouter:web_search -> web_search
        afterToolUse = true;
      } else if (event.type === 'content_block_start' && event.content_block.type === 'thinking') {
        showStatus(THINKING_STATUS);
      } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
        if (stage !== TYPING_STATUS && !stop?.aborted) showStatus(TYPING_STATUS);
        // the model never adds a line break itself, so text before and after a tool would run together ("...hellOKAY...")
        if (afterToolUse && stepText && !stepText.endsWith('\n')) stepText += '\n';
        afterToolUse = false;
        stepText += event.delta.text;
      }
    }
    listServerTools(); // any it ended on
    streamStr = stepText || streamStr; // keep the earlier text if the final round has none

    const response = await stream.finalMessage();

    // record server-side tool calls (web search, shell), which come back already executed. each is a server_tool_use block,
    // with its results either in a result block pointing back to it (shell: openrouter_shell_tool_result),
    // or for web search, which has no result block, as citations on the text blocks after it
    response.content.forEach((block, i) => {
      if (block.type !== 'server_tool_use') return;

      const resultBlock = response.content.find((other: any) => other.tool_use_id === block.id) as any;
      let results;
      if (resultBlock) {
        results = resultBlock.content;
      } else {
        // up to the next call of the same tool, since other tools' calls can come in between (e.g. a search then a shell call)
        const nextCall = response.content.findIndex((other, j) => j > i && other.type === 'server_tool_use' && other.name === block.name);
        results = response.content.slice(i + 1, nextCall === -1 ? undefined : nextCall)
          .flatMap((other) => (other.type === 'text' ? other.citations ?? [] : []))
          .map((citation: any) => ({ title: citation.title, url: citation.url, cited_text: citation.cited_text }));
      }

      const toolName = String(block.name).replace(/^openrouter:/, ''); // e.g. openrouter:web_search -> web_search
      // already listed while it streamed, almost always
      if (!listedServerTools.has(block.id)) {
        toolCalls.push({ name: toolName, input: block.input });
        showStatus();
      }
      saveToolResult({
        conversation_id: conversation.conversation_id,
        timestamp: Date.now(),
        tool_call_id: block.id,
        tool_name: toolName,
        output: JSON.stringify({ input: block.input, results }),
      }, block.input);
    });

    // even if it asks for a tool anyway, it gets no more calls
    if (finishing) {
      if (!streamStr.trim()) streamStr = STOPPED_EMPTY_REPLY;
      break;
    }

    const toolUses = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
    if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

    // run each requested tool, then hand the results back for the next step.
    // after Stop, ones not started yet are skipped, and ones still running are given up on. they finish in the background, and still take effect
    const toolResults: ToolResultBlockParam[] = await Promise.all(toolUses.map(async (toolUse): Promise<ToolResultBlockParam> => {
      const stoppedResult: ToolResultBlockParam = { type: 'tool_result', tool_use_id: toolUse.id, content: STOPPED_TOOL_RESULT };
      if (stop?.aborted || abort?.aborted) return stoppedResult;

      // listed once it finishes, or once it's given up on, so the live list grows with every result
      let listed = false;
      const list = () => {
        if (listed) return;
        listed = true;
        toolCalls.push({ name: toolUse.name, input: toolUse.input });
        showStatus();
      };
      const run = (async (): Promise<ToolResultBlockParam> => {
        const localTool = localToolMap[toolUse.name];
        const output = localTool?.execute
          ? await localTool.execute(toolUse.input, { toolCallId: toolUse.id, messages: [], context: replyContext })
          : { result: 'failure', message: `There is no tool named ${toolUse.name}` };
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

        saveToolResult({
          conversation_id: conversation.conversation_id,
          timestamp: Date.now(),
          tool_call_id: toolUse.id,
          tool_name: toolUse.name,
          output: outputStr,
        }, toolUse.input);
        list();
        return { type: 'tool_result', tool_use_id: toolUse.id, content: outputStr };
      })();
      run.catch((error) => console.error(error)); // a tool given up on can still fail later, with nothing waiting on it

      return Promise.race([run, interrupted.then(() => { list(); return stoppedResult; })]);
    }));
    abort?.throwIfAborted();

    messages.push({ role: 'assistant', content: response.content });
    // a stopped reply is told why its tools stopped, and that it has to answer now
    messages.push({ role: 'user', content: stop?.aborted ? [...toolResults, { type: 'text', text: STOPPED_NOTE }] : toolResults });
  }
  abort?.throwIfAborted();

  // skip any message deleted while the reply was generating, since its delete event found nothing to delete yet
  conversationContext.filter((ctx) => !recentlyDeleted.has(ctx.message_id)).forEach((ctx) => insertConversationMessage(ctx));

  // every reply resends the whole conversation, so once it's this big, wrap it up into a summary and start fresh.
  // a heartbeat's conversation is summarized as soon as it's sent anyway
  if (!heartbeat && getConversationTokenCount(conversation.conversation_id) > MAX_CONVERSATION_TOKENS) {
    endConversation(conversation).catch((error) => console.error(error)); // in the background, so it doesn't hold up anything
  }

  // a heartbeat with nothing worth saying stays silent. its caller decides whether there's anything to summarize
  const replyText = streamStr.trim();
  if (heartbeat && (!replyText || replyText.replace(/[.!]+$/, '') === HEARTBEAT_OK)) return { conversation_id: conversation.conversation_id, chunks: [] };

  const chunks = await formatResponse(conversation.conversation_id, [formatToolHeader(toolCalls), streamStr].filter(Boolean).join('\n\n'));
  return { conversation_id: conversation.conversation_id, chunks };
}

export { ReplyControl, THINKING_STATUS, TYPING_STATUS, STOPPED_STATUS, setWriting, getBaseSystemPrompt, getDefaultSystemPrompt, getSystemPrompt, getEmbedding, formatReactions, formatResponse, chatbotMentions, generateReply, isAllowedServer, markMessageDeleted };
