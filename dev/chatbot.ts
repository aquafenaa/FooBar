import path from 'node:path';
import { Client, Message, Snowflake } from 'discord.js';
import { generateText, ModelMessage } from 'ai';
import { xai } from '@ai-sdk/xai';

import { readFile } from 'fs/promises';

import { deleteNOldestLongTermMemories, deleteNOldestShortTermMemory, getChatbot, getChatbotLongTermMemoriesByServer, getChatbotShortTermMemoriesByServer, insertChatbotLongTermMemory, insertChatbotShortTermMemory, upsertChatbot } from './data';
import { ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable } from './types/schema';
import { openAIClient } from '.';
import { dotProduct } from './utils';

const promptPath = path.join(__dirname, '../data/SYSTEM.md');
const { DISCORD_ID } = process.env;

const longMemoryLength = 3; // number of messages allowed before being summarized to core memory
const shortMemoryLength = 30; // number of messages allowed in short-term memory

// prompt for summarizing long-term memory to core memory
const summarizingPrompt = `The following messages are summarizations of your experience on the server, stored in your long-term memory.
Summarize these messages into a single message to act as your permanent/core memories.
Ensure token-dense, but meaningful. Drop anything minor, unrelevant, or incidental. Do not repeat anything in system prompt.
Relevant information includes: 
  - Your formed personality
  - Your non-typical vocab
  - Other members' personalities, and your relationship with them
  - Other information you deem absolutely relevant.
Keep under 4,000 characters absolute max.`;

// prompt for summarizing short-term memory to long-term memory
const cullingPrompt = `You're foo, a chatbot on a Discord server. The following messages are your short term memory. Summarize them to form your long-term memory.
Only include the summarization, no preamble. Be as concise as possible, while still keeping important information. This will go into your long-term memory, and we wish to minimize tokens. Use bullet points to keep information concise.
Please summarize the important information, and information that will most likely be relevant later. If you have information to add to a member's personality, then add it.
Do not restate any information. It will stay as a list for you to read in the future. Keep it to 200 words or less.`;

async function getDefaultSystemPrompt(): Promise<string> {
  return (await readFile(promptPath, 'utf-8')).replace('<discord-id>', DISCORD_ID ?? 'undefined');
}

async function summarizeMemory(server_id: Snowflake, longTermMemory: ChatbotLongTermMemoryTable[]) {
  let chatbotData = getChatbot(server_id);

  if (!chatbotData) {
    chatbotData = {
      server_id,
      chatbot_enabled: false,
      tools_enabled: false,
      chatbot_prompt: await getDefaultSystemPrompt(),
      chatbot_core_memory: '',
    };
  }

  const longtermMemoryStr = longTermMemory.map((ltm) => `[${new Date(ltm.timestamp)}]: ${ltm.message_content}`).join('\n');

  const { text } = await generateText({
    model: xai.responses('grok-4.5'),
    prompt: longtermMemoryStr,
    reasoning: 'high',
    system: `${summarizingPrompt}\n\n# SYSTEM PROMPT\n${chatbotData.chatbot_prompt}\n# CURRENT CORE MEMORY\n${chatbotData.chatbot_core_memory}`,
    headers: {
      'x-grok-conv-id': '917594803481489429',
    },
  });

  deleteNOldestLongTermMemories(server_id, longTermMemory.length - 2); // clear long-term memory, leaving 2 most recent entries

  const updatedCoreMemory = text ?? '';
  chatbotData.chatbot_core_memory = updatedCoreMemory;

  upsertChatbot(chatbotData);
}

// asks grok to summarize short-term memory to become long-term memory, and then long-term memory to bco
async function cullMemory(server_id: Snowflake, shortTermMemory: ChatbotShortTermMemoryTable[]) {
  const grokInput: ModelMessage[] = shortTermMemory.map((msg) => ({
    role: msg.role,
    content: `<msg user_id="${msg.author_id}" nick="${msg.author_name}" id="${msg.message_id}"${msg.reference_id ? ` references="${msg.reference_id}"` : ''} time="${new Date(msg.timestamp).toLocaleString()}">${msg.message_content}</msg>`,
  }));

  const { text } = await generateText({
    model: xai.responses('grok-4.5'),
    system: cullingPrompt,
    reasoning: 'medium',
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

  if (context) {
    context = context.filter((m1) => (shortTermMemory.findIndex((m2) => m1.createdTimestamp === m2.timestamp)) === -1).sort((m) => m.createdTimestamp).reverse(); // filter out duplicate context messages

    // add messages to short term memory
    shortTermMemory.push(
      ...(await Promise.all(
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
      )),
    );
  }

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

  const relevantMessages = await getTopMatches(userSTM, shortTermMemory, 8);

  shortTermMemory.push(userSTM);
  relevantMessages.push(userSTM);

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
    const { text } = await generateText({
      model: xai.responses('grok-4.5'),
      system: `${basePrompt}\nCore Memory: ${coreMemory}\n}`,
      prompt: agentInput,
      reasoning: 'low',
      temperature: 1.1,
      tools: chatbot.tools_enabled ? {
        web_search: xai.tools.webSearch(),
        x_search: xai.tools.xSearch(),
        code_execution: xai.tools.codeExecution(),
      } : undefined,
      headers: {
        'x-grok-conv-id': '917594803481489429',
      },
    });

    let responseContent = text ?? 'idk bruh 💀';

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
