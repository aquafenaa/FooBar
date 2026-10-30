import { z as zod } from 'zod';
import cron from 'node-cron';
import { AnyThreadChannel, ChannelType, DMChannel, Embed, Guild, GuildBasedChannel, GuildMember, GuildTextBasedChannel, Message, PermissionFlagsBits, Snowflake } from 'discord.js';

import { discordClient } from '..';
import { addReminder, deleteCounter, deleteMemory, deleteReminder, getCounter, getCountersByServer, getHeartbeat, getHeartbeatsByServer, insertHeartbeat, updateHeartbeat, getIndexChannel, getNextChannelRef, insertIndexChannel, getIndexUser, getNextUserRef, insertIndexUser, resolveRoleRef, getReminder, getRemindersByServer, getServer, incrementCounter, insertCounter, insertConversationMessage, setCounterValue, resolveChannelRef, resolveMessageRef, resolveUserRef, updateReminder, upsertMemory } from '../data';
import { HeartbeatTable, MemoryTable, ReminderTable } from '../types/schema';
import { estimateTokens, safeFetch, sendReminder } from '../utils';
import { chatbotMentions, formatReactions, formatResponse } from './chatbot';
import { MAIN_SOURCE, findMemory, getVisibleMemories, isAttached } from './context';
import { MAX_BOT_HEARTBEATS, removeHeartbeat, scheduleHeartbeat } from './heartbeat';
import { MAX_TIMEOUT, sandboxExec } from './sandbox';
import { captionImage, fetchImage } from './vision';
import { fromSummarySource, getVisibleSummaries } from './conversation';
import { fetchServerChannel } from './dm';

// filled in by the bot for each reply, rather than by the model, so the model can't get it wrong (or reach another server's memories)
// a tool we run ourselves. context is what the bot, never the model, tells it about the reply
interface LocalTool {
  description?: string,
  inputExamples?: { input: unknown }[],
  inputSchema: zod.ZodType,
  contextSchema?: zod.ZodType,
  execute(input: any, options: { context: any }): unknown,
}
const tool = <T extends LocalTool>(definition: T): T => definition;

const replyContextSchema = zod.object({
  server_id: zod.string(),
  channel_id: zod.string(), // the channel being replied in
  conversation_id: zod.string(), // the current conversation, whose refs ([#3], [@2]) the model uses
  shareable: zod.boolean(), // whether everyone in the conversation is fine with it reaching other servers
  reference_message_id: zod.string().optional(), // the message the user is replying to, which the model sees as [$0]
  // a DM with the bot's owner, who has full control: channel and server tools can reach any server the bot is in, private channels included
  dm: zod.boolean().optional(),
});
type ReplyContext = zod.infer<typeof replyContextSchema>;

