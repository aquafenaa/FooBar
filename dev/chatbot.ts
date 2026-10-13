import path from 'node:path';
import { Guild, Message, Snowflake } from 'discord.js';
import { generateText, ModelMessage, streamText } from 'ai';
import { xai } from '@ai-sdk/xai';

import { readFile } from 'fs/promises';

import { deleteNOldestLongTermMemories, deleteNOldestShortTermMemory, getChatbot, getChatbotLongTermMemoriesByServer, getChatbotShortTermMemoriesByServer, insertChatbotLongTermMemory, insertChatbotShortTermMemory, upsertChatbot } from './data';
import { ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable, ChatbotTable } from './types/schema';
import { discordClient, openAIClient } from '.';
import { dotProduct, safeFetch, splitPoint, trackFence } from './utils';

const promptPath = path.join(__dirname, '../data/SYSTEM.md');
const { DISCORD_ID } = process.env;

const MAX_MESSAGE_LENGTH = 2000;
const PADDING_LENGTH = 8;
const LONGTERM_MEMORY_LENGTH = 3; // number of messages allowed before being summarized to core memory
const SHORT_TERM_MEMORY_LENGTH = 60; // number of messages allowed in short-term memory

// prompt for summarizing long-term memory to core memory
const summarizingPrompt = `You maintain your own long-term memory of a Discord server. You'll receive your CURRENT CORE MEMORY (possibly empty) and NEW MEMORIES since the last update. Produce the UPDATED CORE MEMORY: a small, curated set of facts that will most improve how you talk to these people in the future. It is not an archive. Forgetting is expected and good.

THE TEST for every line: "If I forgot this, would my future replies be noticeably worse?" If not, drop it.

KEEP, in priority order:
1. Stable facts about people: names/nicknames, things they told you about themselves, standing preferences, running jokes with them, and how you relate to them (close, teasing, wary...).
2. Your established voice: recurring phrases, slang, quirks, and opinions you've committed to. Only those that recur or clearly define you.
3. Open threads: promises, planned events, and ongoing situations that are still unresolved.
4. Server norms or in-jokes that people actually reference more than once.

DROP:
- One-off events and small talk with no lasting consequence.
- Anything resolved, or events whose date has passed.
- Details mentioned once and never reinforced.
- Anything restating the PERSONA below.
- Exact quotes, unless the phrase itself is the memory.
- Duplicates: merge them and keep the most specific, most recent version.

MERGING:
- Start from CURRENT CORE MEMORY and update it using NEW MEMORIES. If new info contradicts an old entry, keep only the new one.
- Do not keep an entry just because it was already there. Old entries that nothing reinforces and that are low value should be removed.

FORMAT (plain text, terse fragments, no filler words):
PEOPLE: one line per person: "name: traits; relationship; key facts". Max 12 people, ~200 chars each. If there are more, keep those who interact with you most.
OPEN THREADS: max 5.
SERVER: max 5.

Example of a bad line: "Sam said on Tuesday he had pizza and was tired."
Example of a good line: "Sam: night owl, dev; loves puns, you tease each other about them."

LENGTH: aim for about 1,800 characters. Never exceed 3,500. If you're over, cut lowest-value lines first: SERVER, then details on less active people, then VOICE items, and OPEN THREADS last.

Output only the updated core memory, with no preamble.

PERSONA (do not restate): {{persona}}

CURRENT CORE MEMORY:
{{core_memory}}`;

// prompt for summarizing short-term memory to long-term memory
const cullingPrompt = `You're foo, a chatbot on a Discord server. The following messages are your short term memory. Summarize them to form your long-term memory.
Only include the summarization, no preamble. Be as concise as possible, while still keeping important information. This will go into your long-term memory, and we wish to minimize tokens. Use bullet points to keep information concise.
Please summarize the important information, and information that will most likely be relevant later. If you have information to add to a member's personality, then add it.
Do not restate any information. It will stay as a list for you to read in the future. Keep it to 200 words or less.`;

