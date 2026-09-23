import path from 'node:path';
import { Client, Message, Snowflake } from 'discord.js';
import { generateText, ModelMessage } from 'ai';
import { xai } from '@ai-sdk/xai';

import { readFile } from 'fs/promises';

import { deleteNOldestLongTermMemories, deleteNOldestShortTermMemory, getChatbot, getChatbotLongTermMemoriesByServer, getChatbotShortTermMemoriesByServer, insertChatbotLongTermMemory, insertChatbotShortTermMemory, upsertChatbot } from './data';
import { ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable, ChatbotTable } from './types/schema';
import { openAIClient } from '.';
import { dotProduct } from './utils';

const promptPath = path.join(__dirname, '../data/SYSTEM.md');
const { DISCORD_ID } = process.env;

const longMemoryLength = 3; // number of messages allowed before being summarized to core memory
const shortMemoryLength = 60; // number of messages allowed in short-term memory

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
VOICE: max 6 short items.
PEOPLE: one line per person: "name: traits; relationship; key facts". Max 12 people, ~200 chars each. If there are more, keep those who interact with you most.
OPEN THREADS: max 5.
SERVER: max 5.

Example of a bad line: "Sam said on Tuesday he had pizza and was tired."
Example of a good line: "Sam: night owl, dev; loves puns, you tease each other about them."

LENGTH: aim for about 1,800 characters. Never exceed 3,000. If you're over, cut lowest-value lines first: SERVER, then details on less active people, then VOICE items, and OPEN THREADS last.

Output only the updated core memory, with no preamble.

PERSONA (do not restate): {{persona}}

CURRENT CORE MEMORY:
{{core_memory}}

NEW MEMORIES:
{{new_memories}}`;

// prompt for summarizing short-term memory to long-term memory
const cullingPrompt = `You're foo, a chatbot on a Discord server. The following messages are your short term memory. Summarize them to form your long-term memory.
Only include the summarization, no preamble. Be as concise as possible, while still keeping important information. This will go into your long-term memory, and we wish to minimize tokens. Use bullet points to keep information concise.
Please summarize the important information, and information that will most likely be relevant later. If you have information to add to a member's personality, then add it.
Do not restate any information. It will stay as a list for you to read in the future. Keep it to 200 words or less.`;

function getSummarizationPrompt(chatbot: ChatbotTable, longTermMemory: ChatbotLongTermMemoryTable[]): string {
  const longtermMemoryStr = longTermMemory.map((ltm) => `[${new Date(ltm.timestamp)}]: ${ltm.message_content}`).join('\n');

  return summarizingPrompt
    .replace('{{persona}}', chatbot.chatbot_prompt)
    .replace('{{core_memory}}', chatbot.chatbot_core_memory)
    .replace('{{new_memories}}', longtermMemoryStr);
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
    reasoning: 'high',
    temperature: 0.3,
    system: getSummarizationPrompt(chatbot, longTermMemory),
    headers: {
      'x-grok-conv-id': '917594803481489429',
    },
  });

  deleteNOldestLongTermMemories(server_id, longTermMemory.length - 1); // clear long-term memory, leaving 1 most recent entries

  const updatedCoreMemory = text ?? '';
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
    temperature: 0.3,
    prompt: grokInput,
    headers: {
      'x-grok-conv-id': '917594803481489429',
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
  if (longTermMemory.length > longMemoryLength) {
    await summarizeMemory(server_id, longTermMemory);
  }

  // cull memory if over max length
  if (shortTermMemory.length > shortMemoryLength) {
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
async function getTopMatches(targetMessage: ChatbotShortTermMemoryTable, shortTermMemory: ChatbotShortTermMemoryTable[], k: number = 8): Promise<ChatbotShortTermMemoryTable[]> {
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
    .map((stm) => stm.id);         // map back to only ids

  return shortTermMemory.filter((stm) => topScoredMessages.includes(stm.message_id));
}

async function generateMessage(discordClient: Client<boolean>, serverID: Snowflake, typingIndicator: NodeJS.Timeout, userMessage: Message<boolean>, authorNick: string | null, userContent: string, messageReference: Message<boolean> | undefined, context: Message<boolean>[]): Promise<string> {
  const chatbot = getChatbot(serverID)!;
  const basePrompt = chatbot.chatbot_prompt;
  const coreMemory = chatbot.chatbot_core_memory;
  const longTermMemory = getChatbotLongTermMemoriesByServer(serverID);
  const shortTermMemory = getChatbotShortTermMemoriesByServer(serverID);

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
    context = context.filter((m1) => (shortTermMemory.findIndex((m2) => m1.createdTimestamp === m2.timestamp)) === -1).sort((m) => m.createdTimestamp).reverse(); // filter out duplicate context messages

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
    if (!shortTermMemory.find((stm) => messageReference.id === stm.message_id)) {
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

  const agentInput: ModelMessage[] = [
    // Rest of messages at end, reformatted
    ...relevantMessages.map((msg) => ({
      role: msg.role,
      content: `<msg user_id="${msg.author_id}" name="${msg.author_name}"${authorNick ? ` nick="${authorNick}"` : ''} id="${msg.message_id}"${msg.reference_id ? ` references="${msg.reference_id}"` : ''} time="${new Date(msg.timestamp).toLocaleString()}">${msg.message_content}</msg>`,
    })),
  ];

  // add longterm memories to beginning of input
  const longtermMemoryStr = longTermMemory.map((ltm) => `[${new Date(ltm.timestamp)}]: ${ltm.message_content}`).join('\n');
  agentInput.unshift({
    role: 'assistant',
    content: `Longterm Memory:\n${longtermMemoryStr}`,
  });

  shortTermMemory.forEach((stm) => insertChatbotShortTermMemory(stm));

  try {
    const grokResponse = await generateText({
      model: xai.responses('grok-4.5'),
      system: `${basePrompt}\nCore Memory: ${coreMemory}\n}`,
      prompt: agentInput,
      reasoning: 'medium',
      temperature: 1.2,
      tools: chatbot.tools_enabled ? {
        web_search: xai.tools.webSearch(),
        x_search: xai.tools.xSearch(),
        code_execution: xai.tools.codeExecution(),
      } : undefined,
      headers: {
        'x-grok-conv-id': '917594803481489429',
      },
    });

    let responseContent = grokResponse.text ?? 'idk bruh 💀';

    // remove thinking tokens from final message (xAI has a history of not automatically removing them)
    const thinkStartIndex = responseContent.indexOf('<think>');
    if (thinkStartIndex !== -1) {
      const thinkEndIndex = responseContent.indexOf('</think>') + '</think>'.length;
      responseContent = responseContent.substring(0, thinkStartIndex) + responseContent.substring(thinkEndIndex);
    }

    // replace mass pings with invisible character to not have them actuated
    responseContent = responseContent.replace('@everyone', '@​everyone').replace('@here', '@​here');

    testMemoryEncoding(serverID, longTermMemory, shortTermMemory);
    clearInterval(typingIndicator);

    return responseContent;
  } catch (error: any) {
    clearInterval(typingIndicator);
    console.error(error);
    return error.toString();
  }
}

export { getDefaultSystemPrompt, generateMessage };