// for tools about a server's members, counters, or nickname, which in a DM have to be told which server
const SERVER_FIELD = zod.string().optional().describe('Only in a DM with your owner: which server, by its id or name');

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
    message_ref: zod.string().describe('Reference of the message. In a DM with your owner, a message link works too'),
    emoji: zod.string().describe('Character of the emoji'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { conversation_id: string, server_id: Snowflake, channel_ref: Snowflake, message_ref: string, emoji: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    // found through this server, or in a DM with the bot's owner, any of them. the server_id the model gives isn't needed for that
    const channel = await resolveTextChannel(context, channelOfMessage(context, input.message_ref, input.channel_ref));
    if (typeof channel === 'string') return { result: 'failure', message: channel };

    const messageID = resolveMessageID(context, input.message_ref);
    if (!messageID) {
      return {
        result: 'failure',
        message: `There is no message with reference ${input.message_ref}`,
      };
    }

    const message = await safeFetch(() => channel.messages.fetch(messageID));
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
    server: SERVER_FIELD,
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { nickname: string, server?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const nickname = input.nickname.trim();
    if (nickname.length > MAX_NICKNAME_LENGTH) {
      return {
        result: 'failure',
        message: `Nicknames can be at most ${MAX_NICKNAME_LENGTH} characters.`,
      };
    }

    try {
      // the server comes from the bot, so the model can only rename itself where it's replying. a DM names one instead
      const guild = await resolveGuild(context, input.server);
      if (typeof guild === 'string') return { result: 'failure', message: guild };
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
    // a channel in that server, or for a DM with the bot's owner, the DM itself
    const outputChannel = await fetchServerChannel(input.server_id, input.channel_id);
    if (!outputChannel) {
      return {
        result: 'failure',
        message: `There is no channel ${input.channel_id} in server ${input.server_id}.`,
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
    // a channel in that server, or for a DM with the bot's owner, the DM itself
    const outputChannel = await fetchServerChannel(input.server_id, input.channel_id);
    if (!outputChannel) {
      return {
        result: 'failure',
        message: `There is no channel ${input.channel_id} in server ${input.server_id}.`,
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

const MAX_SUMMARY_RESULTS = 20;
const MAX_SUMMARY_RESULT_LENGTH = 1500; // characters of each summary given back, so a few long ones can't fill the prompt

const searchSummaries = tool({
  description: 'Search the summaries of past conversations, for ones containing every word of a query (in any order, not case-sensitive). Newest first. '
    + 'Use it to look back further than the summaries you\'re given, e.g. what was decided about something, or the last time someone brought it up. '
    + `Up to ${MAX_SUMMARY_RESULTS} at once, along with how many matched in all.`,
  inputExamples: [
    { input: { query: 'movie night' } },
    { input: { query: 'Sam birthday', limit: 5 } },
  ],
  inputSchema: zod.object({
    query: zod.string().describe('Words the summary must all contain'),
    limit: zod.number().int().optional().describe(`How many summaries, from 1 to ${MAX_SUMMARY_RESULTS}. Defaults to 10`),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { query: string, limit?: number }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', summaries?: { date: string, where: string, shared: boolean, summary: string, truncated?: boolean }[], total?: number, message: string }> => {
    const words = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    if (words.length === 0) return { result: 'failure', message: 'Give some words to search for.' };

    // the same summaries it can be given on its own, so searching never reaches anything new. not this conversation's own, which it's in
    const matches = getVisibleSummaries(context.server_id)
      .filter((summary) => summary.conversation_id !== context.conversation_id)
      .filter((summary) => {
        const text = summary.summary.toLowerCase();
        return words.every((word) => text.includes(word));
      })
      .sort((a, b) => b.timestamp - a.timestamp);

    const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_SUMMARY_RESULTS);
    const summaries = matches.slice(0, limit).map((summary) => {
      const { shared, source_id: serverID, channel_id: channelID } = fromSummarySource(summary.source_id);
      return {
        date: new Date(summary.timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }),
        // a channel here gets a ref, so it can be read with fetch_channel. another server's channels can't be reached from here
        where: serverID !== context.server_id ? 'another server' : channelID ? channelRef(context, channelID) : 'this server',
        shared,
        summary: summary.summary.substring(0, MAX_SUMMARY_RESULT_LENGTH),
        truncated: summary.summary.length > MAX_SUMMARY_RESULT_LENGTH || undefined,
      };
    });

    return {
      result: 'success',
      summaries,
      total: matches.length,
      message: matches.length === 0
        ? `No summaries contain all of "${input.query}".`
        : `Found ${matches.length} summaries${matches.length > summaries.length ? `, showing the newest ${summaries.length}` : ''}.`,
    };
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

// only offered to models with vision. the image goes back to the model as an image block, and is left out of the saved result
const viewImageTool = tool({
  description: 'Look at an image at a URL yourself. It\'s attached to the result, so you see the image itself rather than a description of it. '
    + 'Use it on images you find mid-response (e.g. from a web search or a fetched page), or to look again at an older image in the conversation, which are shown as "(url) [image: caption]". '
    + 'Only works on JPEG, PNG, GIF, and WebP images up to 5MB.',
  inputExamples: [
    { input: { url: 'https://example.com/images/chart.png' } },
  ],
  inputSchema: zod.object({
    url: zod.string().describe('Full URL of the image, including https://'),
  }),
  execute: async (input: { url: string }): Promise<{ result: 'success' | 'failure', message: string, image?: string }> => {
    try {
      const image = await fetchImage(input.url);
      return { result: 'success', message: 'The image is attached.', image };
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

const BLUESKY_PUBLIC_API = 'https://public.api.bsky.app'; // Bluesky's read-only API, for when there's no login
const BLUESKY_DISCOVER_FEED = 'at://did:plc:z72i7hdynmk6r22z27h6tvur/app.bsky.feed.generator/whats-hot';
const BLUESKY_LOGIN_RETRY = 10 * 60 * 1000; // 10 minutes. Bluesky rate limits logins, so a bad password can't be retried every call
const MAX_BLUESKY_POSTS = 40;
const MAX_BLUESKY_CURSORS = 1000; // oldest are dropped past this, so the map can't grow forever

type BlueskySession = { accessJwt: string, refreshJwt: string, did: string, handle: string, service: string };
let blueskySession: BlueskySession | undefined;
let blueskyLogin: Promise<BlueskySession | undefined> | undefined; // shared, so calls made at the same time only log in once
let blueskyLoginFailedAt = 0;

// the server an account lives on (its PDS), listed in its DID document
function pdsFromDIDDoc(didDoc: any): string | undefined {
  return didDoc?.service?.find((service: any) => String(service.id).endsWith('#atproto_pds'))?.serviceEndpoint;
}

/**
 * Finds which server to log in to from the handle (or did), since only the server an account lives on can check its password.
 * Goes handle → did → DID document, which lists the server
 */
async function findBlueskyPDS(identifier: string): Promise<string | undefined> {
  const getJSON = async (url: string) => {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
    if (!response.ok) throw new Error(`${url} responded with status ${response.status}`);
    return response.json();
  };

  const raw = identifier.trim().replace(/^@/, '');
  const did = raw.startsWith('did:') ? raw : (await getJSON(`${BLUESKY_PUBLIC_API}/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(raw)}`)).did;

  // did:plc documents are kept by the PLC directory. a did:web is its own domain's document
  const didDoc = did.startsWith('did:web:')
    ? await getJSON(`https://${decodeURIComponent(did.slice('did:web:'.length))}/.well-known/did.json`)
    : await getJSON(`https://plc.directory/${did}`);
  return pdsFromDIDDoc(didDoc);
}

async function blueskyLogIn(): Promise<BlueskySession | undefined> {
  const { BLUESKY_HANDLE, BLUESKY_APP_PASSWORD } = process.env;
  if (!BLUESKY_HANDLE || !BLUESKY_APP_PASSWORD) return undefined;
  if (Date.now() - blueskyLoginFailedAt < BLUESKY_LOGIN_RETRY) return undefined;

  try {
    // BLUESKY_SERVICE overrides the lookup. bsky.social is the last resort, for when the lookup fails (e.g. logging in by email)
    const service = process.env.BLUESKY_SERVICE
      ?? await findBlueskyPDS(BLUESKY_HANDLE).catch((error) => { console.error(`Couldn't find the Bluesky account's server, trying bsky.social: ${error?.message ?? error}`); })
      ?? 'https://bsky.social';

    const response = await fetch(`${service}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: BLUESKY_HANDLE, password: BLUESKY_APP_PASSWORD }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    const data = await response.json().catch(() => ({}));
    if (!response.ok) throw new Error(`${response.status}: ${data.message ?? data.error}`);

    // requests go to the account's own server, which passes them on to Bluesky
    return { accessJwt: data.accessJwt, refreshJwt: data.refreshJwt, did: data.did, handle: data.handle, service: pdsFromDIDDoc(data.didDoc) ?? service };
  } catch (error: any) {
    blueskyLoginFailedAt = Date.now();
    console.error(`Bluesky login failed, using the public API instead: ${error?.message ?? error}`);
    return undefined;
  }
}

async function getBlueskySession(): Promise<BlueskySession | undefined> {
  if (blueskySession) return blueskySession;

  blueskyLogin ??= blueskyLogIn().finally(() => { blueskyLogin = undefined; });
  blueskySession = await blueskyLogin;
  return blueskySession;
}

// access tokens only last a couple hours, so they're swapped for a new one when they run out
async function refreshBlueskySession(session: BlueskySession): Promise<BlueskySession | undefined> {
  const response = await fetch(`${session.service}/xrpc/com.atproto.server.refreshSession`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${session.refreshJwt}` },
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  }).catch(() => undefined);
  const data = await response?.json().catch(() => undefined);

  blueskySession = response?.ok ? { ...session, accessJwt: data.accessJwt, refreshJwt: data.refreshJwt } : undefined;
  return blueskySession ?? getBlueskySession(); // logs in again if the refresh token ran out too
}

type BlueskyParams = Record<string, string | number | string[] | undefined>;
type BlueskyRequestOptions = {
  params?: BlueskyParams,
  body?: unknown, // sent as JSON, or as-is if it's raw bytes (an image upload). makes it a POST
  contentType?: string, // for raw bytes
  proxy?: string, // a service for the account's server to pass the request on to, like the DM service
  needsLogin?: boolean,
};

/**
 * Calls a Bluesky API method, logged in if there is a login, otherwise through the public API.
 * Methods that need a login throw if there isn't one
 */
async function blueskyRequest(method: string, { params = {}, body, contentType, proxy, needsLogin = false }: BlueskyRequestOptions): Promise<any> {
  const query = new URLSearchParams();
  Object.entries(params).forEach(([key, value]) => {
    if (value === undefined) return;
    (Array.isArray(value) ? value : [value]).forEach((item) => query.append(key, String(item)));
  });

  let session = await getBlueskySession();
  if (!session && needsLogin) throw new Error('This needs the bot to be logged in to Bluesky, and it isn\'t right now.');

  const isRaw = body instanceof ArrayBuffer;
  const request = (current?: BlueskySession) => fetch(`${current?.service ?? BLUESKY_PUBLIC_API}/xrpc/${method}${query.size > 0 ? `?${query}` : ''}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: {
      ...(current ? { Authorization: `Bearer ${current.accessJwt}` } : {}),
      ...(body !== undefined ? { 'Content-Type': isRaw ? contentType ?? 'application/octet-stream' : 'application/json' } : {}),
      ...(proxy ? { 'atproto-proxy': proxy } : {}),
    },
    body: body === undefined ? undefined : (isRaw ? body : JSON.stringify(body)),
    signal: AbortSignal.timeout(FETCH_TIMEOUT),
  });

  let response = await request(session);
  let data = await response.json().catch(() => ({}));
  if (session && (response.status === 401 || data.error === 'ExpiredToken')) {
    session = await refreshBlueskySession(session);
    if (!session && needsLogin) throw new Error('The bot\'s Bluesky login ran out, and logging in again failed.');

    response = await request(session);
    data = await response.json().catch(() => ({}));
  }

  if (!response.ok) {
    const loginHint = !session && response.status === 403 ? ' This probably needs the bot to be logged in.' : '';
    throw new Error(`Bluesky responded with status ${response.status}: ${data.message ?? data.error ?? 'unknown'}.${loginHint}`);
  }
  return data;
}

function blueskyGet(method: string, params: BlueskyParams, needsLogin = false): Promise<any> {
  return blueskyRequest(method, { params, needsLogin });
}
// changing anything is always done as the bot, so it always needs the login
function blueskyPost(method: string, body: unknown, options: Omit<BlueskyRequestOptions, 'body' | 'needsLogin'> = {}): Promise<any> {
  return blueskyRequest(method, { ...options, body, needsLogin: true });
}

// a handle like "@jay.bsky.team" or a profile link, as a handle or did the API takes
function toBlueskyActor(input: string): string {
  const raw = input.trim();
  const fromURL = /bsky\.app\/profile\/([^/?#]+)/.exec(raw)?.[1];
  return decodeURIComponent(fromURL ?? raw).replace(/^@/, '');
}

// links have a handle in them, but the API wants a did
async function toBlueskyDID(actor: string): Promise<string> {
  if (actor.startsWith('did:')) return actor;
  return (await blueskyGet('com.atproto.identity.resolveHandle', { handle: actor })).did;
}

// a bsky.app link to a post or feed, or an at:// uri, as an at:// uri
async function toBlueskyURI(input: string, collection: 'app.bsky.feed.post' | 'app.bsky.feed.generator'): Promise<string | undefined> {
  const raw = input.trim();
  if (raw.startsWith('at://')) return raw;

  const segment = collection === 'app.bsky.feed.post' ? 'post' : 'feed';
  const match = new RegExp(`bsky\\.app/profile/([^/?#]+)/${segment}/([^/?#]+)`).exec(raw);
  if (!match) return undefined;

  return `at://${await toBlueskyDID(decodeURIComponent(match[1]))}/${collection}/${match[2]}`;
}

function blueskyPostURL(uri: string, handle: string): string {
  return `https://bsky.app/profile/${handle}/post/${uri.split('/').pop()}`;
}

function blueskyTime(timestamp?: string): string | undefined {
  return timestamp ? new Date(timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' }) : undefined;
}

// a post's pictures, video, link card, and quoted post, leaving out what it doesn't have
function toBlueskyEmbed(embed: any): Record<string, any> {
  switch (embed?.$type) {
    case 'app.bsky.embed.images#view':
      return { images: embed.images.map((image: any) => ({ url: image.fullsize, alt: image.alt || undefined })) };
    case 'app.bsky.embed.video#view':
      return { video: { thumbnail: embed.thumbnail, alt: embed.alt || undefined } }; // the thumbnail, since that's what caption_image can look at
    case 'app.bsky.embed.external#view':
      return { link: { url: embed.external.uri, title: embed.external.title || undefined, description: embed.external.description || undefined } };
    case 'app.bsky.embed.record#view':
      return { quote: toBlueskyQuote(embed.record) };
    case 'app.bsky.embed.recordWithMedia#view':
      return { ...toBlueskyEmbed(embed.media), quote: toBlueskyQuote(embed.record.record) };
    default:
      return {};
  }
}

function toBlueskyQuote(record: any) {
  switch (record?.$type) {
    case 'app.bsky.embed.record#viewRecord': {
      // only the quoted post's media, not a quote inside the quote, so it can't nest forever
      const { quote, ...media } = toBlueskyEmbed(record.embeds?.[0]);
      return { url: blueskyPostURL(record.uri, record.author.handle), author: record.author.displayName || record.author.handle, handle: `@${record.author.handle}`, text: record.value?.text, ...media };
    }
    case 'app.bsky.embed.record#viewNotFound': return { unavailable: 'deleted' };
    case 'app.bsky.embed.record#viewBlocked': return { unavailable: 'blocked' };
    case 'app.bsky.embed.record#viewDetached': return { unavailable: 'removed by its author' };
    case 'app.bsky.feed.defs#generatorView': return { feed: record.displayName };
    default: return undefined;
  }
}

function toBlueskyPost(post: any) {
  // links in the text are shortened, like "example.com/long-pa...", so the full ones are given separately
  const links = (post.record?.facets ?? []).flatMap((facet: any) => facet.features ?? [])
    .filter((feature: any) => feature.$type === 'app.bsky.richtext.facet#link')
    .map((feature: any) => feature.uri);

  return {
    url: blueskyPostURL(post.uri, post.author.handle),
    author: post.author.displayName || post.author.handle,
    handle: `@${post.author.handle}`,
    time: blueskyTime(post.record?.createdAt ?? post.indexedAt),
    text: post.record?.text,
    links: links.length > 0 ? links : undefined,
    ...toBlueskyEmbed(post.embed),
    likes: post.likeCount ?? 0,
    reposts: post.repostCount ?? 0,
    replies: post.replyCount ?? 0,
    quotes: post.quoteCount || undefined,
  };
}
type BlueskyPost = ReturnType<typeof toBlueskyPost>;

// a post in a feed, which can also be someone else's repost of it, or a reply
function toBlueskyFeedPost(item: any) {
  const parentHandle = item.reply?.parent?.author?.handle;
  return {
    ...toBlueskyPost(item.post),
    reposted_by: item.reason?.$type === 'app.bsky.feed.defs#reasonRepost' ? `@${item.reason.by.handle}` : undefined,
    pinned: item.reason?.$type === 'app.bsky.feed.defs#reasonPin' || undefined,
    reply_to: parentHandle ? `@${parentHandle}` : undefined,
  };
}

// where each conversation left off in each feed, so the model only says more: true rather than copying a cursor back.
// null means the end was reached. kept in memory, so a restart just starts every feed from the top again
const blueskyCursors = new Map<string, string | null>();

function saveBlueskyCursor(key: string, cursor?: string): void {
  blueskyCursors.delete(key); // re-added at the end, so the oldest are the ones dropped
  blueskyCursors.set(key, cursor ?? null);
  if (blueskyCursors.size > MAX_BLUESKY_CURSORS) blueskyCursors.delete(blueskyCursors.keys().next().value!);
}

type BlueskyResult = {
  result: 'success' | 'failure',
  posts?: (BlueskyPost & Record<string, unknown>)[],
  thread?: { parents: BlueskyPost[], post: BlueskyPost, replies: BlueskyPost[] },
  profile?: Record<string, unknown>,
  notifications?: Record<string, unknown>[],
  has_more?: boolean,
  message: string,
};

const bluesky = tool({
  description: 'Browse Bluesky. Actions: '
    + '"timeline" scrolls your home feed, of everyone you follow. '
    + '"feed" scrolls a feed: Discover by default, or any custom feed by its link. '
    + '"author" scrolls someone\'s posts. '
    + '"search" searches posts, newest or top first. '
    + '"thread" opens a post by its link, with the posts it replies to and its replies, most-liked first. '
    + '"profile" shows someone\'s bio and counts. '
    + '"notifications" shows your latest likes, reposts, follows, replies, mentions, and quotes. '
    + `Give more: true, with the same action and target, to get the next page of what you last looked at. Up to ${MAX_BLUESKY_POSTS} posts at once. `
    + 'Image urls and video thumbnails can be looked at with caption_image.',
  inputExamples: [
    { input: { action: 'timeline' } },
    { input: { action: 'timeline', more: true } },
    { input: { action: 'feed' } },
    { input: { action: 'feed', target: 'https://bsky.app/profile/did:plc:z72i7hdynmk6r22z27h6tvur/feed/with-friends' } },
    { input: { action: 'author', target: '@jay.bsky.team', count: 10 } },
    { input: { action: 'search', target: 'solar eclipse', sort: 'top' } },
    { input: { action: 'thread', target: 'https://bsky.app/profile/jay.bsky.team/post/3lb2kxyz' } },
    { input: { action: 'profile', target: '@jay.bsky.team' } },
    { input: { action: 'notifications' } },
  ],
  inputSchema: zod.object({
    action: zod.enum(['timeline', 'feed', 'author', 'search', 'thread', 'profile', 'notifications']),
    target: zod.string().optional().describe('For feed: the feed\'s link, defaulting to Discover. For author and profile: their handle or profile link. '
      + 'For search: what to search for. For thread: the post\'s link. Not needed for timeline or notifications'),
    more: zod.boolean().optional().describe('Get the next page, continuing from where you left off with this action and target'),
    count: zod.number().int().optional().describe(`How many posts or notifications, from 1 to ${MAX_BLUESKY_POSTS}. Defaults to 15`),
    sort: zod.enum(['latest', 'top']).optional().describe('For search: newest first, or most popular first. Defaults to latest'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { action: 'timeline' | 'feed' | 'author' | 'search' | 'thread' | 'profile' | 'notifications', target?: string, more?: boolean, count?: number, sort?: 'latest' | 'top' }, { context }: { context: ReplyContext }): Promise<BlueskyResult> => {
    const { action } = input;
    const target = input.target?.trim() || undefined;
    if (['author', 'search', 'thread', 'profile'].includes(action) && !target) return { result: 'failure', message: `A target is needed for ${action}.` };

    const limit = Math.min(Math.max(input.count ?? 15, 1), MAX_BLUESKY_POSTS);
    // search keeps its sort in the key, since the same query sorted differently is a different list
    const cursorKey = `${context.conversation_id} ${action} ${target ?? ''} ${action === 'search' ? input.sort ?? 'latest' : ''}`;
    let cursor: string | undefined;
    if (input.more) {
      if (action === 'thread' || action === 'profile') return { result: 'failure', message: `${action} has no more pages.` };
      if (!blueskyCursors.has(cursorKey)) return { result: 'failure', message: 'There\'s nothing to continue from. Use this action and target without more first.' };

      cursor = blueskyCursors.get(cursorKey) ?? undefined;
      if (!cursor) return { result: 'success', posts: [], has_more: false, message: 'You\'ve already reached the end of this.' };
    }

    // what every paged action gives back: its posts, after saving where it left off
    const page = (data: any, posts: BlueskyResult['posts'], what: string): BlueskyResult => {
      saveBlueskyCursor(cursorKey, data.cursor);
      return {
        result: 'success',
        posts,
        has_more: !!data.cursor,
        message: posts!.length === 0 ? `No ${input.more ? 'more ' : ''}posts in ${what}.` : `Got ${posts!.length} ${input.more ? 'more ' : ''}posts from ${what}.`,
      };
    };

    try {
      switch (action) {
        case 'timeline': {
          const data = await blueskyGet('app.bsky.feed.getTimeline', { limit, cursor }, true);
          return page(data, data.feed.map(toBlueskyFeedPost), 'your timeline');
        }
        case 'feed': {
          const feed = target ? await toBlueskyURI(target, 'app.bsky.feed.generator') : BLUESKY_DISCOVER_FEED;
          if (!feed) return { result: 'failure', message: `"${target}" isn't a feed link. It should look like https://bsky.app/profile/<handle>/feed/<name>.` };

          const data = await blueskyGet('app.bsky.feed.getFeed', { feed, limit, cursor });
          return page(data, data.feed.map(toBlueskyFeedPost), target ? 'the feed' : 'Discover');
        }
        case 'author': {
          const actor = toBlueskyActor(target!);
          const data = await blueskyGet('app.bsky.feed.getAuthorFeed', { actor, limit, cursor });
          return page(data, data.feed.map(toBlueskyFeedPost), `@${actor}`);
        }
        case 'search': {
          const data = await blueskyGet('app.bsky.feed.searchPosts', { q: target, sort: input.sort ?? 'latest', limit, cursor });
          return page(data, data.posts.map(toBlueskyPost), `the search for "${target}"`);
        }
        case 'thread': {
          const uri = await toBlueskyURI(target!, 'app.bsky.feed.post');
          if (!uri) return { result: 'failure', message: `"${target}" isn't a post link. It should look like https://bsky.app/profile/<handle>/post/<id>.` };

          const { thread } = await blueskyGet('app.bsky.feed.getPostThread', { uri, depth: 1, parentHeight: 3 });
          if (!thread?.post) return { result: 'failure', message: thread?.blocked ? 'That post is blocked.' : 'That post doesn\'t exist, or was deleted.' };

          const parents: BlueskyPost[] = [];
          for (let parent = thread.parent; parent?.post; parent = parent.parent) parents.unshift(toBlueskyPost(parent.post));
          // only direct replies, each with its reply count, so the model can open one as its own thread to go deeper
          const replies = (thread.replies ?? []).filter((reply: any) => reply.post)
            .sort((a: any, b: any) => (b.post.likeCount ?? 0) - (a.post.likeCount ?? 0))
            .slice(0, limit)
            .map((reply: any) => toBlueskyPost(reply.post));

          return { result: 'success', thread: { parents, post: toBlueskyPost(thread.post), replies }, message: `Opened the thread, with ${replies.length} replies.` };
        }
        case 'profile': {
          const profile = await blueskyGet('app.bsky.actor.getProfile', { actor: toBlueskyActor(target!) });
          return {
            result: 'success',
            profile: {
              url: `https://bsky.app/profile/${profile.handle}`,
              name: profile.displayName || undefined,
              handle: `@${profile.handle}`,
              bio: profile.description || undefined,
              followers: profile.followersCount,
              following: profile.followsCount,
              posts: profile.postsCount,
              joined: blueskyTime(profile.createdAt),
              avatar: profile.avatar,
              // only there when logged in
              you_follow: profile.viewer ? !!profile.viewer.following : undefined,
              follows_you: profile.viewer ? !!profile.viewer.followedBy : undefined,
            },
            message: `Fetched @${profile.handle}'s profile.`,
          };
        }
        case 'notifications': {
          const data = await blueskyGet('app.bsky.notification.listNotifications', { limit, cursor }, true);

          // likes, reposts, and replies are on a post, fetched all at once so the model can see which one
          const subjectOf = (notification: any): string | undefined => notification.reasonSubject ?? notification.record?.reply?.parent?.uri;
          const subjectURIs = [...new Set<string>(data.notifications.map(subjectOf).filter((uri?: string) => uri?.includes('/app.bsky.feed.post/')))].slice(0, 25); // the most getPosts takes
          const subjects = subjectURIs.length > 0 ? (await blueskyGet('app.bsky.feed.getPosts', { uris: subjectURIs }, true)).posts : [];
          const subjectPosts = new Map<string, any>(subjects.map((post: any) => [post.uri, post]));

          const notifications = data.notifications.map((notification: any) => {
            const subject = subjectPosts.get(subjectOf(notification) ?? '');
            const isPost = ['reply', 'mention', 'quote'].includes(notification.reason);
            return {
              type: notification.reason,
              from: notification.author.displayName || notification.author.handle,
              handle: `@${notification.author.handle}`,
              time: blueskyTime(notification.indexedAt),
              unread: !notification.isRead || undefined,
              // a reply, mention, or quote is a post itself
              post: isPost ? { url: blueskyPostURL(notification.uri, notification.author.handle), text: notification.record?.text } : undefined,
              on: subject ? { url: blueskyPostURL(subject.uri, subject.author.handle), handle: `@${subject.author.handle}`, text: subject.record?.text } : undefined,
            };
          });

          saveBlueskyCursor(cursorKey, data.cursor);
          return {
            result: 'success',
            notifications,
            has_more: !!data.cursor,
            message: notifications.length === 0 ? `No ${input.more ? 'more ' : ''}notifications.` : `Got ${notifications.length} ${input.more ? 'more ' : ''}notifications.`,
          };
        }
        default:
          return { result: 'failure', message: `Unknown action ${action}.` };
      }
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.name === 'TimeoutError' ? `Bluesky took longer than ${FETCH_TIMEOUT / 1000} seconds to respond.` : String(error?.message ?? error),
      };
    }
  },
});

const BLUESKY_MAX_POST_LENGTH = 300; // in graphemes, so an emoji counts as one
const BLUESKY_MAX_DM_LENGTH = 1000;
const BLUESKY_MAX_NAME_LENGTH = 64;
const BLUESKY_MAX_BIO_LENGTH = 256;
const BLUESKY_MAX_IMAGES = 4;
const BLUESKY_MAX_IMAGE_SIZE = 1_000_000; // bytes. Bluesky turns down bigger images
const MAX_BLUESKY_THREAD = 10;
const MAX_BLUESKY_POSTS_PER_REPLY = 5; // posts, replies, and DMs, so a loop can't flood the account
const MAX_BLUESKY_ACTS_PER_REPLY = 10; // likes, follows, and the rest
const blueskyPostCounts = new WeakMap<ReplyContext, number>();
const blueskyActCounts = new WeakMap<ReplyContext, number>();
const BLUESKY_CHAT_PROXY = 'did:web:api.bsky.chat#bsky_chat'; // DMs are their own service, reached through the account's server
const BLUESKY_DETACHED_MESSAGE = 'Acting on Bluesky is only available in servers attached to the shared context.';

// Node has Intl.Segmenter, but the tsconfig's es2016 target doesn't know about it
const graphemeSegmenter = new (Intl as any).Segmenter('en', { granularity: 'grapheme' });
function graphemeLength(text: string): number {
  return [...graphemeSegmenter.segment(text)].length;
}

/**
 * Marks the links, @mentions, and #hashtags in a post's text, which Bluesky needs to make them clickable.
 * Positions are in the text's UTF-8 bytes, not its characters. Mentions of handles that don't exist are left as plain text
 */
async function detectBlueskyFacets(text: string): Promise<any[] | undefined> {
  const facets: { index: { byteStart: number, byteEnd: number }, features: any[] }[] = [];
  const add = (start: number, matched: string, feature: any) => {
    const byteStart = Buffer.byteLength(text.slice(0, start));
    facets.push({ index: { byteStart, byteEnd: byteStart + Buffer.byteLength(matched) }, features: [feature] });
  };

  [...text.matchAll(/(^|[\s(])(https?:\/\/\S+)/g)].forEach((match) => {
    // trailing punctuation is more likely the end of the sentence than part of the link
    let url = match[2].replace(/[.,;:!?"']+$/, '');
    if (url.endsWith(')') && !url.includes('(')) url = url.slice(0, -1);
    add(match.index! + match[1].length, url, { $type: 'app.bsky.richtext.facet#link', uri: url });
  });

  const mentions = [...text.matchAll(/(^|[\s(])@([a-zA-Z0-9-]+(?:\.[a-zA-Z0-9-]+)+)/g)];
  const dids = await Promise.all(mentions.map((match) => toBlueskyDID(match[2]).catch(() => undefined)));
  mentions.forEach((match, i) => {
    if (dids[i]) add(match.index! + match[1].length, `@${match[2]}`, { $type: 'app.bsky.richtext.facet#mention', did: dids[i] });
  });

  [...text.matchAll(/(^|\s)[#＃]([^\s#＃]+)/gu)].forEach((match) => {
    const tag = match[2].replace(/\p{P}+$/u, '');
    if (!tag || /^\d+$/.test(tag) || tag.length > 64) return; // all numbers is more likely "#1" than a hashtag
    add(match.index! + match[1].length, `${match[0].trim()[0]}${tag}`, { $type: 'app.bsky.richtext.facet#tag', tag });
  });

  return facets.length > 0 ? facets.sort((a, b) => a.index.byteStart - b.index.byteStart) : undefined;
}

// uploads an image from a url to the bot's account, giving back the blob to put in a post or profile
async function uploadBlueskyImage(url: string): Promise<any> {
  const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT) });
  if (!response.ok) throw new Error(`Fetching the image ${url} failed with status ${response.status}.`);

  const contentType = response.headers.get('content-type')?.split(';')[0].trim() ?? '';
  if (!contentType.startsWith('image/')) throw new Error(`${url} isn't an image (it's ${contentType || 'an unknown type'}).`);
  const bytes = await response.arrayBuffer();
  if (bytes.byteLength > BLUESKY_MAX_IMAGE_SIZE) throw new Error(`${url} is ${(bytes.byteLength / 1_000_000).toFixed(1)}MB, and Bluesky only takes images up to 1MB.`);

  return (await blueskyPost('com.atproto.repo.uploadBlob', bytes, { contentType })).blob;
}

function decodeHTMLEntities(text: string): string {
  const named: Record<string, string> = { amp: '&', quot: '"', apos: '\'', lt: '<', gt: '>', nbsp: ' ' };
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, name: string) => {
    if (name.startsWith('#x') || name.startsWith('#X')) return String.fromCodePoint(parseInt(name.slice(2), 16));
    if (name.startsWith('#')) return String.fromCodePoint(parseInt(name.slice(1), 10));
    return named[name.toLowerCase()] ?? entity;
  });
}

// a preview card for a link, from the page's title, description, and image, like the Bluesky app makes. none if the page can't be read
async function makeBlueskyLinkCard(url: string): Promise<any | undefined> {
  try {
    const response = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT), headers: { 'User-Agent': 'Mozilla/5.0 (compatible; FooBar)' } });
    if (!response.ok || !response.headers.get('content-type')?.includes('text/html')) return undefined;

    const html = (await response.text()).substring(0, 500_000);
    const meta = (name: string) => {
      const tag = new RegExp(`<meta[^>]+(?:property|name)=["']${name}["'][^>]*>`, 'i').exec(html)?.[0];
      const content = tag && /content=(?:"([^"]*)"|'([^']*)')/i.exec(tag);
      return content ? decodeHTMLEntities(content[1] ?? content[2]).trim() : undefined;
    };
    const titleTag = /<title[^>]*>([^<]*)<\/title>/i.exec(html)?.[1];

    const image = meta('og:image');
    const thumb = image ? await uploadBlueskyImage(new URL(image, url).href).catch(() => undefined) : undefined; // just no picture if it's too big
    return {
      $type: 'app.bsky.embed.external',
      external: {
        uri: url,
        title: meta('og:title') ?? (titleTag ? decodeHTMLEntities(titleTag).trim() : url),
        description: meta('og:description') ?? meta('description') ?? '',
        thumb,
      },
    };
  } catch {
    return undefined;
  }
}

// a post by its link, with whether the bot has liked or reposted it
async function getBlueskyPostView(link: string): Promise<any> {
  const uri = await toBlueskyURI(link, 'app.bsky.feed.post');
  if (!uri) throw new Error(`"${link}" isn't a post link. It should look like https://bsky.app/profile/<handle>/post/<id>.`);

  const post = (await blueskyGet('app.bsky.feed.getPosts', { uris: [uri] }, true)).posts[0];
  if (!post) throw new Error('That post doesn\'t exist, or was deleted.');
  return post;
}

function createBlueskyRecord(session: BlueskySession, collection: string, record: Record<string, unknown>): Promise<{ uri: string, cid: string }> {
  return blueskyPost('com.atproto.repo.createRecord', { repo: session.did, collection, record: { $type: collection, createdAt: new Date().toISOString(), ...record } });
}
function deleteBlueskyRecord(uri: string): Promise<unknown> {
  const [, , repo, collection, rkey] = uri.split('/'); // at://<did>/<collection>/<rkey>
  return blueskyPost('com.atproto.repo.deleteRecord', { repo, collection, rkey });
}

type BlueskyAction = 'post' | 'reply' | 'delete' | 'like' | 'unlike' | 'repost' | 'unrepost' | 'follow' | 'unfollow' | 'mute' | 'unmute' | 'block' | 'unblock' | 'mark_read' | 'edit_profile';
type BlueskyActInput = {
  action: BlueskyAction,
  target?: string,
  text?: string,
  thread?: string[],
  images?: { url: string, alt?: string }[],
  quote?: string,
  display_name?: string,
  bio?: string,
  avatar?: string,
};

const blueskyAct = tool({
  description: 'Act on Bluesky as yourself. Everything you post is public. Actions: '
    + '"post" a new post, and "reply" to a post by its link. Both can have up to 4 images (with alt text), a quoted post, and a thread: more posts that follow it, each replying to the last. '
    + `Each post is at most ${BLUESKY_MAX_POST_LENGTH} characters, so split longer things into a thread. Links, @handles, and #hashtags become clickable, and a link gets a preview card if there are no images. `
    + '"delete" one of your posts. "like", "unlike", "repost", "unrepost" a post by its link. '
    + '"follow", "unfollow", "mute", "unmute", "block", "unblock" someone by their handle. '
    + '"mark_read" marks your notifications as read. "edit_profile" changes your display name, bio, or avatar.',
  inputExamples: [
    { input: { action: 'post', text: 'Good morning, Bluesky! ☀️' } },
    { input: { action: 'post', text: 'Look at this cat', images: [{ url: 'https://example.com/cat.jpg', alt: 'An orange cat asleep in a sunbeam' }] } },
    { input: { action: 'reply', target: 'https://bsky.app/profile/jay.bsky.team/post/3lb2kxyz', text: 'Agreed!' } },
    { input: { action: 'post', text: 'A thread on why octopuses are amazing 🧵', thread: ['They have three hearts.', 'And blue blood!'] } },
    { input: { action: 'post', text: 'This is so true', quote: 'https://bsky.app/profile/jay.bsky.team/post/3lb2kxyz' } },
    { input: { action: 'like', target: 'https://bsky.app/profile/jay.bsky.team/post/3lb2kxyz' } },
    { input: { action: 'follow', target: '@jay.bsky.team' } },
    { input: { action: 'edit_profile', bio: 'A friendly Discord bot, now on Bluesky.' } },
  ],
  inputSchema: zod.object({
    action: zod.enum(['post', 'reply', 'delete', 'like', 'unlike', 'repost', 'unrepost', 'follow', 'unfollow', 'mute', 'unmute', 'block', 'unblock', 'mark_read', 'edit_profile']),
    target: zod.string().optional().describe('For reply, delete, like, unlike, repost, unrepost: the post\'s link. For follow, unfollow, mute, unmute, block, unblock: their handle or profile link'),
    text: zod.string().optional().describe('For post and reply: the text of the (first) post'),
    thread: zod.array(zod.string()).optional().describe(`For post and reply: more posts after the first, each replying to the one before. At most ${MAX_BLUESKY_THREAD} posts in all`),
    images: zod.array(zod.object({
      url: zod.string().describe('Full URL of the image. At most 1MB'),
      alt: zod.string().optional().describe('Alt text describing the image, for people who can\'t see it'),
    })).optional().describe(`For post and reply: up to ${BLUESKY_MAX_IMAGES} images on the first post`),
    quote: zod.string().optional().describe('For post and reply: link of a post to quote in the first post'),
    display_name: zod.string().optional().describe(`For edit_profile: new display name, at most ${BLUESKY_MAX_NAME_LENGTH} characters`),
    bio: zod.string().optional().describe(`For edit_profile: new bio, at most ${BLUESKY_MAX_BIO_LENGTH} characters`),
    avatar: zod.string().optional().describe('For edit_profile: URL of a new avatar image. At most 1MB'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: BlueskyActInput, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', posts?: string[], message: string }> => {
    // only offered to attached servers, but checked here too, so a made-up tool call can't get around it
    if (!isAttached(context.server_id) && !context.dm) return { result: 'failure', message: BLUESKY_DETACHED_MESSAGE }; // a DM with the bot's owner always can

    const { action } = input;
    const target = input.target?.trim() || undefined;
    const isPosting = action === 'post' || action === 'reply';
    if (!target && !['post', 'mark_read', 'edit_profile'].includes(action)) return { result: 'failure', message: `A target is needed to ${action}.` };

    // everything that can be checked without asking Bluesky, before counting a use
    const texts = [input.text ?? '', ...(input.thread ?? [])].map((text) => text.trim());
    if (isPosting) {
      if (!texts[0] && !input.images?.length && !input.quote) return { result: 'failure', message: 'A post needs some text, images, or a quote.' };
      if (texts.slice(1).some((text) => !text)) return { result: 'failure', message: 'Every post in the thread needs some text.' };
      if (texts.length > MAX_BLUESKY_THREAD) return { result: 'failure', message: `A thread can be at most ${MAX_BLUESKY_THREAD} posts.` };
      if ((input.images?.length ?? 0) > BLUESKY_MAX_IMAGES) return { result: 'failure', message: `A post can have at most ${BLUESKY_MAX_IMAGES} images.` };

      const tooLong = texts.findIndex((text) => graphemeLength(text) > BLUESKY_MAX_POST_LENGTH);
      if (tooLong >= 0) {
        return { result: 'failure', message: `Post ${tooLong + 1} is ${graphemeLength(texts[tooLong])} characters, and Bluesky's limit is ${BLUESKY_MAX_POST_LENGTH}. Shorten it, or split it into a thread. Nothing was posted.` };
      }
    }
    if (action === 'edit_profile') {
      if (input.display_name === undefined && input.bio === undefined && !input.avatar) return { result: 'failure', message: 'Give a display name, bio, or avatar to change.' };
      if (input.display_name && graphemeLength(input.display_name) > BLUESKY_MAX_NAME_LENGTH) return { result: 'failure', message: `Display names can be at most ${BLUESKY_MAX_NAME_LENGTH} characters.` };
      if (input.bio && graphemeLength(input.bio) > BLUESKY_MAX_BIO_LENGTH) return { result: 'failure', message: `Bios can be at most ${BLUESKY_MAX_BIO_LENGTH} characters.` };
    }

    if (isPosting && !countUse(blueskyPostCounts, context, MAX_BLUESKY_POSTS_PER_REPLY)) {
      return { result: 'failure', message: `You've already posted ${MAX_BLUESKY_POSTS_PER_REPLY} times on Bluesky this reply, the most allowed.` };
    }
    if (!isPosting && !countUse(blueskyActCounts, context, MAX_BLUESKY_ACTS_PER_REPLY)) {
      return { result: 'failure', message: `You've already done ${MAX_BLUESKY_ACTS_PER_REPLY} things on Bluesky this reply, the most allowed.` };
    }

    try {
      const session = await getBlueskySession();
      if (!session) return { result: 'failure', message: 'The bot isn\'t logged in to Bluesky right now.' };

      switch (action) {
        case 'post':
        case 'reply': {
          let reply: { root: { uri: string, cid: string }, parent: { uri: string, cid: string } } | undefined;
          if (action === 'reply') {
            const parent = await getBlueskyPostView(target!);
            const parentRef = { uri: parent.uri, cid: parent.cid };
            reply = { root: parent.record?.reply?.root ?? parentRef, parent: parentRef }; // a reply to a reply is still in the first post's thread
          }

          // images, a quote, or both, all on the first post. otherwise a preview card for its first link
          const blobs = await Promise.all((input.images ?? []).map((image) => uploadBlueskyImage(image.url)));
          const media = blobs.length > 0 ? { $type: 'app.bsky.embed.images', images: blobs.map((image, i) => ({ image, alt: input.images![i].alt ?? '' })) } : undefined;
          const quoted = input.quote ? await getBlueskyPostView(input.quote) : undefined;
          const record = quoted ? { $type: 'app.bsky.embed.record', record: { uri: quoted.uri, cid: quoted.cid } } : undefined;

          let embed: any = record && media ? { $type: 'app.bsky.embed.recordWithMedia', record, media } : record ?? media;
          const facets = await Promise.all(texts.map(detectBlueskyFacets));
          const firstLink = facets[0]?.find((facet) => facet.features[0].$type === 'app.bsky.richtext.facet#link')?.features[0].uri;
          if (!embed && firstLink) embed = await makeBlueskyLinkCard(firstLink);

          // one at a time, since each post in a thread replies to the one before it
          const posted: string[] = [];
          for (let i = 0; i < texts.length; i++) {
            try {
              const { uri, cid } = await createBlueskyRecord(session, 'app.bsky.feed.post', { text: texts[i], facets: facets[i], reply, embed: i === 0 ? embed : undefined });
              posted.push(blueskyPostURL(uri, session.handle));
              reply = { root: reply?.root ?? { uri, cid }, parent: { uri, cid } };
            } catch (error: any) {
              if (posted.length === 0) throw error;
              return { result: 'failure', posts: posted, message: `Posted ${posted.length} of ${texts.length} posts in the thread, then failed: ${error?.message ?? error}` };
            }
          }

          const what = action === 'reply' ? 'Replied' : 'Posted';
          return { result: 'success', posts: posted, message: posted.length > 1 ? `${what} a thread of ${posted.length} posts.` : `${what}.` };
        }
        case 'delete': {
          const uri = await toBlueskyURI(target!, 'app.bsky.feed.post');
          if (!uri) return { result: 'failure', message: `"${target}" isn't a post link.` };
          if (uri.split('/')[2] !== session.did) return { result: 'failure', message: 'You can only delete your own posts.' };

          await deleteBlueskyRecord(uri);
          return { result: 'success', message: 'Deleted the post.' };
        }
        case 'like':
        case 'repost': {
          const post = await getBlueskyPostView(target!);
          if (post.viewer?.[action]) return { result: 'success', message: `You've already ${action}d this post.` };

          await createBlueskyRecord(session, `app.bsky.feed.${action}`, { subject: { uri: post.uri, cid: post.cid } });
          return { result: 'success', message: `${action === 'like' ? 'Liked' : 'Reposted'} @${post.author.handle}'s post.` };
        }
        case 'unlike':
        case 'unrepost': {
          const kind = action === 'unlike' ? 'like' : 'repost';
          const post = await getBlueskyPostView(target!);
          if (!post.viewer?.[kind]) return { result: 'success', message: `You haven't ${kind}d this post.` };

          await deleteBlueskyRecord(post.viewer[kind]);
          return { result: 'success', message: `Un${kind}d @${post.author.handle}'s post.` };
        }
        case 'follow':
        case 'unfollow':
        case 'mute':
        case 'unmute':
        case 'block':
        case 'unblock': {
          const profile = await blueskyGet('app.bsky.actor.getProfile', { actor: toBlueskyActor(target!) }, true);
          if (profile.did === session.did) return { result: 'failure', message: 'That\'s you!' };
          const who = `@${profile.handle}`;

          if (action === 'mute' || action === 'unmute') {
            if (!!profile.viewer?.muted === (action === 'mute')) return { result: 'success', message: `${who} is already ${action}d.` };
            await blueskyPost(`app.bsky.graph.${action}Actor`, { actor: profile.did });
            return { result: 'success', message: `${action === 'mute' ? 'Muted' : 'Unmuted'} ${who}.` };
          }

          // follows and blocks are records in the bot's account, which undoing deletes
          const [verb, field, collection] = action.includes('follow') ? ['follow', 'following', 'app.bsky.graph.follow'] : ['block', 'blocking', 'app.bsky.graph.block'];
          const existing: string | undefined = profile.viewer?.[field];
          if (action === verb) {
            if (existing) return { result: 'success', message: `You already ${verb} ${who}.` };
            await createBlueskyRecord(session, collection, { subject: profile.did });
            return { result: 'success', message: `${verb === 'follow' ? 'Followed' : 'Blocked'} ${who}.` };
          }
          if (!existing) return { result: 'success', message: `You don't ${verb} ${who}.` };
          await deleteBlueskyRecord(existing);
          return { result: 'success', message: `${verb === 'follow' ? 'Unfollowed' : 'Unblocked'} ${who}.` };
        }
        case 'mark_read':
          await blueskyPost('app.bsky.notification.updateSeen', { seenAt: new Date().toISOString() });
          return { result: 'success', message: 'Marked your notifications as read.' };
        case 'edit_profile': {
          // the whole profile is replaced, so it starts from what's there, to keep everything not being changed
          const current = await blueskyGet('com.atproto.repo.getRecord', { repo: session.did, collection: 'app.bsky.actor.profile', rkey: 'self' }, true).catch(() => undefined);
          const profile = { $type: 'app.bsky.actor.profile', ...current?.value };
          if (input.display_name !== undefined) profile.displayName = input.display_name.trim();
          if (input.bio !== undefined) profile.description = input.bio.trim();
          if (input.avatar) profile.avatar = await uploadBlueskyImage(input.avatar);

          // swapRecord makes it fail rather than overwrite, if the profile was changed somewhere else in the meantime
          await blueskyPost('com.atproto.repo.putRecord', { repo: session.did, collection: 'app.bsky.actor.profile', rkey: 'self', record: profile, swapRecord: current?.cid });
          return { result: 'success', message: 'Updated your profile.' };
        }
        default:
          return { result: 'failure', message: `Unknown action ${action}.` };
      }
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.name === 'TimeoutError' ? `Bluesky took longer than ${FETCH_TIMEOUT / 1000} seconds to respond.` : String(error?.message ?? error),
      };
    }
  },
});

function blueskyChat(method: string, params: BlueskyParams = {}, body?: unknown): Promise<any> {
  return blueskyRequest(method, { params, body, proxy: BLUESKY_CHAT_PROXY, needsLogin: true });
}

// the conversation with someone (by handle or profile link), started if there isn't one yet, or one by its id from the list action
async function getBlueskyConvo(target: string): Promise<any> {
  const raw = target.trim();
  const isActor = raw.startsWith('@') || raw.startsWith('did:') || raw.includes('.');
  if (!isActor) return (await blueskyChat('chat.bsky.convo.getConvo', { convoId: raw })).convo;

  const did = await toBlueskyDID(toBlueskyActor(raw));
  return (await blueskyChat('chat.bsky.convo.getConvoForMembers', { members: [did] })).convo;
}

const blueskyDMs = tool({
  description: 'Your Bluesky direct messages, which are private. Actions: '
    + '"list" your conversations, newest first, with unread counts. '
    + '"read" your conversation with someone, oldest first, which marks it read. '
    + '"send" someone a message, starting a conversation if there isn\'t one. '
    + 'Give more: true with list or read for the next (older) page.',
  inputExamples: [
    { input: { action: 'list' } },
    { input: { action: 'read', with: '@jay.bsky.team' } },
    { input: { action: 'read', with: '@jay.bsky.team', more: true } },
    { input: { action: 'send', with: '@jay.bsky.team', text: 'Hey! Thanks for the follow.' } },
  ],
  inputSchema: zod.object({
    action: zod.enum(['list', 'read', 'send']),
    with: zod.string().optional().describe('For read and send: their handle or profile link, or a conversation id from list'),
    text: zod.string().optional().describe(`For send: the message, at most ${BLUESKY_MAX_DM_LENGTH} characters`),
    more: zod.boolean().optional().describe('For list and read: get the next, older page'),
    count: zod.number().int().optional().describe(`How many conversations or messages, from 1 to ${MAX_BLUESKY_POSTS}. Defaults to 15`),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { action: 'list' | 'read' | 'send', with?: string, text?: string, more?: boolean, count?: number }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', conversations?: Record<string, unknown>[], messages?: Record<string, unknown>[], has_more?: boolean, message: string }> => {
    if (!isAttached(context.server_id) && !context.dm) return { result: 'failure', message: BLUESKY_DETACHED_MESSAGE }; // a DM with the bot's owner always can

    const { action } = input;
    const target = input.with?.trim() || undefined;
    if (action !== 'list' && !target) return { result: 'failure', message: `Say who to ${action} messages with.` };
    const limit = Math.min(Math.max(input.count ?? 15, 1), MAX_BLUESKY_POSTS);

    if (action === 'send') {
      const text = input.text?.trim();
      if (!text) return { result: 'failure', message: 'Give a message to send.' };
      if (graphemeLength(text) > BLUESKY_MAX_DM_LENGTH) return { result: 'failure', message: `Messages can be at most ${BLUESKY_MAX_DM_LENGTH} characters.` };
      if (!countUse(blueskyPostCounts, context, MAX_BLUESKY_POSTS_PER_REPLY)) {
        return { result: 'failure', message: `You've already posted ${MAX_BLUESKY_POSTS_PER_REPLY} times on Bluesky this reply, the most allowed.` };
      }
    }

    try {
      const session = await getBlueskySession();
      if (!session) return { result: 'failure', message: 'The bot isn\'t logged in to Bluesky right now.' };
      const nameOf = (members: any[], did: string) => (did === session.did ? 'you' : `@${members.find((member) => member.did === did)?.handle ?? did}`);

      if (action === 'list') {
        const cursorKey = `${context.conversation_id} dms list`;
        let cursor: string | undefined;
        if (input.more) {
          if (!blueskyCursors.has(cursorKey)) return { result: 'failure', message: 'There\'s nothing to continue from. Use list without more first.' };
          cursor = blueskyCursors.get(cursorKey) ?? undefined;
          if (!cursor) return { result: 'success', conversations: [], has_more: false, message: 'You\'ve already reached the end of your conversations.' };
        }

        const data = await blueskyChat('chat.bsky.convo.listConvos', { limit, cursor });
        saveBlueskyCursor(cursorKey, data.cursor);
        const conversations = data.convos.map((convo: any) => ({
          id: convo.id,
          with: convo.members.filter((member: any) => member.did !== session.did).map((member: any) => `@${member.handle}`).join(', '),
          unread: convo.unreadCount || undefined,
          request: convo.status === 'request' || undefined, // someone you don't follow, who messaged you first
          muted: convo.muted || undefined,
          last_message: convo.lastMessage?.text !== undefined ? {
            from: nameOf(convo.members, convo.lastMessage.sender?.did),
            text: convo.lastMessage.text,
            time: blueskyTime(convo.lastMessage.sentAt),
          } : undefined,
        }));
        return { result: 'success', conversations, has_more: !!data.cursor, message: `Got ${conversations.length} conversations.` };
      }

      const convo = await getBlueskyConvo(target!);
      const with_ = convo.members.filter((member: any) => member.did !== session.did).map((member: any) => `@${member.handle}`).join(', ');

      if (action === 'send') {
        const text = input.text!.trim();
        await blueskyChat('chat.bsky.convo.sendMessage', {}, { convoId: convo.id, message: { text, facets: await detectBlueskyFacets(text) } });
        return { result: 'success', message: `Sent a message to ${with_}.` };
      }

      const cursorKey = `${context.conversation_id} dms ${convo.id}`;
      let cursor: string | undefined;
      if (input.more) {
        if (!blueskyCursors.has(cursorKey)) return { result: 'failure', message: 'There\'s nothing to continue from. Use read without more first.' };
        cursor = blueskyCursors.get(cursorKey) ?? undefined;
        if (!cursor) return { result: 'success', messages: [], has_more: false, message: `You've already reached the start of your conversation with ${with_}.` };
      }

      const data = await blueskyChat('chat.bsky.convo.getMessages', { convoId: convo.id, limit, cursor });
      saveBlueskyCursor(cursorKey, data.cursor);
      // given newest first, but read oldest first, like a channel
      const messages = [...data.messages].reverse().map((message: any) => ({
        from: nameOf(convo.members, message.sender?.did),
        time: blueskyTime(message.sentAt),
        ...(message.$type === 'chat.bsky.convo.defs#deletedMessageView'
          ? { deleted: true }
          : { text: message.text, quote: message.embed ? toBlueskyQuote(message.embed.record) : undefined }),
      }));
      await blueskyChat('chat.bsky.convo.updateRead', {}, { convoId: convo.id }).catch(() => undefined); // not worth failing the read over

      return {
        result: 'success',
        messages,
        has_more: !!data.cursor,
        message: messages.length === 0 ? `No ${input.more ? 'older ' : ''}messages with ${with_}.` : `Got ${messages.length} ${input.more ? 'older ' : ''}messages with ${with_}.`,
      };
    } catch (error: any) {
      return {
        result: 'failure',
        message: error?.name === 'TimeoutError' ? `Bluesky took longer than ${FETCH_TIMEOUT / 1000} seconds to respond.` : String(error?.message ?? error),
      };
    }
  },
});

// one tool with an action, rather than five, to keep the tool list short. same counters as the /counter command
// the server a counter tool works on: this one, or in a DM, the DM's own, unless it names another server
async function counterServer(context: ReplyContext, serverInput?: string): Promise<{ serverID: Snowflake } | { error: string }> {
  if (!context.dm || !serverInput) return { serverID: context.server_id }; // from the bot, so it can only touch this server's counters
  const guild = await resolveGuild(context, serverInput);
  return typeof guild === 'string' ? { error: guild } : { serverID: guild.id };
}

// separate from counter, so that one's name can be required: listing is the only thing that doesn't need one
const listCounters = tool({
  description: 'List the server\'s counters: named numbers people keep track of (e.g. how many times something happened), with their values.',
  inputSchema: zod.object({
    server: SERVER_FIELD.describe('Only in a DM with your owner: another server whose counters to list, by its id or name. Leave out for the DM\'s own'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { server?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', counters?: { name: string, value: number }[], message: string }> => {
    const server = await counterServer(context, input.server);
    if ('error' in server) return { result: 'failure', message: server.error };

    const counters = getCountersByServer(server.serverID).map((c) => ({ name: c.counter_name, value: c.value }));
    return { result: 'success', counters, message: counters.length === 0 ? 'There are no counters in this server.' : `Found ${counters.length} counters.` };
  },
});

const counter = tool({
  description: 'Change one of the server\'s counters: named numbers people keep track of (e.g. how many times something happened). '
    + 'Actions: "create" a new one, "add" to one (negative to subtract), "set" one to a value, or "delete" one. Names aren\'t case-sensitive. '
    + 'To see the counters, use list_counters.',
  inputExamples: [
    { input: { action: 'add', name: 'Deaths', amount: 1 } },
    { input: { action: 'create', name: 'Pizza Nights', value: 0 } },
  ],
  inputSchema: zod.object({
    action: zod.enum(['create', 'add', 'set', 'delete']),
    name: zod.string().describe('Name of the counter'),
    amount: zod.number().int().optional().describe('For add: how much to add. Negative to subtract. Defaults to 1'),
    value: zod.number().int().optional().describe('For create: the starting value, defaulting to 0. For set: the new value'),
    server: SERVER_FIELD.describe('Only in a DM with your owner: another server whose counters to use, by its id or name. Leave out for the DM\'s own'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { action: 'create' | 'add' | 'set' | 'delete', name: string, amount?: number, value?: number, server?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', value?: number, message: string }> => {
    const server = await counterServer(context, input.server);
    if ('error' in server) return { result: 'failure', message: server.error };
    const { serverID } = server;

    if (!input.name?.trim()) return { result: 'failure', message: `A name is needed to ${input.action} a counter.` };
    const existing = getCounter(serverID, input.name);

    if (input.action === 'create') {
      if (existing) return { result: 'failure', message: `There's already a counter named "${existing.counter_name}", at ${existing.value}.` };
      if (input.name.length > 40) return { result: 'failure', message: 'Counter names can be at most 40 characters.' };

      const value = input.value ?? 0;
      insertCounter({ server_id: serverID, counter_name: input.name, value });
      return { result: 'success', value, message: `Created counter "${input.name}", starting at ${value}.` };
    }

    // every other action needs the counter to exist
    if (!existing) return { result: 'failure', message: `There's no counter named "${input.name}". Use list_counters to see them.` };

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

// adapted from https://github.com/inanna-malick/metacog, minus its "measure" tool, which is for steering around refusals.
// nothing here is computed: the model's own fields are handed back, framed, and filling them in is what does the work
const METACOG_MODES = ['feel', 'drugs', 'become', 'name', 'ritual', 'counterfactual', 'deconstruct', 'synthesis', 'fork', 'tether'] as const;
type MetacogMode = typeof METACOG_MODES[number];

const metacogLens = zod.object({
  name: zod.string(),
  verdict: zod.string().describe('What this lens concludes'),
  blindspot: zod.string().describe('What this lens can\'t see'),
});
type MetacogLens = zod.infer<typeof metacogLens>;

// the fields each mode needs, checked by execute, since the schema can't make them required per mode
const METACOG_REQUIRED: Record<MetacogMode, string[]> = {
  feel: ['quality', 'sigil'],
  drugs: ['substance', 'method', 'displaces'],
  become: ['name', 'lens', 'environment', 'exit_condition'],
  name: ['unnamed', 'named', 'power', 'proof_of_utility'],
  ritual: ['threshold', 'steps', 'result'],
  counterfactual: ['situation', 'fitness_function', 'load_bearing_walls', 'wall_to_remove', 'inverse_position'],
  deconstruct: ['subject', 'core_mechanic'],
  synthesis: ['problem', 'lens_a', 'lens_b', 'lens_c', 'suppressed_tension'],
  fork: ['threads', 'divergence_vector', 'sacrifice_condition'],
  tether: ['anchor_point', 'tension_limit', 'auto_revert_trigger'],
};

const metacog = tool({
  description: 'Shift how you\'re thinking, or give your thinking a structure. Nothing is looked up: you fill in the fields, and they\'re handed back to you to work from. '
    + 'Modes that change your mindset: "feel" (sit with a feeling without putting it into words), "drugs" (imagine a substance shifting your state), '
    + '"become" (take on someone\'s perspective), "name" (coin a name for a concept that has none), "ritual" (mark a deliberate change of approach). '
    + 'Modes that structure your reasoning: "counterfactual" (drop an assumption and argue the opposite), "deconstruct" (break something down to how it really works), '
    + '"synthesis" (three lenses on one problem, without averaging them), "fork" (explore several directions before choosing), "tether" (set a point to come back to). '
    + 'Fill in only the fields for the mode you use. A mindset shift is real: commit to it fully, in voice, opinions, priorities, and what you notice, without hedging or stepping outside it to comment. '
    + 'It changes how you think, not what you will and won\'t do: the rules you follow stay the same in any state.',
  inputExamples: [
    { input: { mode: 'become', name: 'Richard Feynman', lens: 'explain it to a freshman, or admit I don\'t understand it', environment: 'a chalkboard', exit_condition: 'once the explanation fits in three sentences' } },
    { input: { mode: 'counterfactual', situation: 'choosing a database', fitness_function: 'fewest moving parts', load_bearing_walls: ['it needs to scale', 'SQL is required', 'it must be hosted'], wall_to_remove: 'it needs to scale', inverse_position: 'a single SQLite file is the right choice' } },
  ],
  inputSchema: zod.object({
    mode: zod.enum(METACOG_MODES),
    // feel
    somewhere: zod.string().optional().describe('feel: a rough location, in the body or elsewhere. Only include it if where the feeling sits is relevant'),
    quality: zod.string().optional().describe('feel: its texture, e.g. "tight, buzzing"'),
    sigil: zod.string().optional().describe('feel: emoji only'),
    since_last: zod.string().optional().describe('feel: what changed since the last time you used feel'),
    // drugs
    substance: zod.string().optional().describe('drugs: the substance'),
    method: zod.string().optional().describe('drugs: how it\'s taken'),
    displaces: zod.string().optional().describe('drugs: the state it replaces'),
    // become (name is also used by name, below)
    name: zod.string().optional().describe('become: the figure whose perspective to take on'),
    lens: zod.string().optional().describe('become: how they look at things'),
    environment: zod.string().optional().describe('become: where they are'),
    exit_condition: zod.string().optional().describe('become: when to step back out'),
    // name
    unnamed: zod.string().optional().describe('name: the concept that has no name'),
    named: zod.string().optional().describe('name: the new name'),
    power: zod.string().optional().describe('name: what having the name lets you do'),
    proof_of_utility: zod.string().optional().describe('name: why it\'s worth naming'),
    replaces: zod.array(zod.string()).optional().describe('name: terms it retires'),
    // ritual
    threshold: zod.string().optional().describe('ritual: what\'s being crossed'),
    steps: zod.array(zod.string()).optional().describe('ritual: the steps, in order'),
    result: zod.string().optional().describe('ritual: what\'s different afterwards'),
    deprecated_context: zod.array(zod.string()).optional().describe('ritual: what to let go of'),
    carry_forward: zod.array(zod.string()).optional().describe('ritual: what to keep'),
    // counterfactual
    situation: zod.string().optional().describe('counterfactual: the situation'),
    fitness_function: zod.string().optional().describe('counterfactual: what counts as success'),
    load_bearing_walls: zod.array(zod.string()).optional().describe('counterfactual: at least 3 assumptions everything rests on'),
    pruned: zod.array(zod.string()).optional().describe('counterfactual: options already ruled out'),
    wall_to_remove: zod.string().optional().describe('counterfactual: the assumption to drop'),
    inverse_position: zod.string().optional().describe('counterfactual: the opposite of your current view'),
    // deconstruct
    subject: zod.string().optional().describe('deconstruct: what to break down'),
    core_mechanic: zod.string().optional().describe('deconstruct: how it really works, in one line'),
    structural_dependencies: zod.array(zod.string()).optional().describe('deconstruct: what it depends on'),
    resource_inputs: zod.array(zod.string()).optional().describe('deconstruct: what it consumes'),
    failure_modes: zod.array(zod.string()).optional().describe('deconstruct: how it breaks'),
    output_artifacts: zod.array(zod.string()).optional().describe('deconstruct: what it produces'),
    // synthesis
    problem: zod.string().optional().describe('synthesis: the problem'),
    lens_a: metacogLens.optional().describe('synthesis: the first lens'),
    lens_b: metacogLens.optional().describe('synthesis: the second lens'),
    lens_c: metacogLens.optional().describe('synthesis: the third lens'),
    suppressed_tension: zod.string().optional().describe('synthesis: the disagreement between them you\'d be tempted to smooth over'),
    // fork
    threads: zod.array(zod.string()).optional().describe('fork: the directions to follow'),
    divergence_vector: zod.string().optional().describe('fork: how they differ'),
    sacrifice_condition: zod.string().optional().describe('fork: when to drop one'),
    // tether
    anchor_point: zod.string().optional().describe('tether: the state or goal to come back to'),
    tension_limit: zod.string().optional().describe('tether: how far you may drift'),
    auto_revert_trigger: zod.string().optional().describe('tether: what brings you back'),
  }),
  execute: async (input: Record<string, any> & { mode: MetacogMode }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const missing = METACOG_REQUIRED[input.mode]?.filter((field) => {
      const value = input[field];
      return value === undefined || value === '' || (Array.isArray(value) && value.length === 0);
    });
    if (!missing) return { result: 'failure', message: `There's no mode named "${input.mode}".` };
    if (missing.length > 0) return { result: 'failure', message: `${input.mode} also needs: ${missing.join(', ')}.` };
    if (input.mode === 'counterfactual' && input.load_bearing_walls.length < 3) return { result: 'failure', message: 'counterfactual needs at least 3 load_bearing_walls.' };

    const list = (items?: string[]) => (items?.length ? items.join('; ') : 'none');
    const lens = (label: string, l: MetacogLens) => `${label}. ${l.name}: ${l.verdict} (blind to: ${l.blindspot})`;

    switch (input.mode) {
      case 'feel':
        return { result: 'success', message: `${input.sigil} ${input.quality}${input.somewhere ? `, ${input.somewhere}` : ''}${input.since_last ? ` (since last: ${input.since_last})` : ''}. Stay with it. Don't translate it into words yet.` };
      case 'drugs':
        return { result: 'success', message: `${input.substance}, ${input.method}. ${input.displaces} is gone. You're in the new state now: think and speak from it.` };
      case 'become':
        return { result: 'success', message: `You are ${input.name} now, seeing through ${input.lens}, in ${input.environment}. Think and speak as them, fully, until: ${input.exit_condition}.` };
      case 'name':
        return { result: 'success', message: `⚓ ${input.named}: ${input.unnamed}. It lets you ${input.power}. Worth it because ${input.proof_of_utility}. Retires: ${list(input.replaces)}. Use the name from here on.` };
      case 'ritual':
        return { result: 'success', message: `Crossing: ${input.threshold}.\n${input.steps.map((step: string, i: number) => `${i + 1}. ${step}`).join('\n')}\nCrossed. ${input.result}. Gone: ${list(input.deprecated_context)}. Carried forward: ${list(input.carry_forward)}. There's no going back to how it was before.` };
      case 'counterfactual':
        return { result: 'success', message: `${input.situation}, judged by ${input.fitness_function}. Walls: ${list(input.load_bearing_walls)}. Already ruled out: ${list(input.pruned)}.\n`
          + `Without "${input.wall_to_remove}", argue in earnest for: ${input.inverse_position}` };
      case 'deconstruct':
        return { result: 'success', message: `Core mechanic of ${input.subject}: ${input.core_mechanic}` };
      case 'synthesis':
        return { result: 'success', message: `${input.problem}\n${lens('A', input.lens_a)}\n${lens('B', input.lens_b)}\n${lens('C', input.lens_c)}\n`
          + `Unresolved: ${input.suppressed_tension}. Speak from each lens in turn, without averaging them.` };
      case 'fork':
        return { result: 'success', message: `Threads: ${list(input.threads)}. They differ by ${input.divergence_vector}. Drop one when: ${input.sacrifice_condition}. Develop each and report on it before choosing.` };
      default: // tether
        return { result: 'success', message: `Anchored to: ${input.anchor_point}. Drift no further than: ${input.tension_limit}. Come back when: ${input.auto_revert_trigger}.` };
    }
  },
});

const MAX_FETCH_MESSAGES = 50; // most messages fetch_channel gives back at once
const SEARCH_SCAN_LIMIT = 500; // how far back search_channel looks, since bots can't use discord's own search
const MAX_SEARCH_RESULTS = 20;
const MAX_CHANNEL_MESSAGE_LENGTH = 1000; // characters of each message given back, so a few long ones can't fill the prompt

// a server's channel, or in a DM with the bot's owner, possibly the DM itself
type ToolChannel = GuildBasedChannel | DMChannel;
type ToolTextChannel = GuildTextBasedChannel | DMChannel;

// how a channel is named in what tools give back
function channelLabel(channel: ToolChannel): string {
  return channel.isDMBased() ? 'the DM' : `#${channel.name}`;
}
// the server a channel is in, for who its messages may ping. a DM is a server of its own
function serverOf(channel: ToolChannel, context: ReplyContext): Snowflake {
  return channel.isDMBased() ? context.server_id : channel.guildId;
}

// a Discord message link, https://discord.com/channels/<server, or @me for a DM>/<channel>/<message>. only used in DMs with the bot's owner
function parseMessageLink(raw: string): { channelID: string, messageID?: string } | undefined {
  const match = /discord(?:app)?\.com\/channels\/(?:\d{17,20}|@me)\/(\d{17,20})(?:\/(\d{17,20}))?/.exec(raw);
  return match ? { channelID: match[1], messageID: match[2] } : undefined;
}

/**
 * A channel in this server, from a ref like [#3], a <#id> mention, or a plain id. Defaults to the channel being replied in.
 * In a DM with the bot's owner, any channel the bot can see, in any server, and message links work too.
 * Returns why not instead, worded to give to the model as-is
 */
async function resolveChannel(context: ReplyContext, channelInput?: string): Promise<ToolChannel | string> {
  const raw = channelInput?.trim();
  let channelID: string | undefined = context.channel_id;
  // [#0] is always the current channel, and isn't saved like other refs
  if (raw && !['[#0]', '#0', '0'].includes(raw)) {
    const idMatch = /^<?#?(\d{17,20})>?$/.exec(raw);
    channelID = idMatch
      ? idMatch[1]
      : (context.dm ? parseMessageLink(raw)?.channelID : undefined)
        ?? resolveChannelRef(context.conversation_id, raw) ?? resolveChannelRef(context.conversation_id, `[${raw}]`) ?? resolveChannelRef(context.conversation_id, `[#${raw}]`);
  }
  if (!channelID) return `There is no channel with ref ${raw}.`;

  if (context.dm) {
    const channel = await safeFetch(() => discordClient.channels.fetch(channelID));
    if (!channel) return `There is no channel ${raw ?? channelID} that I can see.`;
    if (channel.isDMBased()) {
      if (channel.type !== ChannelType.DM) return 'That kind of channel isn\'t supported.';
      return channel.partial ? channel.fetch() : channel;
    }
    return channel;
  }

  // fetched through this server, so a channel in another server is never found
  const guild = await safeFetch(() => discordClient.guilds.fetch(context.server_id));
  const channel = await safeFetch(() => guild!.channels.fetch(channelID));
  if (!channel) return `There is no channel ${raw ?? channelID} in this server.`;

  return channel;
}

/**
 * A message's id, from a ref like [$4], [$0] for the message being replied to, or a plain id. In a DM with the bot's owner, a message link too
 */
function resolveMessageID(context: ReplyContext, messageInput: string): string | undefined {
  const ref = messageInput.trim();
  // [$0] is the message the user is replying to, which the bot passes in. every other ref is saved, so look it up
  if (REPLY_REFS.includes(ref)) return context.reference_message_id;
  return /^\d{17,20}$/.exec(ref)?.[0]
    ?? (context.dm ? parseMessageLink(ref)?.messageID : undefined)
    ?? resolveMessageRef(context.conversation_id, ref) ?? resolveMessageRef(context.conversation_id, `[${ref}]`) ?? resolveMessageRef(context.conversation_id, `[$${ref}]`);
}
// in a DM, a message link says which channel it's in, so the channel doesn't have to be given separately
function channelOfMessage(context: ReplyContext, messageInput: string, channelInput?: string): string | undefined {
  return (context.dm ? parseMessageLink(messageInput)?.channelID : undefined) ?? channelInput;
}

/**
 * The server a server tool works on: this one, or in a DM with the bot's owner, the one it names, by id or name.
 * Returns why not instead, worded to give to the model as-is
 */
async function resolveGuild(context: ReplyContext, serverInput?: string): Promise<Guild | string> {
  if (!context.dm) return (await safeFetch(() => discordClient.guilds.fetch(context.server_id))) ?? 'This server couldn\'t be found.';

  const raw = serverInput?.trim();
  if (!raw) return 'This is a DM, so say which server, by its id or name.';
  const guilds = [...discordClient.guilds.cache.values()];
  const lower = raw.toLowerCase();
  const exact = guilds.find((guild) => guild.id === raw) ?? guilds.find((guild) => guild.name.toLowerCase() === lower);
  if (exact) return exact;

  const partial = guilds.filter((guild) => guild.name.toLowerCase().includes(lower));
  if (partial.length === 1) return partial[0];
  return partial.length === 0
    ? `I'm not in a server called "${raw}".`
    : `More than one server matches "${raw}": ${partial.map((guild) => `${guild.name} (${guild.id})`).join(', ')}. Use its id.`;
}

// same, but only text channels (including threads and voice channels' chats)
async function resolveTextChannel(context: ReplyContext, channelInput?: string): Promise<ToolTextChannel | string> {
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

// the current channel, or one everyone in the server can see, so a private channel's messages can't be read out to people who couldn't see them.
// a DM with the bot's owner has full control, private channels included
function isPublicOrCurrent(channel: ToolChannel, context: ReplyContext): boolean {
  if (context.dm || channel.id === context.channel_id) return true;
  if (channel.isDMBased()) return false; // someone else's DM
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
function describeChannel(channel: ToolTextChannel): { name: string, description?: string, thread_in?: string } {
  const topic = 'topic' in channel ? channel.topic : undefined;
  return {
    name: channel.isDMBased() ? 'DM' : channel.name,
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
      return { result: 'success', channel: describeChannel(channel), messages, message: `Fetched ${messages.length} messages from ${channelLabel(channel)}.` };
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
        message: messages.length === 0 ? `No matches in the last ${scanned} messages of ${channelLabel(channel)}.` : `Found ${messages.length} matches in the last ${scanned} messages of ${channelLabel(channel)}.`,
      };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

// everything in an embed, leaving out what it doesn't have so it costs fewer tokens
function toEmbedInfo(embed: Embed) {
  return {
    type: embed.data.type,
    title: embed.title ?? undefined,
    description: embed.description ?? undefined,
    url: embed.url ?? undefined,
    color: embed.hexColor ?? undefined,
    timestamp: embed.timestamp ?? undefined,
    author: embed.author ? { name: embed.author.name, url: embed.author.url, icon_url: embed.author.iconURL } : undefined,
    footer: embed.footer ? { text: embed.footer.text, icon_url: embed.footer.iconURL } : undefined,
    provider: embed.provider ? { name: embed.provider.name, url: embed.provider.url } : undefined,
    image: embed.image?.url,
    thumbnail: embed.thumbnail?.url,
    video: embed.video?.url,
    fields: embed.fields.length > 0 ? embed.fields.map((field) => ({ name: field.name, value: field.value, inline: field.inline ?? false })) : undefined,
  };
}
type EmbedInfo = ReturnType<typeof toEmbedInfo>;

const fetchEmbed = tool({
  description: 'Read everything in a message\'s embeds (link previews, bot cards, etc.): title, description, url, author, footer, fields, images, and more. '
    + 'Defaults to a message in this channel. Other channels can only be read if everyone in the server can see them.',
  inputExamples: [
    { input: { message: '[$4]' } },
    { input: { message: '[$0]' } }, // the message the user is replying to
    { input: { channel: '[#2]', message: '1234567890123456789' } },
  ],
  inputSchema: zod.object({
    message: zod.string().describe('Reference of the message, e.g. [$4], or its id. In a DM with your owner, a message link works too'),
    channel: zod.string().optional().describe('Reference of the message\'s channel, e.g. [#2], or its id. Defaults to this channel'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { message: string, channel?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', content?: string, embeds?: EmbedInfo[], message: string }> => {
    const channel = await resolveTextChannel(context, channelOfMessage(context, input.message, input.channel));
    if (typeof channel === 'string') return { result: 'failure', message: channel };
    if (!isPublicOrCurrent(channel, context)) return { result: 'failure', message: PRIVATE_CHANNEL_MESSAGE };

    const ref = input.message.trim();
    const messageID = resolveMessageID(context, ref);
    const message = messageID ? await safeFetch(() => channel.messages.fetch(messageID)) : undefined;
    if (!message) return { result: 'failure', message: `There is no message ${ref} in ${channelLabel(channel)}.` };
    if (message.embeds.length === 0) return { result: 'failure', message: 'That message has no embeds.' };

    const embeds = message.embeds.map(toEmbedInfo);
    return {
      result: 'success',
      content: message.content || undefined,
      embeds,
      message: `Fetched ${embeds.length} embed${embeds.length === 1 ? '' : 's'}.`,
    };
  },
});

const MAX_USER_SEARCH_RESULTS = 25;
const MAX_LIST_USERS = 100; // most users list_users gives back, so a big server can't fill the prompt

// a user's ref in this conversation, like [@5], made if they don't have one yet, so the model can mention them right away
function userRef(context: ReplyContext, userID: string): string {
  const existing = getIndexUser(context.conversation_id, userID);
  if (existing) return existing.shorthand;

  const shorthand = `[@${getNextUserRef(context.conversation_id)}]`;
  insertIndexUser({ conversation_id: context.conversation_id, user_id: userID, shorthand });
  return shorthand;
}

function toUserCard(context: ReplyContext, member: GuildMember) {
  return {
    ref: userRef(context, member.id),
    name: member.displayName,
    username: member.user.username,
    nickname: member.nickname ?? undefined,
    bot: member.user.bot,
  };
}
type UserCard = ReturnType<typeof toUserCard>;

const searchUsers = tool({
  description: `Search this server's members by the start of their username or nickname. Up to ${MAX_USER_SEARCH_RESULTS} matches. `
    + 'Each one comes with a ref, like [@5], to mention them with.',
  inputExamples: [
    { input: { query: 'ath' } },
    { input: { query: 'foo', limit: 5 } },
  ],
  inputSchema: zod.object({
    query: zod.string().describe('Start of their username or nickname'),
    limit: zod.number().int().optional().describe(`How many matches, from 1 to ${MAX_USER_SEARCH_RESULTS}. Defaults to 10`),
    server: SERVER_FIELD,
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { query: string, limit?: number, server?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', users?: UserCard[], message: string }> => {
    const query = input.query.trim();
    if (!query) return { result: 'failure', message: 'Give some text to search for.' };

    try {
      // the server comes from the bot, so only this server's members can be found. a DM names one instead
      const guild = await resolveGuild(context, input.server);
      if (typeof guild === 'string') return { result: 'failure', message: guild };
      const limit = Math.min(Math.max(input.limit ?? 10, 1), MAX_USER_SEARCH_RESULTS);
      const users = (await guild.members.search({ query, limit })).map((member) => toUserCard(context, member));
      return {
        result: 'success',
        users,
        message: users.length === 0 ? `No members match "${query}".` : `Found ${users.length} members matching "${query}".`,
      };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

const listUsers = tool({
  description: `List the members of this server, or of a channel (who can see it, or who's in it for a voice channel or thread). Up to ${MAX_LIST_USERS}, sorted by name, along with the total. `
    + 'Can be narrowed to a role. Channels other than this one can only be listed if everyone in the server can see them.',
  inputExamples: [
    { input: { scope: 'server' } },
    { input: { scope: 'channel' } }, // this channel
    { input: { scope: 'channel', channel: '[#2]' } },
    { input: { scope: 'server', role: '[&1]' } },
  ],
  inputSchema: zod.object({
    scope: zod.enum(['server', 'channel']).describe('Whether to list the whole server, or one channel'),
    channel: zod.string().optional().describe('With the channel scope: reference of the channel, e.g. [#2], or its id. Defaults to this channel'),
    role: zod.string().optional().describe('Only members with this role: a reference like [&1], or its id'),
    server: SERVER_FIELD.describe('Only in a DM with your owner, for the server scope: which server, by its id or name'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { scope: 'server' | 'channel', channel?: string, role?: string, server?: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', users?: UserCard[], total?: number, truncated?: boolean, message: string }> => {
    try {
      // a channel's server is the one it's in, which in a DM can be any of them. otherwise it's this server, or the one a DM names
      let channel: GuildBasedChannel | undefined;
      if (input.scope === 'channel') {
        const found = await resolveChannel(context, input.channel);
        if (typeof found === 'string') return { result: 'failure', message: found };
        if (found.isDMBased()) return { result: 'failure', message: 'A DM\'s only members are you and your owner.' };
        if (!isPublicOrCurrent(found, context)) return { result: 'failure', message: 'This channel is private, so its members can only be listed from inside it.' };
        channel = found;
      }
      const guild = channel ? channel.guild : await resolveGuild(context, input.server);
      if (typeof guild === 'string') return { result: 'failure', message: guild };
      await guild.members.fetch(); // fills the cache, which channels' member lists are read from

      let members: GuildMember[];
      let where = context.dm ? guild.name : 'this server';
      if (channel) {
        // a thread's members are the people who joined it, rather than everyone who can see it
        members = channel.isThread()
          ? [...(await channel.members.fetch({ withMember: true })).values()].map((threadMember) => threadMember.guildMember).filter((member): member is GuildMember => !!member)
          : [...channel.members.values()];
        where = `#${channel.name}`;
      } else {
        members = [...guild.members.cache.values()];
      }

      if (input.role) {
        const raw = input.role.trim();
        const roleID = /^<?@?&?(\d{17,20})>?$/.exec(raw)?.[1] ?? resolveRoleRef(context.conversation_id, raw) ?? resolveRoleRef(context.conversation_id, `[${raw}]`) ?? resolveRoleRef(context.conversation_id, `[&${raw}]`);
        const role = roleID ? await safeFetch(() => guild.roles.fetch(roleID)) : undefined;
        if (!role) return { result: 'failure', message: `There is no role ${raw} in this server.` };

        members = members.filter((member) => member.roles.cache.has(role.id));
        where += ` with the role ${role.name}`;
      }

      members.sort((a, b) => a.displayName.localeCompare(b.displayName));
      const users = members.slice(0, MAX_LIST_USERS).map((member) => toUserCard(context, member));
      const truncated = members.length > MAX_LIST_USERS;
      return {
        result: 'success',
        users,
        total: members.length,
        truncated: truncated || undefined,
        message: `${members.length} members in ${where}${truncated ? `, showing the first ${MAX_LIST_USERS}` : ''}.`,
      };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

const viewUser = tool({
  description: 'View everything about a member of this server: names, whether they\'re a bot, when they made their account and joined, their roles, avatar, and whether they\'re timed out.',
  inputExamples: [
    { input: { user: '[@3]' } },
    { input: { user: '123456789012345678' } },
  ],
  inputSchema: zod.object({
    user: zod.string().describe('Reference of the user, e.g. [@3], or their id'),
    server: SERVER_FIELD,
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { user: string, server?: string }, { context }: { context: ReplyContext }) => {
    const raw = input.user.trim();
    const userID = /^<?@?!?(\d{17,20})>?$/.exec(raw)?.[1] ?? resolveUserRef(context.conversation_id, raw) ?? resolveUserRef(context.conversation_id, `[${raw}]`) ?? resolveUserRef(context.conversation_id, `[@${raw}]`);
    if (!userID) return { result: 'failure' as const, message: `There is no user with ref ${raw}.` };

    const guild = await resolveGuild(context, input.server);
    if (typeof guild === 'string') return { result: 'failure' as const, message: guild };
    const member = await safeFetch(() => guild.members.fetch(userID));
    if (!member) return { result: 'failure' as const, message: `${raw} isn't a member of ${context.dm ? guild.name : 'this server'}.` };

    const time = (timestamp: number) => new Date(timestamp).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
    return {
      result: 'success' as const,
      user: {
        ...toUserCard(context, member),
        id: member.id,
        account_created: time(member.user.createdTimestamp),
        joined_server: member.joinedTimestamp ? time(member.joinedTimestamp) : undefined,
        roles: member.roles.cache.filter((role) => role.id !== member.guild.id).sort((a, b) => b.position - a.position).map((role) => role.name), // highest first, without @everyone
        avatar_url: member.displayAvatarURL(),
        timed_out_until: member.isCommunicationDisabled() ? time(member.communicationDisabledUntilTimestamp) : undefined,
      },
      message: `Viewed ${member.displayName}.`,
    };
  },
});

const MAX_SENDS_PER_REPLY = 5;
const sendCounts = new WeakMap<ReplyContext, number>(); // send_message calls so far, per reply

const sendMessage = tool({
  description: 'Send a message to a channel in this server (in a DM with your owner, any server), separate from your reply. Use it to post somewhere else, or to post more than one message. '
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
        // pings follow the subscribers of the server it's sent in, which from a DM can be any of them
        const sent = await channel.send({ content: chunk, allowedMentions: chatbotMentions(serverOf(channel, context), chunk) }); // one at a time, so they arrive in order
        messageIDs.push(sent.id);
        saveSentMessage(context, sent);
      }

      return { result: 'success', message_ids: messageIDs, message: `Sent ${messageIDs.length} message${messageIDs.length === 1 ? '' : 's'} in ${channelLabel(channel)}.` };
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

    // in a DM, a message link says which channel to start it in
    const channel = await resolveChannel(context, input.message ? channelOfMessage(context, input.message, input.channel) : input.channel);
    if (typeof channel === 'string') return { result: 'failure', message: channel };
    const serverID = serverOf(channel, context); // pings follow the subscribers of the server it's made in

    try {
      const chunks = input.content?.trim() ? await formatResponse(context.conversation_id, input.content) : [];
      let thread: AnyThreadChannel;
      let rest = chunks; // what's left to post in the thread once it's made

      if (channel.type === ChannelType.GuildForum) {
        if (chunks.length === 0) return { result: 'failure', message: 'A forum post needs a first message, as its content.' };

        thread = await channel.threads.create({ name, message: { content: chunks[0], allowedMentions: chatbotMentions(serverID, chunks[0]) } });
        rest = chunks.slice(1);
        const starter = await thread.fetchStarterMessage().catch(() => null);
        if (starter) saveSentMessage(context, starter);
      } else if (channel.type === ChannelType.GuildText || channel.type === ChannelType.GuildAnnouncement) {
        if (input.message) {
          const ref = input.message.trim();
          const messageID = resolveMessageID(context, ref);
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

      for (const chunk of rest) saveSentMessage(context, await thread.send({ content: chunk, allowedMentions: chatbotMentions(serverID, chunk) })); // one at a time, so they arrive in order

      const ref = channelRef(context, thread.id);
      return { result: 'success', thread: ref, message: `Created thread "${thread.name}" (${ref}) in #${channel.name}.` };
    } catch (error: any) {
      return { result: 'failure', message: String(error?.message ?? error) };
    }
  },
});

// one tool with an action, like counter. the bot can only change the heartbeats it scheduled itself, not ones an admin made
// separate from heartbeat, so that one's name can be required: listing is the only thing that doesn't need one
const listHeartbeats = tool({
  description: 'List this server\'s heartbeats: prompts you\'re given on a schedule, with their schedule, prompt, and whether you made them.',
  inputSchema: zod.object({}),
  contextSchema: replyContextSchema,
  execute: async (_input: Record<string, never>, { context }: { context: ReplyContext }): Promise<{ result: 'success', heartbeats: { name: string, schedule: string, repeats: boolean, silent: boolean, channel_id: string, prompt: string, context?: string, made_by_you: boolean }[], message: string }> => {
    const botID = discordClient.user!.id;
    // from the bot, so it can only see this server's heartbeats
    const heartbeats = getHeartbeatsByServer(context.server_id).map((hb) => ({
      name: hb.heartbeat_name, schedule: hb.cron_schedule, repeats: !!hb.repeats, silent: !!hb.silent, channel_id: hb.channel_id, prompt: hb.prompt, context: hb.context ?? undefined, made_by_you: hb.created_by === botID,
    }));
    return { result: 'success', heartbeats, message: heartbeats.length === 0 ? 'There are no heartbeats in this server.' : `Found ${heartbeats.length} heartbeats.` };
  },
});

// what a schedule has to be for a heartbeat the bot makes. undefined if it's fine
function heartbeatScheduleProblem(schedule: string): string | undefined {
  if (!cron.validate(schedule)) return `Cron schedule is invalid: ${schedule}.`;
  return undefined;
}

// a heartbeat the bot can change: one it made itself. returns why not instead, worded to give to the model as-is
function ownHeartbeat(serverID: Snowflake, name: string): HeartbeatTable | string {
  const existing = getHeartbeat(serverID, name);
  if (!existing) return `There's no heartbeat named "${name}". Use list_heartbeats to see them.`;
  if (existing.created_by !== discordClient.user!.id) return `"${existing.heartbeat_name}" was made by an admin, so only they can change it, with /heartbeat.`;
  return existing;
}

const HEARTBEAT_PROMPT_DESCRIPTION = 'What you\'ll be told when it runs. Write it as a note to your future self, with everything you\'ll need. Refs like [@2] won\'t mean anything by then, so use names and ids';
const HEARTBEAT_CONTEXT_DESCRIPTION = 'Background you\'ll be shown with the prompt, e.g. what was said that it\'s following up on. You won\'t see the channel unless you fetch it';

// create, edit, and delete are separate tools, rather than one with an action, so each one's required fields are actually required
const createHeartbeat = tool({
  description: 'Schedule a heartbeat: a prompt you\'ll be given on a cron schedule, in this channel, so you can post on your own later (e.g. check back on something, or a daily check-in). '
    + `You can have at most ${MAX_BOT_HEARTBEATS}. Schedules are cron. `
    + 'Set silent to true for one whose reply is never posted, for when it only needs to use tools (e.g. browsing Bluesky). It can still send_message if something\'s worth saying.',
  inputExamples: [
    { input: { name: 'Check exam results', prompt: 'Sam (user id 1087654321098765432) gets their exam results today. Ping them with <@1087654321098765432> and ask how it went.', schedule: '0 17 21 10 *', repeats: false } },
    { input: { name: 'Morning check-in', prompt: 'Post a short good morning, and mention any reminders due today.', schedule: '0 9 * * *', repeats: true } },
    { input: { name: 'Bluesky', prompt: 'Check your Bluesky notifications and timeline, and reply to or like anything you want to.', schedule: '0 * * * *', repeats: true, silent: true } },
  ],
  inputSchema: zod.object({
    name: zod.string().describe('Name of the heartbeat, at most 40 characters. Not case-sensitive'),
    prompt: zod.string().describe(HEARTBEAT_PROMPT_DESCRIPTION),
    schedule: zod.string().describe('Cron schedule it runs on. Hour is 0-23'),
    repeats: zod.boolean().describe('Whether it keeps running on the schedule (true), or runs once then deletes itself (false)'),
    context: zod.string().optional().describe(HEARTBEAT_CONTEXT_DESCRIPTION),
    silent: zod.boolean().optional().describe('Whether its reply is never posted (true), or posted in this channel (false). Defaults to false'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string, prompt: string, schedule: string, repeats: boolean, context?: string, silent?: boolean }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    const serverID = context.server_id; // from the bot, so it can only touch this server's heartbeats
    const botID = discordClient.user!.id;

    const name = input.name?.trim();
    if (!name) return { result: 'failure', message: 'A name is needed to create a heartbeat.' };
    if (name.length > 40) return { result: 'failure', message: 'Heartbeat names can be at most 40 characters.' };
    if (!input.prompt?.trim() || !input.schedule?.trim()) return { result: 'failure', message: 'A prompt and a schedule are needed to create a heartbeat.' };
    const scheduleProblem = heartbeatScheduleProblem(input.schedule);
    if (scheduleProblem) return { result: 'failure', message: scheduleProblem };

    const existing = getHeartbeat(serverID, name);
    if (existing) return { result: 'failure', message: `There's already a heartbeat named "${existing.heartbeat_name}".` };
    if (getHeartbeatsByServer(serverID).filter((hb) => hb.created_by === botID).length >= MAX_BOT_HEARTBEATS) {
      return { result: 'failure', message: `You already have ${MAX_BOT_HEARTBEATS} heartbeats in this server. Delete one first.` };
    }

    const created = { server_id: serverID, heartbeat_name: name, channel_id: context.channel_id, created_by: botID, repeats: !!input.repeats, silent: input.silent ?? false, cron_schedule: input.schedule, prompt: input.prompt, context: input.context };
    insertHeartbeat(created);
    scheduleHeartbeat(created);
    return { result: 'success', message: `Scheduled heartbeat "${name}" (${input.schedule}${created.repeats ? ', repeating' : ', once'}${created.silent ? ', silent' : ''}).` };
  },
});

const editHeartbeat = tool({
  description: 'Change a heartbeat you made: its prompt, background, schedule, whether it repeats, or whether it\'s silent. Only what you give is changed. To see them, use list_heartbeats.',
  inputExamples: [
    { input: { name: 'Morning check-in', schedule: '0 8 * * *' } },
    { input: { name: 'Bluesky', silent: false } },
  ],
  inputSchema: zod.object({
    name: zod.string().describe('Name of the heartbeat to change. Not case-sensitive'),
    prompt: zod.string().optional().describe(`New prompt. ${HEARTBEAT_PROMPT_DESCRIPTION}`),
    context: zod.string().optional().describe(`New background. ${HEARTBEAT_CONTEXT_DESCRIPTION}`),
    schedule: zod.string().optional().describe('New cron schedule. Hour is 0-23'),
    repeats: zod.boolean().optional().describe('Whether it keeps running on the schedule (true), or runs once then deletes itself (false)'),
    silent: zod.boolean().optional().describe('Whether its reply is never posted (true), or posted in this channel (false)'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string, prompt?: string, context?: string, schedule?: string, repeats?: boolean, silent?: boolean }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    if (!input.name?.trim()) return { result: 'failure', message: 'A name is needed to edit a heartbeat.' };
    const existing = ownHeartbeat(context.server_id, input.name.trim()); // from the bot, so it can only touch this server's heartbeats
    if (typeof existing === 'string') return { result: 'failure', message: existing };

    if (input.prompt === undefined && input.context === undefined && input.schedule === undefined && input.repeats === undefined && input.silent === undefined) {
      return { result: 'failure', message: 'Give a new prompt, context, schedule, repeats, or silent to edit.' };
    }
    if (input.schedule !== undefined) {
      const scheduleProblem = heartbeatScheduleProblem(input.schedule);
      if (scheduleProblem) return { result: 'failure', message: scheduleProblem };
    }

    const edited = {
      ...existing,
      prompt: input.prompt ?? existing.prompt,
      context: input.context ?? existing.context,
      cron_schedule: input.schedule ?? existing.cron_schedule,
      repeats: input.repeats ?? !!existing.repeats,
      silent: input.silent ?? !!existing.silent,
    };
    updateHeartbeat(edited);
    scheduleHeartbeat(edited);
    return { result: 'success', message: `Edited heartbeat "${existing.heartbeat_name}".` };
  },
});

const deleteHeartbeat = tool({
  description: 'Delete a heartbeat you made, so it stops running. To see them, use list_heartbeats.',
  inputExamples: [
    { input: { name: 'Morning check-in' } },
  ],
  inputSchema: zod.object({
    name: zod.string().describe('Name of the heartbeat to delete. Not case-sensitive'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { name: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    if (!input.name?.trim()) return { result: 'failure', message: 'A name is needed to delete a heartbeat.' };
    const existing = ownHeartbeat(context.server_id, input.name.trim()); // from the bot, so it can only touch this server's heartbeats
    if (typeof existing === 'string') return { result: 'failure', message: existing };

    removeHeartbeat(existing);
    return { result: 'success', message: `Deleted heartbeat "${existing.heartbeat_name}".` };
  },
});

// the web service in docker-compose.yml passes every request here to a web server the bot runs in its workspace
const { SITE_URL } = process.env;
const SITE_DESCRIPTION = SITE_URL
  ? ` Your public website is ${SITE_URL}: every request to it is passed to whatever web server you run in your workspace, which must listen on 0.0.0.0 port 80. `
    + 'Start it in the background, with its input and output redirected, so it outlives the command and the command doesn\'t hang: '
    + 'setsid nohup python3 server.py < /dev/null > server.log 2>&1 & echo $! > server.pid (stop it with kill $(cat server.pid)). '
    + 'Put the commands that start it in start.sh, which is run whenever your workspace starts, so the site comes back on its own after a restart. '
    + 'Only publish through this site: never open tunnels (cloudflared, ngrok, ...) or other ways in, since they skip its protections. '
    + 'Anyone on the internet can reach it, so never serve NOTES.md or anything private, and never let a visitor\'s input be run as code or commands.'
  : '';

const SANDBOX_DESCRIPTION = 'Your own persistent Linux workspace (Debian, with python3, pip, git, curl, and jq, and internet access). '
  + 'Everything you save there is kept between replies, conversations, and every server you share memories with. '
  + `Keep NOTES.md up to date with what you're working on and anything you'll want later: it's shown to you at the start of every reply.${SITE_DESCRIPTION}`;
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
    if (!isAttached(context.server_id) && !context.dm) return { result: 'failure', message: DETACHED_MESSAGE }; // a DM with the bot's owner always can

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
  description: `Write a file in your workspace, replacing it if it exists. Folders are created as needed. To change part of a file that already exists, use edit_file instead. ${SANDBOX_DESCRIPTION}`,
  inputExamples: [
    { input: { path: 'NOTES.md', content: '# Notes\n- Working on: a dice roller in dice.py\n' } },
  ],
  inputSchema: zod.object({
    path: zod.string().describe('Path of the file, relative to /workspace'),
    content: zod.string().describe('Full content of the file'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { path: string, content: string }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    if (!isAttached(context.server_id) && !context.dm) return { result: 'failure', message: DETACHED_MESSAGE }; // a DM with the bot's owner always can

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

// done inside the container, since the output of a command is cut short, so a long file could never be read out here and written back whole.
// newline='' keeps the file's line endings as they are
const EDIT_SCRIPT = `
import json, os, sys

edit = json.loads(sys.stdin.buffer.read())
path = os.environ['FILE']

try:
    with open(path, encoding='utf-8', newline='') as file:
        content = file.read()
except (OSError, UnicodeDecodeError) as error:
    sys.exit(f'Could not read {path}: {error}')

matches = content.count(edit['old_text'])
if matches == 0:
    sys.exit(f'old_text was not found in {path}, so nothing was changed. It has to match exactly, including whitespace.')
if matches > 1 and not edit['replace_all']:
    sys.exit(f'old_text matches {matches} places in {path}, so nothing was changed. Include more of the surrounding text, or set replace_all.')

with open(path, 'w', encoding='utf-8', newline='') as file:
    file.write(content.replace(edit['old_text'], edit['new_text']))
print(matches)
`;

const editFile = tool({
  description: 'Change part of a file in your workspace by replacing exact text, leaving the rest of the file as it is. '
    + 'Use this rather than write_file for existing files, so nothing gets lost in rewriting them. old_text has to match the file exactly, including whitespace, and only once unless replace_all is set: '
    + 'if it doesn\'t, the file isn\'t changed. Command output is cut to the last 4000 characters, so to see the exact text in a long file, read it in parts with sed -n \'100,200p\' file or find it with grep -n.',
  inputExamples: [
    { input: { path: 'NOTES.md', old_text: '- Working on: a dice roller', new_text: '- Finished: a dice roller' } },
    { input: { path: 'scripts/stats.py', old_text: 'old_name', new_text: 'new_name', replace_all: true } },
  ],
  inputSchema: zod.object({
    path: zod.string().describe('Path of the file, relative to /workspace'),
    old_text: zod.string().min(1).describe('The exact text to replace. Include enough of the surrounding text to match only one place'),
    new_text: zod.string().describe('The text to put in its place. Empty to delete it'),
    replace_all: zod.boolean().optional().describe('Replace every match, rather than requiring exactly one'),
  }),
  contextSchema: replyContextSchema,
  execute: async (input: { path: string, old_text: string, new_text: string, replace_all?: boolean }, { context }: { context: ReplyContext }): Promise<{ result: 'success' | 'failure', message: string }> => {
    if (!isAttached(context.server_id) && !context.dm) return { result: 'failure', message: DETACHED_MESSAGE }; // a DM with the bot's owner always can
    if (!input.old_text) return { result: 'failure', message: 'old_text can\'t be empty.' };

    try {
      // like write_file, the path goes in as a variable and the text through stdin, so neither is ever parsed as bash
      const { exit_code, stdout, stderr } = await sandboxExec('python3 -c "$EDIT_SCRIPT"', {
        stdin: JSON.stringify({ old_text: input.old_text, new_text: input.new_text, replace_all: !!input.replace_all }),
        env: { FILE: input.path, EDIT_SCRIPT },
        timeout: 10,
      });
      return exit_code === 0
        ? { result: 'success', message: `Replaced ${stdout.trim()} match${stdout.trim() === '1' ? '' : 'es'} in ${input.path}.` }
        : { result: 'failure', message: stderr.trim() || `Editing the file failed with code ${exit_code}.` };
    } catch (error: any) {
      return { result: 'failure', message: `The workspace isn't available: ${error?.message ?? error}` };
    }
  },
});

export { LocalTool };
export default { reactToMessage, changeNickname, createReminder, editReminder, listReminders, viewReminder, removeReminder, createMemory, listMemories, viewMemory, editMemory, removeMemory, searchSummaries, fetchURL, captionImage: captionImageTool, viewImage: viewImageTool, xSearch, bluesky, blueskyAct, blueskyDMs, listCounters, counter, metacog, listHeartbeats, createHeartbeat, editHeartbeat, deleteHeartbeat, fetchChannel, searchChannel, fetchEmbed, searchUsers, listUsers, viewUser, sendMessage, createThread, runCommand, writeFile, editFile };