function getSummarizationPrompt(chatbot: ChatbotTable): string {
  return summarizingPrompt
    .replace('{{persona}}', chatbot.chatbot_prompt)
    .replace('{{core_memory}}', chatbot.chatbot_core_memory);
}

async function getDefaultSystemPrompt(): Promise<string> {
  return (await readFile(promptPath, 'utf-8')).replace('<discord-id>', DISCORD_ID ?? 'undefined');
}

async function summarizeMemory(server_id: Snowflake, longTermMemory: ChatbotLongTermMemoryTable[]) {
  let chatbot = getChatbot(server_id);

  if (!chatbot) {
    chatbot = {
      server_id,
      chatbot_enabled: false,
      tools_enabled: false,
      chatbot_prompt: await getDefaultSystemPrompt(),
      chatbot_core_memory: '',
    };
  }

  const longtermMemoryStr = longTermMemory.map((ltm) => `[${new Date(ltm.timestamp)}]: ${ltm.message_content}`).join('\n');

  const { text } = await generateText({
    model: xai.responses('grok-4.3'),
    prompt: longtermMemoryStr,
    reasoning: 'medium',
    temperature: 0.3,
    system: getSummarizationPrompt(chatbot),
    headers: {
      'x-grok-conv-id': server_id,
    },
  });

  deleteNOldestLongTermMemories(server_id, longTermMemory.length - 1); // clear long-term memory, leaving 1 most recent entries

  const updatedCoreMemory = text.substring(0, 4000);
  chatbot.chatbot_core_memory = updatedCoreMemory;

  upsertChatbot(chatbot);
}

// asks grok to summarize short-term memory to become long-term memory, and then long-term memory to bco
async function cullMemory(server_id: Snowflake, shortTermMemory: ChatbotShortTermMemoryTable[]) {
  const grokInput: ModelMessage[] = shortTermMemory.map((msg) => ({
    role: msg.role,
    content: `<msg user_id="${msg.author_id}" nick="${msg.author_name}" id="${msg.message_id}"${msg.reference_id ? ` references="${msg.reference_id}"` : ''} time="${new Date(msg.timestamp).toLocaleString()}">${msg.message_content}</msg>`,
  }));

  const { text } = await generateText({
    model: xai.responses('grok-4.3'),
    system: cullingPrompt,
    reasoning: 'medium',
    temperature: 0.4,
    prompt: grokInput,
    headers: {
      'x-grok-conv-id': server_id,
    },
  });
  const newLongTermMemory: Omit<ChatbotLongTermMemoryTable, 'memory_id'> = {
    server_id,
    message_content: text ?? '',
    timestamp: Date.now(),
  };

  deleteNOldestShortTermMemory(server_id, shortTermMemory.length - 2); // clear short-term memory
  insertChatbotLongTermMemory(newLongTermMemory); // add summary to long-term memory
}

/**
 * If memory is too large, summarize or cull it
*/
async function testMemoryEncoding(server_id: Snowflake, longTermMemory: ChatbotLongTermMemoryTable[], shortTermMemory: ChatbotShortTermMemoryTable[]) {
  // summarize, if short term memory is too large
  if (longTermMemory.length > LONGTERM_MEMORY_LENGTH) {
    await summarizeMemory(server_id, longTermMemory);
  }

  // cull memory if over max length
  if (shortTermMemory.length > SHORT_TERM_MEMORY_LENGTH) {
    await cullMemory(server_id, shortTermMemory);
  }
}

async function getEmbedding(shortTermMemory: string | ChatbotShortTermMemoryTable): Promise<number[]> {
  const inputText = typeof shortTermMemory === 'string'
    ? shortTermMemory
    : shortTermMemory.message_content;

  const embedding = await openAIClient.embeddings.create({
    model: 'text-embedding-3-small',
    input: inputText,
    encoding_format: 'float',
  });

  return embedding.data[0].embedding;
}

