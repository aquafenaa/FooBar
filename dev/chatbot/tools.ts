import { tool } from 'ai';
import { z as zod } from 'zod';
import cron from 'node-cron';
import { AnyThreadChannel, ChannelType, GuildBasedChannel, GuildTextBasedChannel, Message, PermissionFlagsBits, Snowflake } from 'discord.js';

import { discordClient } from '..';
import { addReminder, deleteCounter, deleteMemory, deleteReminder, getCounter, getCountersByServer, getHeartbeat, getHeartbeatsByServer, insertHeartbeat, updateHeartbeat, getIndexChannel, getNextChannelRef, insertIndexChannel, getReminder, getRemindersByServer, getServer, incrementCounter, insertCounter, insertConversationMessage, setCounterValue, resolveChannelRef, resolveMessageRef, resolveUserRef, updateReminder, upsertMemory } from '../data';
import { MemoryTable, ReminderTable } from '../types/schema';
import { estimateTokens, safeFetch, sendReminder } from '../utils';
import { formatReactions, formatResponse } from './chatbot';
import { MAIN_SOURCE, findMemory, getVisibleMemories, isAttached } from './context';
import { MAX_BOT_HEARTBEATS, removeHeartbeat, scheduleHeartbeat } from './heartbeat';
import { MAX_TIMEOUT, sandboxExec } from './sandbox';
import { captionImage } from './vision';

// filled in by the bot for each reply, rather than by the model, so the model can't get it wrong (or reach another server's memories)
const replyContextSchema = zod.object({
  server_id: zod.string(),
  channel_id: zod.string(), // the channel being replied in
  conversation_id: zod.string(), // the current conversation, whose refs ([#3], [@2]) the model uses
  shareable: zod.boolean(), // whether everyone in the conversation is fine with it reaching other servers
  reference_message_id: zod.string().optional(), // the message the user is replying to, which the model sees as [$0]
});
type ReplyContext = zod.infer<typeof replyContextSchema>;

// [$0] isn't saved like other message refs, since it's whichever message the user is replying to this time
const REPLY_REFS = ['[$0]', '$0', '0'];

