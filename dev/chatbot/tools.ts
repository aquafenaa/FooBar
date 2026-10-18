import { tool } from 'ai';
import { z as zod } from 'zod';
import cron from 'node-cron';
import { Snowflake } from 'discord.js';

import { discordClient } from '..';
import { addReminder, deleteCounter, deleteMemory, deleteReminder, getCounter, getCountersByServer, getReminder, getRemindersByServer, getServer, incrementCounter, insertCounter, setCounterValue, resolveChannelRef, resolveMessageRef, updateReminder, upsertMemory } from '../data';
import { MemoryTable, ReminderTable } from '../types/schema';
import { sendReminder } from '../utils';
import { MAIN_SOURCE, findMemory, getVisibleMemories } from './context';

// filled in by the bot for each reply, rather than by the model, so the model can't get it wrong (or reach another server's memories)
const replyContextSchema = zod.object({
  server_id: zod.string(),
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

export default { reactToMessage, createReminder, editReminder, listReminders, viewReminder, removeReminder, createMemory, listMemories, viewMemory, editMemory, removeMemory, fetchURL, xSearch, counter };