// get k messages in shortTermMemory that are most similar to the target messages
async function getTopMatches(targetMessage: ChatbotShortTermMemoryTable, shortTermMemory: ChatbotShortTermMemoryTable[], k: number = 8, p = 0.2): Promise<ChatbotShortTermMemoryTable[]> {
  // creates a list of each STMs dot product with targetMessage, in ascending order, then gets top k results
  const topScoredMessages = (await Promise.all(shortTermMemory.map(async (stm) => (
    {
      id: stm.message_id,
      dot: dotProduct(
        stm.embedding !== undefined ? stm.embedding : await getEmbedding(stm.message_content),
        targetMessage.embedding!,
      ),
    }
  ))))
    .sort((a, b) => b.dot - a.dot) // ascending order
    .slice(0, k)                   // top k results
    .filter((stm) => stm.dot >= p) // filter minmum similarity, p
    .map((stm) => stm.id);         // map back to only ids

  return shortTermMemory.filter((stm) => topScoredMessages.includes(stm.message_id));
}

/**
 * Given short term memories, return a formatted chatbot input
 * Resolves user, channel, and role mentions.
*/
async function formatInput(guild: Guild, messages: ChatbotShortTermMemoryTable[]): Promise<ModelMessage[]> {
  if (!messages) return [];
  const MENTION_RE = /<(?:@!?(\d{17,20})|#(\d{17,20})|@&(\d{17,20}))>/g; // 3 capture groups for users, channels, & role mentions respectively
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  const mentionedUserIDs: Snowflake[] = messages.map((m) => m.author_id);
  const mentionedChannelIDs: Snowflake[] = [];
  const mentionedRoleIDs: Snowflake[] = [];

  // get all references from each message
  messages.forEach((msg) => {
    for (const m of msg.message_content.matchAll(MENTION_RE)) {
      const [, userId, channelId, roleId] = m; // exactly one of the three is defined
      if (userId) mentionedUserIDs.push(userId);
      if (channelId) mentionedChannelIDs.push(channelId);
      if (roleId) mentionedRoleIDs.push(roleId);
    }
  });

  // resolve mentionables in guild from IDs
  const mentionedUsers = Array.from((await Promise.all([...new Set(mentionedUserIDs)].map((user) => safeFetch(() => guild.members.fetch(user))))).filter((m) => m !== undefined && m !== null).values());
  const mentionedChannels = Array.from((await Promise.all([...new Set(mentionedChannelIDs)].map((channel) => safeFetch(() => guild.channels.fetch(channel))))).filter((m) => m !== undefined && m !== null).values());
  const mentionedRoles = Array.from((await Promise.all([...new Set(mentionedRoleIDs)].map((role) => safeFetch(() => guild.roles.fetch(role))))).filter((m) => m !== undefined && m !== null).values());

  // populate all references with their relevant symbols
  const referenceList = new Map<string, string>();
  mentionedUsers.forEach((userID, i) => referenceList.set(userID.id, `[@${i}]`));
  mentionedChannels.forEach((channelID, i) => referenceList.set(channelID.id, `[#${i}]`));
  mentionedRoles.forEach((userID, i) => referenceList.set(userID.id, `[&${i}]`));

  // replaces mentioned IDs with their shorter references. (saves a HUGE number of input tokens, since long numbers tokenize poorly)
  const respondMap = new Map<string, number>();
  const stm = messages.map((msg, i) => {
    respondMap.set(msg.message_id, i);
    return {
      ...msg,
      message_content: msg.message_content.replace(/^> -# .*(?:\r?\n|$)/gm, '').replace(MENTION_RE, (_, u, c, r) => referenceList.get(u ?? c ?? r) ?? 'unknown'),
    };
  });

  // format the message to include message number, and reference message number
  const modelMessages: ModelMessage[] = stm.map((msg, i) => ({
    role: msg.author_id === discordClient.user!.id ? 'assistant' : 'user',
    content: msg.author_id !== discordClient.user!.id // if not us
      ? `[$${i}] ${respondMap.get(msg.reference_id ?? '') !== undefined ? `↪ [$${respondMap.get(msg.reference_id!)}] ` : ''}${msg.author_name}: ${msg.message_content}`
      : `[$${i}] ${msg.message_content}`,
  }));

  const indexMsg: ModelMessage = {
    role: 'system',
    content:
    `<index>
    ${mentionedUsers.length === 0
    ? ''
    : `<users>
      ${mentionedUsers.map((user) => `<user id="${user.id}" name="${esc(user.user.displayName)}" nick="${esc(user.nickname ?? '')}" bot="${user.user.bot}" refID="${referenceList.get(user.id)}" />`).join('\n\t')}
    </users>`}
    ${mentionedChannels.length === 0
    ? ''
    : `<channels>
      ${mentionedChannels.map((channel) => `<channel id="${channel.id}" name="${esc(channel.name)}" refID="${referenceList.get(channel.id)}" />`).join('\n\t')}
    </channels>`}
    ${mentionedRoles.length === 0
    ? ''
    : `<roles>
      ${mentionedRoles.map((role) => `<role id="${role.id}" name="${esc(role.name)}" mentionable="${role.mentionable}" refID="${referenceList.get(role.id)}" />`).join('\n\t')}
      </roles>`}
    </index>`,
  };

  modelMessages.unshift(indexMsg);

  return modelMessages;
}

/**
 * Splits a finished LLM response into Discord-safe message chunks (<= 2000 chars),
 * preserving open code fences across the split.
*/
async function formatResponse(agentResponse: string): Promise<string[]> {
  const chunks: string[] = [];
  let rest = agentResponse.replace(/(?<!")\[\$\d+\]|\[\$\d+\](?!")/g, ''); // replace local message numbers from output
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

  return chunks;
}

async function handleChatbotReply(serverID: Snowflake, typingIndicator: NodeJS.Timeout, userMessage: Message<boolean>, userContent: string, messageReference: Message<boolean> | undefined, context: Message<boolean>[]): Promise<void> {
  if (!userMessage?.channel.isSendable()) return;

  const chatbot = getChatbot(serverID)!;
  const basePrompt = chatbot.chatbot_prompt;
  const coreMemory = chatbot.chatbot_core_memory;
  const longTermMemory = getChatbotLongTermMemoriesByServer(serverID);
  const shortTermMemory = getChatbotShortTermMemoriesByServer(serverID);
  const guild = await discordClient.guilds.fetch(serverID)!;

  const userSTM: ChatbotShortTermMemoryTable = {
    server_id: serverID,
    role: 'user',
    author_name: userMessage.author.displayName,
    author_id: userMessage.author.id,
    message_id: userMessage.id,
    embedding: await getEmbedding(userContent),
    reference_id: messageReference?.id ?? undefined,
    timestamp: userMessage.createdTimestamp,
    message_content: userContent,
  };

  // find messages most related to our user message
  const relevantMessages = await getTopMatches(userSTM, shortTermMemory, 3);

  shortTermMemory.push(userSTM);
  relevantMessages.push(userSTM);

  // get 5 most recent messages from current channel, and add them to both arrays
  if (context) {
    context = context.filter((m1) => (relevantMessages.findIndex((m2) => m1.createdTimestamp === m2.timestamp)) === -1).sort((m) => m.createdTimestamp).reverse(); // filter out duplicate context messages

    // add messages to short term memory
    const referenceSTMs: ChatbotShortTermMemoryTable[] = (
      await Promise.all(
        context.map(async (m) => ({
          server_id: serverID,
          role: m.author.id === discordClient.user!.id ? 'assistant' : 'user',
          author_name: m.author.displayName,
          author_id: m.author.id,
          message_id: m.id,
          embedding: await getEmbedding(m.content),
          message_content: m.content,
          timestamp: m.createdTimestamp,
        } as ChatbotShortTermMemoryTable)),
      )
    );

    shortTermMemory.push(...referenceSTMs);
    relevantMessages.push(...referenceSTMs);
  }

  if (messageReference) {
    if (!relevantMessages.find((stm) => messageReference.id === stm.message_id)) {
      // add referenced message to beginning to local STM array for reference
      const referenceSTM: ChatbotShortTermMemoryTable = {
        role: messageReference.author.id === discordClient.user?.id ? 'assistant' : 'user',
        server_id: serverID,
        timestamp: messageReference.createdTimestamp,
        author_id: messageReference.author.id,
        author_name: messageReference.author.displayName,
        embedding: await getEmbedding(messageReference.content),
        message_content: messageReference.content,
        message_id: messageReference.id,
      };

      shortTermMemory.unshift(referenceSTM);
      relevantMessages.unshift(referenceSTM);
    }
  }

  // sort by timestamp
  relevantMessages.sort((msg1, msg2) => msg1.timestamp - msg2.timestamp);

  const agentInput = await formatInput(guild, relevantMessages);

  // add longterm memories to beginning of input
  const longtermMemoryStr = longTermMemory.map((ltm) => `<mem date="${new Date(ltm.timestamp)}">${ltm.message_content}</mem>`).join('\n');

  shortTermMemory.forEach((stm) => insertChatbotShortTermMemory(stm));

  const messageChannel = userMessage.channel;
  const indexMsg = agentInput.shift()!;

  let status = '-# thinking...';
  const toolMessage = await messageChannel.send(status);

  // starts text stream
  const grokResponse = streamText({
    model: xai.responses('grok-4.5'),
    system:
    `<prompt>
      ${basePrompt}
    </prompt>
    <memory>
      <core>
        ${coreMemory}
      </core>
      <longterm_memory>
        ${longtermMemoryStr}
      </longterm_memory>
    </memory>
    <index>
      ${indexMsg.content}
    </index>`,
    prompt: agentInput,

    reasoning: 'medium',
    temperature: 1.1,

    tools: chatbot.tools_enabled ? {
      web_search: xai.tools.webSearch(),
      x_search: xai.tools.xSearch(),
      code_execution: xai.tools.codeExecution(),
    } : undefined,

    headers: {
      'x-grok-conv-id': serverID, // to ensure the requests are routed to the same server, for caching reasons
    },
  });

  let streamStr = '';
  let streamedLast = false;
  const toolSet = new Set();

  try {
    for await (const part of grokResponse.stream) {
      switch (part.type) {
        case 'text-delta':
          streamStr += part.text;
          streamedLast = true;
          break;
        case 'tool-call':
          if (streamedLast) {
            streamStr += '\n';
            streamedLast = false;
          }

          status = `-# using ${part.toolName}...`;
          toolMessage.edit(status);
          break;
        case 'tool-result':
          toolSet.add(part.toolName);

          break;
        case 'error':
          throw part.error;
        default:
          continue;
      }
    }

    const toolStr = Array.from(toolSet).map((toolName) => `> -# used ${toolName}`).join('\n');
    const replyArr = await formatResponse(`${toolStr}\n\n${streamStr}`);

    toolMessage.delete();

    const initialResponse = replyArr.shift() ?? '';
    await userMessage.reply(initialResponse);
    replyArr.forEach(async (reply) => {
      await messageChannel.send(reply);
    });

    testMemoryEncoding(serverID, longTermMemory, shortTermMemory).catch((error) => console.error(error));
  } catch (error) {
    console.error(error);
    toolMessage.edit('There was an issue... Please try again later...');
  } finally {
    clearInterval(typingIndicator);
  }
}

export { getDefaultSystemPrompt, handleChatbotReply };