const reactToMessage = tool({
  description: 'Reacts to a message with a given emoji. Ensure to give all fields.',
  inputExamples: [
    {
      input: {
        conversation_id: '11234567890123456781298765432109876543',
        server_id: '1087654321098765432',
        channel_ref: '[#0]',
        message_ref: '[$4]',
        emoji: '💗',
      },
    },
    { // reacting to the message the user is replying to, which is always [$0], in the current channel [#0]
      input: {
        conversation_id: '11234567890123456781298765432109876543',
        server_id: '1087654321098765432',
        channel_ref: '[#0]',
        message_ref: '[$0]',
        emoji: '😭',
      },
    },
  ],
  inputSchema: zod.object({
    conversation_id: zod.string().describe('ID of the current conversation'),
    server_id: zod.string().describe('ID of the message\'s server'),
    channel_ref: zod.string().describe('Reference of the message\'s channel'),
    message_ref: zod.string().describe('Reference of the message'),
    emoji: zod.string().describe('Character of the emoji'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { conversation_id: string, server_id: Snowflake, channel_ref: Snowflake, message_ref: string, emoji: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const guild = await discordClient.guilds.fetch(input.server_id);
    if (!guild) {
      return {
        result: 'failure',
        message: `There is no guild with id '${input.server_id}'!`,
      };
    }

    const channelID = resolveChannelRef(input.conversation_id, input.channel_ref) ?? resolveChannelRef(input.conversation_id, `[${input.channel_ref}]`) ?? resolveChannelRef(input.conversation_id, `[#${input.channel_ref}]`);
    if (!channelID) {
      return {
        result: 'failure',
        message: `There is no channel with ref ${input.channel_ref}`,
      };
    }
    const channel = await guild.channels.fetch(channelID);
    if (!channel) {
      return {
        result: 'failure',
        message: `There is no channel with id ${channelID}`,
      };
    }
    if (!channel.isTextBased()) {
      return {
        result: 'failure',
        message: 'This channel is not text based!',
      };
    }

    // [$0] is the message the user is replying to, which the bot passes in. every other ref is saved, so look it up
    const messageID = REPLY_REFS.includes(input.message_ref.trim())
      ? context.reference_message_id
      : resolveMessageRef(input.conversation_id, input.message_ref) ?? resolveMessageRef(input.conversation_id, `[${input.message_ref}]`) ?? resolveMessageRef(input.conversation_id, `[$${input.message_ref}]`);
    if (!messageID) {
      return {
        result: 'failure',
        message: `There is no message with reference ${input.message_ref}`,
      };
    }

    const message = await channel.messages.fetch(messageID);
    if (!message) {
      return {
        result: 'failure',
        message: `There is no message with id ${messageID}`,
      };
    }

    try {
      await message.react(input.emoji);
      return {
        result: 'success',
        message: 'Reacted to message.',
      };
    } catch (error) {
      return {
        result: 'failure',
        message: error?.toString() ?? 'unknown',
      };
    }
  },
});

const MAX_NICKNAME_LENGTH = 32; // Discord's limit

const changeNickname = tool({
  description: 'Change your own nickname in the current server. Give an empty nickname to reset it to your username.',
  inputExamples: [
    { input: { nickname: 'Captain Foo' } },
    { input: { nickname: '' } },
  ],
  inputSchema: zod.object({
    nickname: zod.string().describe(`New nickname, at most ${MAX_NICKNAME_LENGTH} characters. Empty to reset it`),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { nickname: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const nickname = input.nickname.trim();
    if (nickname.length > MAX_NICKNAME_LENGTH) {
      return {
        result: 'failure',
        message: `Nicknames can be at most ${MAX_NICKNAME_LENGTH} characters.`,
      };
    }

    try {
      // the server comes from the bot, so the model can only rename itself where it's replying
      const guild = await discordClient.guilds.fetch(context.server_id);
      const me = guild.members.me ?? await guild.members.fetchMe();
      await me.setNickname(nickname || null);
      return {
        result: 'success',
        message: nickname ? `Changed nickname to "${nickname}".` : 'Reset nickname.',
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.toString() ?? 'unknown',
      };
    }
  },
});

const createReminder = tool({
  description: 'Creates a reminder message that will be sent at the given time',
  inputSchema: zod.object({
    server_id: zod.string().describe('ID of the server to send the reminder to'),
    channel_id: zod.string().describe('ID of the channel the reminder should be sent to'),
    reminder_name: zod.string().describe('Name of the reminder. Must be unique with server'),

    cron_schedule: zod.string().describe('Cron schedule the reminder should be sent at. Hour is 0-23'),
    repeats: zod.boolean().describe('Whether to repeat the schedule (true), or just delete it after a single use (false)'),
    message_content: zod.string().describe('Content of the reminder to send'),
  }),
  inputExamples: [
    {
      input: {
        server_id: '917588427959058462',
        channel_id: '1322395029595226234',
        reminder_name: 'Med Alarm',
        cron_schedule: '0 22 * * *',
        repeats: true,
        message_content: 'It\'s time to take your meds!',
      },
    },
  ],
  execute: async (input: ReminderTable): Promise<{ result: 'success' | 'failure', message: string }> => {
    const server = await discordClient.guilds.fetch(input.server_id);
    if (!server) {
      return {
        result: 'failure',
        message: `There is no server with ID: ${input.server_id}.`,
      };
    }

    const outputChannel = await server.channels.fetch(input.channel_id);
    if (!outputChannel) {
      return {
        result: 'failure',
        message: `There is no message with ID: ${input.channel_id}.`,
      };
    }
    if (!outputChannel.isSendable()) {
      return {
        result: 'failure',
        message: 'This channel is not sendable.',
      };
    }

    const reminder = getReminder(input.server_id, input.reminder_name);
    if (reminder) {
      return {
        result: 'failure',
        message: 'There is already a reminder in this server with this name!',
      };
    }

    if (!cron.validate(input.cron_schedule)) {
      return {
        result: 'failure',
        message: `Cron schedule is invalid: ${input.cron_schedule}.`,
      };
    }

    addReminder(input);
    cron.schedule(input.cron_schedule, () => sendReminder(outputChannel, input.server_id, input.reminder_name), {
      name: `${input.server_id}${input.reminder_name}`,
    });

    return {
      result: 'success',
      message: 'Successfully created a new reminder.',
    };
  },
});
const editReminder = tool({
  description: 'Edit an already existing tool',
  inputSchema: zod.object({
    server_id: zod.string().describe('ID of the server to send the reminder to'),
    channel_id: zod.string().describe('ID of the channel the reminder should be sent to'),
    reminder_name: zod.string().describe('Name of the reminder. Must be unique with server'),

    cron_schedule: zod.string().describe('Cron schedule the reminder should be sent at'),
    repeats: zod.boolean().describe('Whether to repeat the schedule (true), or just delete it after a single use (false)'),
    message_content: zod.string().describe('Content of the reminder to send'),
  }),
  execute: async (input: ReminderTable): Promise<{ result: 'success' | 'failure', message: string }> => {
    const server = await discordClient.guilds.fetch(input.server_id);
    if (!server) {
      return {
        result: 'failure',
        message: `There is no server with ID: ${input.server_id}.`,
      };
    }

    const outputChannel = await server.channels.fetch(input.channel_id);
    if (!outputChannel) {
      return {
        result: 'failure',
        message: `There is no message with ID: ${input.channel_id}.`,
      };
    }
    if (!outputChannel.isSendable()) {
      return {
        result: 'failure',
        message: 'This channel is not sendable.',
      };
    }

    const reminder = getReminder(input.server_id, input.reminder_name);
    if (!reminder) {
      return {
        result: 'failure',
        message: 'There is no reminder with this name!',
      };
    }
    if (!cron.validate(input.cron_schedule)) {
      return {
        result: 'failure',
        message: `Cron schedule is invalid: ${input.cron_schedule}.`,
      };
    }

    try {
      // if schedule has changed, recreate cron task
      if (input.cron_schedule !== reminder.cron_schedule || input.channel_id !== reminder.channel_id) {
        cron.getTasks().forEach((task) => {
          if (task.name === `${reminder.server_id}${reminder.reminder_name}`) {
            task.destroy();
          }
        });

        cron.schedule(input.cron_schedule, () => sendReminder(outputChannel, input.server_id, input.reminder_name), {
          name: `${input.server_id}${input.reminder_name}`,
        });
      }

      reminder.cron_schedule = input.cron_schedule;
      reminder.channel_id = input.channel_id;
      reminder.message_content = input.message_content;
      reminder.repeats = input.repeats;

      updateReminder(reminder);

      return {
        result: 'success',
        message: 'Successfully edited reminder',
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error.toString(),
      };
    }
  },
});
const listReminders = tool({
  inputSchema: zod.object({
    server_id: zod.string().describe('ID of server to view reminders of'),
  }),
  execute: async (input: { server_id: string }): Promise<{ result: 'success' | 'failure', reminders: ReminderTable[], message: string }> => {
    const server = getServer(input.server_id);
    if (!server) {
      return {
        result: 'failure',
        reminders: [],
        message: 'There is no server with this server ID!',
      };
    }
    const reminders = getRemindersByServer(input.server_id);
    if (!reminders) {
      return {
        result: 'failure',
        reminders: [],
        message: `There are no reminders with id: ${input.server_id}`,
      };
    }

    return {
      result: 'success',
      reminders,
      message: 'Successfully retrieved reminders from server',
    };
  },
});
const viewReminder = tool({
  inputSchema: zod.object({
    server_id: zod.string().describe('ID of server to view reminders of'),
    reminder_name: zod.string().describe('Name of the reminder of the server'),
  }),
  execute: async (input: { server_id: string, reminder_name: string }): Promise<{ result: 'success' | 'failure', reminder?: ReminderTable, message: string }> => {
    const server = getServer(input.server_id);
    if (!server) {
      return {
        result: 'failure',
        message: 'There is no server with this ID!',
      };
    }

    const reminder = getReminder(input.server_id, input.reminder_name);
    if (!reminder) {
      return {
        result: 'failure',
        message: 'There is no reminder with this name!',
      };
    }

    return {
      result: 'success',
      reminder,
      message: 'Successfully retrieved reminder',
    };
  },
});
const removeReminder = tool({
  inputSchema: zod.object({
    server_id: zod.string().describe('ID of server to view reminders of'),
    reminder_name: zod.string().describe('Name of the reminder of the server'),
  }),
  execute: async (input: { server_id: string, reminder_name: string }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const server = getServer(input.server_id);
    if (!server) {
      return {
        result: 'failure',
        message: 'There is no server with this ID!',
      };
    }

    const reminder = getReminder(input.server_id, input.reminder_name);
    if (!reminder) {
      return {
        result: 'failure',
        message: 'There is no reminder with this ID!',
      };
    }

    try {
      deleteReminder(reminder);
      return {
        result: 'success',
        message: 'Successfully deleted reminder',
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error.toString(),
      };
    }
  },
});


const createMemory = tool({
  description: 'Create a memory that can be read at any time, even in later conversations.',
  inputSchema: zod.object({
    name: zod.string().describe('Name of the memory. Not case-sensitive'),
    content: zod.string().describe('Content of the memory.'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string, content: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    if (findMemory(context.server_id, input.name)) {
      return {
        result: 'failure',
        message: 'There is already a memory with this name!',
      };
    }

    // shared with other servers only if everyone in the conversation opted in. otherwise, it stays in this server
    const sourceID = context.shareable ? MAIN_SOURCE : context.server_id;
    try {
      upsertMemory({ source_id: sourceID, name: input.name, content: input.content });
      return {
        result: 'success',
        message: 'Successfully created memory!',
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error.toString(),
      };
    }
  },
});
const listMemories = tool({
  description: 'List all memories.',
  inputSchema: zod.object({}),
  contextSchema: replyContextSchema,
  execute: async (_input: Record<string, never>, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', memories?: MemoryTable[], message: string }> => {
    const memories = getVisibleMemories(context.server_id);
    if (memories.length === 0) {
      return {
        result: 'success',
        message: 'There are no memories!',
      };
    }

    return {
      result: 'success',
      memories,
      message: 'Successfully retrieved memories.',
    };
  },
});
const viewMemory = tool({
  description: 'View the content of a specific memory.',
  inputSchema: zod.object({
    name: zod.string().describe('Name of the memory. Not case-sensitive'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', memory?: MemoryTable, message: string }> => {
    const memory = findMemory(context.server_id, input.name);
    if (!memory) {
      return {
        result: 'failure',
        message: 'There is no memory with this name!',
      };
    }

    return {
      result: 'success',
      message: 'Successfully retrieved memory',
      memory,
    };
  },
});
const editMemory = tool({
  description: 'Edit the content of a specific memory.',
  inputSchema: zod.object({
    name: zod.string().describe('Name of the memory. Not case-sensitive'),
    content: zod.string().describe('New content of the memory.'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string, content: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const memory = findMemory(context.server_id, input.name);
    if (!memory) {
      return {
        result: 'failure',
        message: 'There is no memory with this name!',
      };
    }
    // the new content could come from someone who didn't opt in, so it can't go into a shared memory
    if (memory.source_id === MAIN_SOURCE && !context.shareable) {
      return {
        result: 'failure',
        message: 'This memory is shared with other servers, and not everyone in this conversation has opted in to sharing, so it can\'t be edited here.',
      };
    }

    memory.content = input.content;
    try {
      upsertMemory(memory);
      return {
        result: 'success',
        message: 'Successfully edited memory!',
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error.toString(),
      };
    }
  },
});
const removeMemory = tool({
  description: 'Delete a specified memory.',
  inputSchema: zod.object({
    name: zod.string().describe('Name of the memory. Not case-sensitive'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const memory = findMemory(context.server_id, input.name);
    if (!memory) {
      return {
        result: 'failure',
        message: 'There is no memory with this name!',
      };
    }

    try {
      deleteMemory(memory.source_id, memory.name);
      return {
        result: 'success',
        message: 'Successfully deleted memory!',
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error.toString(),
      };
    }
  },
});

const FETCH_TIMEOUT = 15_000; // 15 seconds, so a slow server can't hold up the reply forever
const MAX_FETCH_LENGTH = 20_000; // characters of response body given back, so a huge page can't overflow the prompt

const fetchURL = tool({
  description: 'Send an HTTP request to a URL, and get back the response. Use it to read web pages or APIs, or to send data to a server (e.g. POST JSON). '
    + 'The response body is cut off after 20,000 characters.',
  inputExamples: [
    { input: { url: 'https://example.com/api/items/123', method: 'GET' } },
    {
      input: {
        url: 'https://example.com/api/items',
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: '{"name":"example"}',
      },
    },
  ],
  inputSchema: zod.object({
    url: zod.string().describe('Full URL, including https://'),
    method: zod.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']).optional().describe('HTTP method. Defaults to GET'),
    headers: zod.record(zod.string(), zod.string()).optional().describe('Request headers, e.g. { "Content-Type": "application/json" }'),
    body: zod.string().optional().describe('Request body, as a string. For JSON, stringify it and set the Content-Type header'),
  }),
  execute: async (input: { url: string, method?: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE', headers?: Record<string, string>, body?: string }): Promise<{ result: 'success' | 'failure', status?: number, content_type?: string, body?: string, truncated?: boolean, message: string }> => {
    const method = input.method ?? 'GET';
    try {
      const response = await fetch(input.url, {
        method,
        headers: input.headers,
        body: method === 'GET' ? undefined : input.body, // GET requests can't have a body
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });

      const text = await response.text();
      return {
        result: response.ok ? 'success' : 'failure',
        status: response.status,
        content_type: response.headers.get('content-type') ?? undefined,
        body: text.substring(0, MAX_FETCH_LENGTH),
        truncated: text.length > MAX_FETCH_LENGTH,
        message: response.ok ? 'Request succeeded.' : `The server responded with status ${response.status}.`,
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.name === 'TimeoutError' ? `The request timed out after ${FETCH_TIMEOUT / 1000} seconds.` : String(error),
      };
    }
  },
});

const captionImageTool = tool({
  description: 'Look at an image at a URL, and get back a short description of it, including any text in it. '
    + 'Use it on images you find mid-response (e.g. from a web search or a fetched page), or to look again at an image in the conversation, which are shown as "(url) [image: caption]". '
    + 'Give a question to have it look for something specific. Only works on JPEG, PNG, GIF, and WebP images up to 5MB.',
  inputExamples: [
    { input: { url: 'https://example.com/images/chart.png' } },
    { input: { url: 'https://example.com/menu.jpg', question: 'How much is the large pepperoni pizza?' } },
  ],
  inputSchema: zod.object({
    url: zod.string().describe('Full URL of the image, including https://'),
    question: zod.string().optional().describe('Something specific to look for or answer about the image'),
  }),
  execute: async (input: { url: string, question?: string }): Promise<{ result: 'success' | 'failure', caption?: string, message: string }> => {
    try {
      const caption = await captionImage(input.url, input.question);
      return { result: 'success', caption, message: 'Captioned image.' };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.name === 'TimeoutError' ? 'Fetching the image timed out after 15 seconds.' : String(error?.message ?? error),
      };
    }
  },
});

// X's API bills $0.005 per post returned, and won't return fewer than 10, so every search costs about 5 cents
const X_SEARCH_RESULTS = 10;

const xSearch = tool({
  description: 'Search recent posts on X (Twitter) from the last 7 days. '
    + 'COSTS MONEY: $0.005 (half a cent) per post returned, and each search returns up to 10 posts, so about 5 cents per use. '
    + 'Only use it when X posts are actually needed; prefer web search for anything else. '
    + 'Supports X search operators, e.g. "from:handle", "#hashtag", "lang:en", "-is:retweet".',
  inputExamples: [
    { input: { query: 'from:nasa artemis -is:retweet' } },
    { input: { query: '"new album" lang:en -is:retweet', sort: 'relevancy' } },
  ],
  inputSchema: zod.object({
    query: zod.string().describe('X search query. Adding -is:retweet avoids paying for duplicate retweets'),
    sort: zod.enum(['recency', 'relevancy']).optional().describe('Newest posts first, or most relevant first. Defaults to recency'),
  }),
  execute: async (input: { query: string, sort?: 'recency' | 'relevancy' }): Promise<{ result: 'success' | 'failure', posts?: { url: string, text: string, author_id: string, created_at: string, likes?: number, reposts?: number }[], message: string }> => {
    const { TWITTER_API_KEY } = process.env;
    if (!TWITTER_API_KEY) {
      return { result: 'failure', message: 'X search isn\'t set up: there is no TWITTER_API_KEY.' };
    }

    // no author expansion, since X bills each user returned too. the post link works without a username
    const params = new URLSearchParams({
      query: input.query,
      max_results: String(X_SEARCH_RESULTS),
      sort_order: input.sort ?? 'recency',
      'tweet.fields': 'created_at,author_id,public_metrics',
    });

    try {
      const response = await fetch(`https://api.x.com/2/tweets/search/recent?${params}`, {
        headers: { Authorization: `Bearer ${TWITTER_API_KEY}` },
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      });
      const data = await response.json().catch(() => ({}));

      if (!response.ok) {
        return { result: 'failure', message: `X responded with status ${response.status}: ${data.detail ?? data.title ?? JSON.stringify(data.errors ?? data)}` };
      }

      const posts = (data.data ?? []).map((post: any) => ({
        url: `https://x.com/i/web/status/${post.id}`,
        text: post.text,
        author_id: post.author_id,
        created_at: post.created_at,
        likes: post.public_metrics?.like_count,
        reposts: post.public_metrics?.retweet_count,
      }));

      return {
        result: 'success',
        posts,
        message: posts.length === 0 ? 'No posts matched this search in the last 7 days.' : `Found ${posts.length} posts.`,
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.name === 'TimeoutError' ? `The search timed out after ${FETCH_TIMEOUT / 1000} seconds.` : String(error),
      };
    }
  },
});

// one tool with an action, rather than five, to keep the tool list short. same counters as the /counter command
const counter = tool({
  description: 'Use the server\'s counters: named numbers people keep track of (e.g. how many times something happened). '
    + 'Actions: "list" all counters, "create" a new one, "add" to one (negative to subtract), "set" one to a value, or "delete" one. Names aren\'t case-sensitive.',
  inputExamples: [
    { input: { action: 'list' } },
    { input: { action: 'add', name: 'Deaths', amount: 1 } },
    { input: { action: 'create', name: 'Pizza Nights', value: 0 } },
  ],
  inputSchema: zod.object({
    action: zod.enum(['list', 'create', 'add', 'set', 'delete']),
    name: zod.string().optional().describe('Name of the counter. Needed for every action except list'),
    amount: zod.number().int().optional().describe('For add: how much to add. Negative to subtract. Defaults to 1'),
    value: zod.number().int().optional().describe('For create: the starting value, defaulting to 0. For set: the new value'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { action: 'list' | 'create' | 'add' | 'set' | 'delete', name?: string, amount?: number, value?: number }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', counters?: { name: string, value: number }[], value?: number, message: string }> => {
    const serverID = context.server_id; // from the bot, so it can only touch this server's counters

    if (input.action === 'list') {
      const counters = getCountersByServer(serverID).map((c) => ({ name: c.counter_name, value: c.value }));
      return { result: 'success', counters, message: counters.length === 0 ? 'There are no counters in this server.' : `Found ${counters.length} counters.` };
    }

    if (!input.name) return { result: 'failure', message: `A name is needed to ${input.action} a counter.` };
    const existing = getCounter(serverID, input.name);

    if (input.action === 'create') {
      if (existing) return { result: 'failure', message: `There's already a counter named "${existing.counter_name}", at ${existing.value}.` };
      if (input.name.length > 40) return { result: 'failure', message: 'Counter names can be at most 40 characters.' };

      const value = input.value ?? 0;
      insertCounter({ server_id: serverID, counter_name: input.name, value });
      return { result: 'success', value, message: `Created counter "${input.name}", starting at ${value}.` };
    }

    // every other action needs the counter to exist
    if (!existing) return { result: 'failure', message: `There's no counter named "${input.name}". Use the list action to see them.` };

    if (input.action === 'add') {
      const amount = input.amount ?? 1;
      const value = incrementCounter(serverID, existing.counter_name, amount);
      return { result: 'success', value, message: `"${existing.counter_name}" is now ${value} (${amount >= 0 ? '+' : ''}${amount}).` };
    }
    if (input.action === 'set') {
      if (input.value === undefined) return { result: 'failure', message: 'A value is needed to set a counter.' };

      setCounterValue(serverID, existing.counter_name, input.value);
      return { result: 'success', value: input.value, message: `"${existing.counter_name}" set to ${input.value} (was ${existing.value}).` };
    }

    deleteCounter(serverID, existing.counter_name);
    return { result: 'success', message: `Deleted counter "${existing.counter_name}". It was at ${existing.value}.` };
  },
});

const MAX_FETCH_MESSAGES = 50; // most messages fetch_channel gives back at once
const SEARCH_SCAN_LIMIT = 500; // how far back search_channel looks, since bots can't use discord's own search
const MAX_SEARCH_RESULTS = 20;
const MAX_CHANNEL_MESSAGE_LENGTH = 1000; // characters of each message given back, so a few long ones can't fill the prompt

/**
 * A channel in this server, from a ref like [#3], a <#id> mention, or a plain id. Defaults to the channel being replied in.
 * Returns why not instead, worded to give to the model as-is
 */
async function resolveChannel(context: ReplyContext, channelInput?: string): Promise<GuildBasedChannel | string> {
  const raw = channelInput?.trim();
  let channelID: string | undefined = context.channel_id;
  // [#0] is always the current channel, and isn't saved like other refs
  if (raw && !['[#0]', '#0', '0'].includes(raw)) {
    const idMatch = /^<?#?(\d{17,20})>?$/.exec(raw);
    channelID = idMatch
      ? idMatch[1]
      : resolveChannelRef(context.conversation_id, raw) ?? resolveChannelRef(context.conversation_id, `[${raw}]`) ?? resolveChannelRef(context.conversation_id, `[#${raw}]`);
  }
  if (!channelID) return `There is no channel with ref ${raw}.`;

  // fetched through this server, so a channel in another server is never found
  const guild = await safeFetch(() => discordClient.guilds.fetch(context.server_id));
  const channel = await safeFetch(() => guild!.channels.fetch(channelID));
  if (!channel) return `There is no channel ${raw ?? channelID} in this server.`;

  return channel;
}
// same, but only text channels (including threads and voice channels' chats)
async function resolveTextChannel(context: ReplyContext, channelInput?: string): Promise<GuildTextBasedChannel | string> {
  const channel = await resolveChannel(context, channelInput);
  if (typeof channel === 'string') return channel;
  if (!channel.isTextBased()) return 'This channel is not text based!';

  return channel;
}

/**
 * Counts one more use of a limited tool this reply, returning false if the limit's already reached.
 * Keyed by the reply's context object, which the bot makes once per reply and passes to every tool call.
 * Call it before anything is awaited, so calls made at the same time can't all slip under the limit
 */
function countUse(counts: WeakMap<ReplyContext, number>, context: ReplyContext, max: number): boolean {
  const used = counts.get(context) ?? 0;
  if (used >= max) return false;

  counts.set(context, used + 1);
  return true;
}

// saved as the bot's turn, so what it sends outside its reply is in the conversation's summary
function saveSentMessage(context: ReplyContext, sent: Message<boolean>): void {
  insertConversationMessage({
    conversation_id: context.conversation_id,
    message_id: sent.id,
    role: 'assistant',
    author_id: sent.author.id,
    author_name: sent.author.displayName,
    timestamp: sent.createdTimestamp,
    message_content: sent.content,
    token_count: estimateTokens(sent.content),
  });
}

// a channel's ref in this conversation, like [#4], made if it doesn't have one yet, so the model can use it in later tool calls
function channelRef(context: ReplyContext, channelID: string): string {
  const existing = getIndexChannel(context.conversation_id, channelID);
  if (existing) return existing.shorthand;

  const shorthand = `[#${getNextChannelRef(context.conversation_id)}]`;
  insertIndexChannel({ conversation_id: context.conversation_id, channel_id: channelID, shorthand });
  return shorthand;
}

// the current channel, or one everyone in the server can see, so a private channel's messages can't be read out to people who couldn't see them
function isPublicOrCurrent(channel: GuildTextBasedChannel, context: ReplyContext): boolean {
  if (channel.id === context.channel_id) return true;
  if (channel.type === ChannelType.PrivateThread) return false; // takes its parent's permissions, even though only its members can see it

  return !!channel.permissionsFor(channel.guild.roles.everyone)?.has(PermissionFlagsBits.ViewChannel);
}

const PRIVATE_CHANNEL_MESSAGE = 'This channel is private, so its messages can only be read from inside it.';

function toChannelMessage(message: Message<boolean>) {
  return {
    id: message.id,
    author: message.member?.displayName ?? message.author.displayName,
    author_id: message.author.id,
    bot: message.author.bot,
    time: new Date(message.createdTimestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
    reply_to: message.reference?.messageId,
    content: message.content.substring(0, MAX_CHANNEL_MESSAGE_LENGTH),
    attachments: message.attachments.size > 0 ? message.attachments.map((attachment) => attachment.url) : undefined,
    reactions: formatReactions(message) || undefined,
  };
}
type ChannelMessage = ReturnType<typeof toChannelMessage>;

// what a channel is for: its name, its description (topic), and for a thread, the channel it's in
function describeChannel(channel: GuildTextBasedChannel): { name: string, description?: string, thread_in?: string } {
  const topic = 'topic' in channel ? channel.topic : undefined;
  return {
    name: channel.name,
    description: topic || undefined,
    thread_in: channel.isThread() ? channel.parent?.name : undefined,
  };
}

const fetchChannel = tool({
  description: `Read the most recent messages in a channel, oldest first. Up to ${MAX_FETCH_MESSAGES} at once. Also gives the channel's name and description. `
    + 'Defaults to this channel. Other channels can only be read if everyone in the server can see them.',
  inputExamples: [
    { input: { count: 20 } },
    { input: { channel: '[#2]', count: 10 } },
  ],
  inputSchema: zod.object({
    channel: zod.string().optional().describe('Reference of the channel, e.g. [#2], or its id. Defaults to this channel'),
    count: zod.number().int().optional().describe(`How many messages, from 1 to ${MAX_FETCH_MESSAGES}. Defaults to 20`),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { channel?: string, count?: number }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', channel?: ReturnType<typeof describeChannel>, messages?: ChannelMessage[], message: string }> => {
    const channel = await resolveTextChannel(context, input.channel);
    if (typeof channel === 'string') return { result: 'failure', message: channel };
    if (!isPublicOrCurrent(channel, context)) return { result: 'failure', message: PRIVATE_CHANNEL_MESSAGE };

    try {
      const count = Math.min(Math.max(input.count ?? 20, 1), MAX_FETCH_MESSAGES);
      const messages = [...(await channel.messages.fetch({ limit: count })).values()].reverse().map(toChannelMessage);
      return { result: 'success', channel: describeChannel(channel), messages, message: `Fetched ${messages.length} messages from #${channel.name}.` };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

const searchChannel = tool({
  description: `Search a channel's last ${SEARCH_SCAN_LIMIT} messages for text, a user, or both, newest first. Up to ${MAX_SEARCH_RESULTS} matches. `
    + 'Text matching isn\'t case-sensitive. Defaults to this channel. Other channels can only be searched if everyone in the server can see them.',
  inputExamples: [
    { input: { query: 'movie night' } },
    { input: { channel: '[#2]', author: '[@3]' } },
  ],
  inputSchema: zod.object({
    channel: zod.string().optional().describe('Reference of the channel, e.g. [#2], or its id. Defaults to this channel'),
    query: zod.string().optional().describe('Text the message must contain'),
    author: zod.string().optional().describe('Who sent it: a reference like [@3], a user id, or part of their name'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { channel?: string, query?: string, author?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', messages?: ChannelMessage[], scanned?: number, message: string }> => {
    if (!input.query && !input.author) return { result: 'failure', message: 'Give a query, an author, or both to search for.' };

    const channel = await resolveTextChannel(context, input.channel);
    if (typeof channel === 'string') return { result: 'failure', message: channel };
    if (!isPublicOrCurrent(channel, context)) return { result: 'failure', message: PRIVATE_CHANNEL_MESSAGE };

    const query = input.query?.toLowerCase();
    const author = input.author?.trim();
    const authorID = author && (/^<?@?!?(\d{17,20})>?$/.exec(author)?.[1] ?? resolveUserRef(context.conversation_id, author) ?? resolveUserRef(context.conversation_id, `[${author}]`) ?? resolveUserRef(context.conversation_id, `[@${author}]`));
    const authorName = author?.toLowerCase();

    const matches = (message: Message<boolean>) => {
      if (query && !message.content.toLowerCase().includes(query)) return false;
      if (!author) return true;
      if (authorID) return message.author.id === authorID;
      return [message.member?.displayName, message.author.displayName, message.author.username].some((name) => name?.toLowerCase().includes(authorName!));
    };

    try {
      const found: Message<boolean>[] = [];
      let scanned = 0;
      let before: string | undefined;
      // 100 at a time, the most discord gives per request
      while (scanned < SEARCH_SCAN_LIMIT && found.length < MAX_SEARCH_RESULTS) {
        const page = [...(await channel.messages.fetch({ limit: 100, before })).values()];
        if (page.length === 0) break;

        scanned += page.length;
        before = page[page.length - 1].id;
        found.push(...page.filter(matches));
      }

      const messages = found.slice(0, MAX_SEARCH_RESULTS).map(toChannelMessage);
      return {
        result: 'success',
        messages,
        scanned,
        message: messages.length === 0 ? `No matches in the last ${scanned} messages of #${channel.name}.` : `Found ${messages.length} matches in the last ${scanned} messages of #${channel.name}.`,
      };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

const MAX_SENDS_PER_REPLY = 5;
const sendCounts = new WeakMap<ReplyContext, number>(); // send_message calls so far, per reply

const sendMessage = tool({
  description: 'Send a message to a channel in this server, separate from your reply. Use it to post somewhere else, or to post more than one message. '
    + `Refs like [@2] and [#3] work the same as in your replies. At most ${MAX_SENDS_PER_REPLY} per reply.`,
  inputExamples: [
    { input: { channel: '[#3]', content: 'Movie night starts in 10 minutes! 🍿' } },
  ],
  inputSchema: zod.object({
    channel: zod.string().optional().describe('Reference of the channel, e.g. [#3], or its id. Defaults to this channel'),
    content: zod.string().describe('Content of the message. Long messages are split up'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { channel?: string, content: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message_ids?: string[], message: string }> => {
    if (!input.content.trim()) return { result: 'failure', message: 'The message is empty.' };

    if (!countUse(sendCounts, context, MAX_SENDS_PER_REPLY)) return { result: 'failure', message: `You've already sent ${MAX_SENDS_PER_REPLY} messages this reply, the most allowed.` };

    const channel = await resolveTextChannel(context, input.channel);
    if (typeof channel === 'string') return { result: 'failure', message: channel };
    if (!channel.isSendable()) return { result: 'failure', message: 'I can\'t send messages in this channel.' };

    try {
      const chunks = await formatResponse(context.conversation_id, input.content);
      const messageIDs: string[] = [];
      for (const chunk of chunks) {
        const sent = await channel.send({ content: chunk }); // one at a time, so they arrive in order
        messageIDs.push(sent.id);
        saveSentMessage(context, sent);
      }

      return { result: 'success', message_ids: messageIDs, message: `Sent ${messageIDs.length} message${messageIDs.length === 1 ? '' : 's'} in #${channel.name}.` };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

const MAX_THREADS_PER_REPLY = 2;
const threadCounts = new WeakMap<ReplyContext, number>(); // create_thread calls so far, per reply
const MAX_THREAD_NAME_LENGTH = 100; // discord's limit

const createThread = tool({
  description: 'Create a public thread in a channel, either on its own or started from a message, like Discord\'s "Create Thread". '
    + 'You can post a first message in it. In a forum channel, the first message is required, since it\'s the post. '
    + `Gives back the thread's ref (e.g. [#5]), which works with send_message and fetch_channel. At most ${MAX_THREADS_PER_REPLY} per reply.`,
  inputExamples: [
    { input: { name: 'Movie night plans', message: '[$0]' } },
    { input: { name: 'Book club: chapter 3', channel: '[#2]', content: 'Discuss chapter 3 here! No spoilers past it, please.' } },
  ],
  inputSchema: zod.object({
    name: zod.string().describe(`Title of the thread. At most ${MAX_THREAD_NAME_LENGTH} characters`),
    channel: zod.string().optional().describe('Reference of the channel to make it in, e.g. [#2], or its id. Defaults to this channel'),
    message: zod.string().optional().describe('Reference of a message in that channel to start it from, e.g. [$4]. Leave out for a thread on its own'),
    content: zod.string().optional().describe('First message to post in the thread. Refs like [@2] work the same as in your replies. Required in forum channels'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string, channel?: string, message?: string, content?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', thread?: string, message: string }> => {
    const name = input.name.trim();
    if (!name) return { result: 'failure', message: 'The thread needs a name.' };
    if (name.length > MAX_THREAD_NAME_LENGTH) return { result: 'failure', message: `Thread names can be at most ${MAX_THREAD_NAME_LENGTH} characters.` };
    if (!countUse(threadCounts, context, MAX_THREADS_PER_REPLY)) return { result: 'failure', message: `You've already made ${MAX_THREADS_PER_REPLY} threads this reply, the most allowed.` };

    const channel = await resolveChannel(context, input.channel);
    if (typeof channel === 'string') return { result: 'failure', message: channel };

    try {
      const chunks = input.content?.trim() ? await formatResponse(context.conversation_id, input.content) : [];
      let thread: AnyThreadChannel;
      let rest = chunks; // what's left to post in the thread once it's made

      if (channel.type === ChannelType.GuildForum) {
        if (chunks.length === 0) return { result: 'failure', message: 'A forum post needs a first message, as its content.' };

        thread = await channel.threads.create({ name, message: { content: chunks[0] } });
        rest = chunks.slice(1);
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (starter) saveSentMessage(context, starter);
      } else if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
        if (input.message) {
          const ref = input.message.trim();
          // [$0] is the message the user is replying to, which the bot passes in. every other ref is saved, so look it up
          const messageID = REPLY_REFS.includes(ref)
            ? context.reference_message_id
            : /^\d{17,20}$/.exec(ref)?.[0] ?? resolveMessageRef(context.conversation_id, ref) ?? resolveMessageRef(context.conversation_id, `[${ref}]`) ?? resolveMessageRef(context.conversation_id, `[$${ref}]`);
          const message = messageID ? await safeFetch(() => channel.messages.fetch(messageID)) : undefined;
          if (!message) return { result: 'failure', message: `There is no message ${ref} in #${channel.name}.` };
          if (message.thread) return { result: 'failure', message: `That message already has a thread: ${channelRef(context, message.thread.id)}.` };

          thread = await message.startThread({ name });
        } else {
          if (channel.type === ChannelType.GuildAnnouncement) return { result: 'failure', message: 'In announcement channels, a thread has to start from a message.' };

          thread = await channel.threads.create({ name, type: ChannelType.PublicThread }); // public only, so nobody's left out of what the bot says in it
        }
      } else {
        return { result: 'failure', message: 'Threads can only be made in text, announcement, and forum channels.' };
      }

      for (const chunk of rest) saveSentMessage(context, await thread.send({ content: chunk })); // one at a time, so they arrive in order

      const ref = channelRef(context, thread.id);
      return { result: 'success', thread: ref, message: `Created thread "${thread.name}" (${ref}) in #${channel.name}.` };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

// at most hourly: the minute (and second, if given) must be one fixed number, so a beat can't fire every minute
function isAtMostHourly(cronSchedule: string): boolean {
  const fields = cronSchedule.trim().split(/\s+/);
  const timeFields = fields.length === 6 ? fields.slice(0, 2) : fields.slice(0, 1);
  return timeFields.every((field) => /^\d+$/.test(field));
}

// one tool with an action, like counter. the bot can only change the heartbeats it scheduled itself, not ones an admin made
const heartbeat = tool({
  description: 'Schedule a heartbeat: a prompt you\'ll be given on a cron schedule, in this channel, so you can post on your own later (e.g. check back on something, or a daily check-in). '
    + `Actions: "list" this server's heartbeats, "create" one, "edit" one, or "delete" one. You can only edit or delete ones you made, and have at most ${MAX_BOT_HEARTBEATS}. `
    + 'Schedules are cron, at most hourly (the minute must be a fixed number). Set repeats to false for one that runs once, then deletes itself.',
  inputExamples: [
    { input: { action: 'create', name: 'Check exam results', prompt: 'Sam (user id 1087654321098765432) gets their exam results today. Ping them with <@1087654321098765432> and ask how it went.', schedule: '0 17 21 10 *', repeats: false } },
    { input: { action: 'create', name: 'Morning check-in', prompt: 'Post a short good morning, and mention any reminders due today.', schedule: '0 9 * * *', repeats: true } },
    { input: { action: 'list' } },
  ],
  inputSchema: zod.object({
    action: zod.enum(['list', 'create', 'edit', 'delete']),
    name: zod.string().optional().describe('Name of the heartbeat. Needed for every action except list. Not case-sensitive'),
    prompt: zod.string().optional().describe('For create and edit: what you\'ll be told when it runs. Write it as a note to your future self, with everything you\'ll need. Refs like [@2] won\'t mean anything by then, so use names and ids'),
    context: zod.string().optional().describe('For create and edit: background you\'ll be shown with the prompt, e.g. what was said that it\'s following up on. You won\'t see the channel unless you fetch it'),
    schedule: zod.string().optional().describe('For create and edit: cron schedule it runs on. Hour is 0-23'),
    repeats: zod.boolean().optional().describe('For create and edit: whether it keeps running on the schedule (true), or runs once then deletes itself (false). Defaults to false'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { action: 'list' | 'create' | 'edit' | 'delete', name?: string, prompt?: string, context?: string, schedule?: string, repeats?: boolean }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', heartbeats?: { name: string, schedule: string, repeats: boolean, channel_id: string, prompt: string, context?: string, made_by_you: boolean }[], message: string }> => {
    const serverID = context.server_id; // from the bot, so it can only touch this server's heartbeats
    const botID = discordClient.user!.id;

    if (input.action === 'list') {
      const heartbeats = getHeartbeatsByServer(serverID).map((hb) => ({
        name: hb.heartbeat_name, schedule: hb.cron_schedule, repeats: !!hb.repeats, channel_id: hb.channel_id, prompt: hb.prompt, context: hb.context ?? undefined, made_by_you: hb.created_by === botID,
      }));
      return { result: 'success', heartbeats, message: heartbeats.length === 0 ? 'There are no heartbeats in this server.' : `Found ${heartbeats.length} heartbeats.` };
    }

    if (!input.name) return { result: 'failure', message: `A name is needed to ${input.action} a heartbeat.` };
    const existing = getHeartbeat(serverID, input.name);

    if (input.schedule !== undefined) {
      if (!cron.validate(input.schedule)) return { result: 'failure', message: `Cron schedule is invalid: ${input.schedule}.` };
      if (!isAtMostHourly(input.schedule)) return { result: 'failure', message: 'Heartbeats can run at most hourly: the minute must be a fixed number, not * or a range.' };
    }

    if (input.action === 'create') {
      if (existing) return { result: 'failure', message: `There's already a heartbeat named "${existing.heartbeat_name}".` };
      if (input.name.length > 40) return { result: 'failure', message: 'Heartbeat names can be at most 40 characters.' };
      if (!input.prompt || !input.schedule) return { result: 'failure', message: 'A prompt and a schedule are needed to create a heartbeat.' };
      if (getHeartbeatsByServer(serverID).filter((hb) => hb.created_by === botID).length >= MAX_BOT_HEARTBEATS) {
        return { result: 'failure', message: `You already have ${MAX_BOT_HEARTBEATS} heartbeats in this server. Delete one first.` };
      }

      const created = { server_id: serverID, heartbeat_name: input.name, channel_id: context.channel_id, created_by: botID, repeats: input.repeats ?? false, cron_schedule: input.schedule, prompt: input.prompt, context: input.context };
      insertHeartbeat(created);
      scheduleHeartbeat(created);
      return { result: 'success', message: `Scheduled heartbeat "${input.name}" (${input.schedule}${created.repeats ? ', repeating' : ', once'}).` };
    }

    // every other action needs a heartbeat this bot made
    if (!existing) return { result: 'failure', message: `There's no heartbeat named "${input.name}". Use the list action to see them.` };
    if (existing.created_by !== botID) return { result: 'failure', message: `"${existing.heartbeat_name}" was made by an admin, so only they can change it, with /heartbeat.` };

    if (input.action === 'edit') {
      if (input.prompt === undefined && input.context === undefined && input.schedule === undefined && input.repeats === undefined) return { result: 'failure', message: 'Give a new prompt, context, schedule, or repeats to edit.' };

      const edited = {
        ...existing,
        prompt: input.prompt ?? existing.prompt,
        context: input.context ?? existing.context,
        cron_schedule: input.schedule ?? existing.cron_schedule,
        repeats: input.repeats ?? !!existing.repeats,
      };
      updateHeartbeat(edited);
      scheduleHeartbeat(edited);
      return { result: 'success', message: `Edited heartbeat "${existing.heartbeat_name}".` };
    }

    removeHeartbeat(existing);
    return { result: 'success', message: `Deleted heartbeat "${existing.heartbeat_name}".` };
  },
});

const SANDBOX_DESCRIPTION = 'Your own persistent Linux workspace (Debian, with python3, pip, git, curl, and jq, and internet access). '
  + 'Everything you save there is kept between replies, conversations, and every server you share memories with. '
  + 'Keep NOTES.md up to date with what you\'re working on and anything you\'ll want later: it\'s shown to you at the start of every reply.';
const DETACHED_MESSAGE = 'The workspace is only available in servers attached to the shared context.';

const runCommand = tool({
  description: `Run a bash command in your workspace, and get back its output. ${SANDBOX_DESCRIPTION} `
    + `Output is cut to the last 4000 characters. Commands are stopped after the timeout (default 30 seconds, at most ${MAX_TIMEOUT}).`,
  inputExamples: [
    { input: { command: 'ls -la' } },
    { input: { command: 'python3 scripts/stats.py data.csv', timeout: 60 } },
  ],
  inputSchema: zod.object({
    command: zod.string().describe('Bash command to run. Can be several lines'),
    timeout: zod.number().int().optional().describe(`Seconds before the command is stopped. Defaults to 30, at most ${MAX_TIMEOUT}`),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { command: string, timeout?: number }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', exit_code?: number, stdout?: string, stderr?: string, truncated?: boolean, message: string }> => {
    // only offered to attached servers, but checked here too, so a made-up tool call can't get around it
    if (!isAttached(context.server_id)) return { result: 'failure', message: DETACHED_MESSAGE };

    try {
      const { exit_code, stdout, stderr, timed_out, truncated } = await sandboxExec(input.command, { timeout: input.timeout });
      return {
        result: exit_code === 0 ? 'success' : 'failure',
        exit_code,
        stdout,
        stderr,
        truncated,
        message: timed_out ? 'The command was stopped for taking too long.' : `The command exited with code ${exit_code}.`,
      };
    } catch (error: any) {
      return { result: 'failure', message: `The workspace isn't available: ${error?.message ?? error}` };
    }
  },
});

// separate from run_command, since writing a file through a bash heredoc breaks on quotes and special characters
const writeFile = tool({
  description: `Write a file in your workspace, replacing it if it exists. Folders are created as needed. ${SANDBOX_DESCRIPTION}`,
  inputExamples: [
    { input: { path: 'NOTES.md', content: '# Notes\n- Working on: a dice roller in dice.py\n' } },
  ],
  inputSchema: zod.object({
    path: zod.string().describe('Path of the file, relative to /workspace'),
    content: zod.string().describe('Full content of the file'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { path: string, content: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    if (!isAttached(context.server_id)) return { result: 'failure', message: DETACHED_MESSAGE };

    try {
      // the path goes in as a variable and the content through stdin, so neither is ever parsed as bash
      const { exit_code, stderr } = await sandboxExec('mkdir -p -- "$(dirname -- "$FILE")" && cat > "$FILE"', { stdin: input.content, env: { FILE: input.path }, timeout: 10 });
      return exit_code === 0
        ? { result: 'success', message: `Wrote ${input.content.length} characters to ${input.path}.` }
        : { result: 'failure', message: stderr || `Writing the file failed with code ${exit_code}.` };
    } catch (error: any) {
      return { result: 'failure', message: `The workspace isn't available: ${error?.message ?? error}` };
    }
  },
});

export default { reactToMessage, changeNickname, createReminder, editReminder, listReminders, viewReminder, removeReminder, createMemory, listMemories, viewMemory, editMemory, removeMemory, fetchURL, captionImage: captionImageTool, xSearch, counter, heartbeat, fetchChannel, searchChannel, sendMessage, createThread, runCommand, writeFile };
