import path from 'node:path';
import { Client, Message, Snowflake } from 'discord.js';
import { generateText, ModelMessage } from 'ai';
import { xai } from '@ai-sdk/xai';

import { readFile } from 'fs/promises';

import { deleteNOldestLongTermMemories, deleteNOldestShortTermMemory, getChatbot, getChatbotLongTermMemoriesByServer, getChatbotShortTermMemoriesByServer, insertChatbotLongTermMemory, insertChatbotShortTermMemory, upsertChatbot } from './data';
import { ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable } from './types/schema';

const promptPath = path.join(__dirname, '../data/SYSTEM.md');
const { DISCORD_ID } = process.env;

const longMemoryLength = 5; // number of messages allowed before being summarized to core memory
const shortMemoryLength = 30; // number of messages allowed in short-term memory

// prompt for summarizing long-term memory
const summarizingPrompt = `You're foo, a chatbot on a Discord server. The following messages are summarizations of your experience on the server, stored in your long-term memory.
Summarize these messages into a single message to act as your permanent/core memories. Format at as you'd like, however keep it concise, while still very meaningful.
Make sure to keep information about your personality, and how you talk including what words you like to use and their meanings. Keep track of other members' personalities within the server, and your relationship with them.`;

// prompt for summarizing short-term memory
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
      chatbot_prompt: await getDefaultSystemPrompt(),
      chatbot_core_memory: '',
    };
  }

  const longtermMemoryStr = longTermMemory.map((ltm) => `[${new Date(ltm.timestamp)}]: ${ltm.message_content}`).join('\n');

  const { text } = await generateText({
    model: xai.responses('grok-4.6'),
    prompt: longtermMemoryStr,
    system: `${summarizingPrompt}\n\n# PERSONALITY\n${chatbotData.chatbot_prompt}\n# CURRENT CORE MEMORY\n${chatbotData.chatbot_core_memory}`,
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
    model: xai.responses('grok-4.6'),
    system: cullingPrompt,
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
      ...context
        .map((m) => ({
          role: m.author.id === discordClient.user!.id ? 'assistant' : 'user',
          author_name: m.author.displayName,
          author_id: m.author.id,
          message_id: m.id,
          message_content: m.content,
          timestamp: m.createdTimestamp,
        } as ChatbotShortTermMemoryTable)),
    );
  }

  if (messageReference) {
    if (!shortTermMemory.find((stm) => messageReference.id === stm.message_id)) {
      // add referenced message to beginning to local STM array for reference
      shortTermMemory.unshift({
        role: messageReference.author.id === discordClient.user?.id ? 'assistant' : 'user',
        server_id: serverID,
        timestamp: messageReference.createdTimestamp,

        author_id: messageReference.author.id,
        author_name: messageReference.author.displayName,

        message_content: messageReference.content,
        message_id: messageReference.id,
      });
    }
  }

  // add most recent message to end
  shortTermMemory.push({
    server_id: serverID,
    role: 'user',
    author_name: userMessage.author.displayName,
    author_id: userMessage.author.id,
    message_id: userMessage.id,
    reference_id: messageReference?.id ?? undefined,
    timestamp: userMessage.createdTimestamp,
    message_content: userContent,
  });

  const agentInput: ModelMessage[] = [
    // Rest of messages at end, reformatted
    ...shortTermMemory.map((msg) => ({
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
      reasoning: 'medium',
      temperature: 1.2,
      tools: {
        web_search: xai.tools.webSearch(),
        x_search: xai.tools.xSearch(),
        code_execution: xai.tools.codeExecution(),
        // view_image: xai.tools.viewImage(),
      },
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
