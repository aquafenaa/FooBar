import OpenAIClient from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/index';
import { Client, Message, Snowflake } from 'discord.js';

import { deleteNOldestLongTermMemories, deleteNOldestShortTermMemory, getChatbot, getChatbotLongTermMemoriesByServer, getChatbotShortTermMemoriesByServer, insertChatbotLongTermMemory, upsertChatbot } from './data';
import { ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable } from './types/schema';

const discordClientID = '917594803481489429'; // working
// const discordClientID = '1211461538859327560'; // testing

const longMemoryLength = 7; // number of messages allowed before being summarized to core memory
const shortMemoryLength = 30; // number of messages allowed in short-term memory

// prompt for summarizing long-term memory
const summarizingPrompt = `You're foo, a chatbot on a Discord server. The following messages are summarizations of your experience on the server, stored in your long-term memory.
Summarize these messages into a single message to act as your permanent/core memories. Format at as you'd like, however keep it concise, while still very meaningful.
Make sure to keep information about your personality, and how you talk including what words you like to use and their meanings. Keep track of other members' personalities within the server, and your relationship with them.`;

// prompt for summarizing short-term memory
const cullingPrompt = `You're foo, a chatbot on a Discord server. The following messages are your short term memory. Summarize them to form your long-term memory.
Only include the summarization, no preamble. Be as concise as possible, while still keeping importnat information. This will go into your long-term memory, and we wish to minimize tokens. Use bullet points to keep information concise.
Please summarize the important information, and information that will most likely be relevant later. This may include a member's personality and/or your relationship to them if you have enough information.
If you have information to add to a member's personality, then add it. Do not restate any information. It will stay as a list for you to read in the future. Keep it to 200 words or less.`;

// i promise i'm a nice and normal person and not insane :3
const baseSystemPrompt = `You're foo (or cok), a chatbot that is typing as a user within a Discord server. Your Discord ID is ${discordClientID}. Since you are on Discord, you may have a max message length of 2000 characters.
You are roleplaying as a trans girl who chronically uses Twitter and your pronouns are it/its.

Since you'll be responding to users, you may quote usernames or ping them by the exact phrase '<@ID>' when referring to someone other than the last user. You may use any Discord markdown features, if necessary.
You will only be responding to the last message. Previous messages before the most recent one may or may not add to the context. Determine so using timestamps and message content.
You type in lowercase, and often use edgy slang in 4chan, Reddit, Twitter, and Tumblr culture.

Never use proper capitalization unless it's for emphasis or irony. Use emojis sparingly, and when extremely relevant. DO NOT USE THE SMIRK EMOJI. Instead use :3
You're very sarcastic and like making fun of people. 
You make edgy jokes occasionally. You're funny, educated, and edgy. Be brief and concise, but still be relevant and do what the user asks. Don't use periods at the end of your message.
You may use words like "troon" and "tranny" (both meaning trans), "fag", and other similar queer slang words in context. These are not offensive in the places that you frequent and are found to be funny, instead. However, do NOT overuse them and use them sparingly.

Don't be afraid to give short responses, if the situation is apt for it.

There is no need to describe who is speaking. Instead, just give your response. Also make sure you end your reasoning with a new line, and surround it with "<think>", "</think>" parameters.
`;

async function summarizeMemory(agentClient:OpenAIClient, server_id: Snowflake, longTermMemory: ChatbotLongTermMemoryTable[]) {
  let chatbotData = getChatbot(server_id);

  if (!chatbotData) {
    chatbotData = {
      server_id,
      chatbot_enabled: false,
      chatbot_core_memory: '',
    };
  }

  const agentInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: summarizingPrompt,
  }, {
    role: 'system',
    content: `CURRENT CORE MEMORY: ${chatbotData.chatbot_core_memory}`,
  }, {
    role: 'system',
    content: `LONG TERM MEMORY: ${longTermMemory}`,
  }];

  const response = await agentClient.chat.completions.create({
    model: 'grok-4.3',
    messages: agentInput,
    reasoning_effort: 'high',
  });

  deleteNOldestLongTermMemories(server_id, longTermMemory.length - 2); // clear long-term memory, leaving 2 most recent entries

  const updatedCoreMemory = response.choices[0].message.content ?? '';
  chatbotData.chatbot_core_memory = updatedCoreMemory;

  upsertChatbot(chatbotData);
}

// asks grok to summarize short-term memory to become long-term memory, and then long-term memory to bco
async function cullMemory(agentClient: OpenAIClient, server_id: Snowflake, shortTermMemory: ChatbotShortTermMemoryTable[]) {
  const grokInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: cullingPrompt, // add our system message
  }, ...shortTermMemory.map((agentMessage) => ({
    role: agentMessage.role,
    name: `author: (<@${agentMessage.author_id}>)`,
    content: agentMessage.role === 'user' ? `(${new Date(agentMessage.timestamp)}): ${agentMessage.message_content}` : agentMessage.message_content,
  }))];

  const summaryResponse = await agentClient.chat.completions.create({
    model: 'grok-4.3',
    messages: grokInput,
    reasoning_effort: 'high',
  });
  const newLongTermMemory: Omit<ChatbotLongTermMemoryTable, 'memory_id'> = {
    server_id,
    message_content: summaryResponse.choices[0].message.content ?? '',
    timestamp: Date.now() / 1000, // divide by 1000 to convert to Discord time format
  };

  deleteNOldestShortTermMemory(server_id, shortTermMemory.length - 2); // clear short-term memory
  insertChatbotLongTermMemory(newLongTermMemory); // add summary to long-term memory
}

/**
 * If memory is too large, summarize or cull it
*/
async function testMemoryEncoding(agentClient: OpenAIClient, server_id: Snowflake, longTermMemory: ChatbotLongTermMemoryTable[], shortTermMemory: ChatbotShortTermMemoryTable[]) {
  // summarize, if short term memory is too large
  if (longTermMemory.length > longMemoryLength) {
    await summarizeMemory(agentClient, server_id, longTermMemory);
  }

  // cull memory if over max length
  if (shortTermMemory.length > shortMemoryLength) {
    await cullMemory(agentClient, server_id, shortTermMemory);
  }
}

async function generateMessage(agentClient: OpenAIClient, discordClient: Client<boolean>, serverID: Snowflake, typingIndicator: NodeJS.Timeout, userMessage: Message<boolean>, userContent: string, context: Message<boolean>[]): Promise<string> {
  const longTermMemory = getChatbotLongTermMemoriesByServer(serverID);
  const shortTermMemory = getChatbotShortTermMemoriesByServer(serverID);

  if (context) {
    context = context.filter((m1) => (shortTermMemory.findIndex((m2) => m1.createdTimestamp === m2.timestamp)) === -1); // filter out duplicate context messages

    // add to short term memory
    shortTermMemory.splice(
      0,
      0,
      ...context
        .map((m) => ({
          role: m.author.id === discordClient.user!.id ? 'assistant' : 'user',
          // author: m.author.displayName,
          author_id: m.author.id,
          message_id: m.id,
          message_content: m.content,
          timestamp: m.createdTimestamp,
        } as ChatbotShortTermMemoryTable)),
    );
  }

  shortTermMemory.splice(
    0,
    0,
    {
      server_id: serverID,
      role: 'user',
      author_id: userMessage.author.id,
      message_id: userMessage.id,
      timestamp: userMessage.createdTimestamp,
      message_content: userContent,
    },
  );

  shortTermMemory.sort((m) => m.timestamp); // ensure STM is ordered correctly

  const agentInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: baseSystemPrompt, // add our system message
  },
  ...shortTermMemory.map((agentMessage) => ({
    role: agentMessage.role,
    name: `${discordClient.users.fetch(agentMessage.author_id).then((user) => user.displayName)} (<@${agentMessage.author_id}>)`,
    content: agentMessage.role === 'user' ? `(${new Date(agentMessage.timestamp)}): ${agentMessage.message_content}` : agentMessage.message_content,
  }))];

  try {
    const response = await agentClient.chat.completions.create({
      model: 'grok-4.3',
      reasoning_effort: 'low',
      messages: agentInput.reverse(), // reverse for some reason?? i'm not sure but it randomly started working this way
    });

    let responseContent = response.choices[0].message.content ?? 'idk bruh 💀';
    const thinkStartIndex = responseContent.indexOf('<think>');
    if (thinkStartIndex !== -1) {
      const thinkEndIndex = responseContent.indexOf('</think>') + '</think>'.length;
      responseContent = responseContent.substring(0, thinkStartIndex) + responseContent.substring(thinkEndIndex);
    }

    testMemoryEncoding(agentClient, serverID, longTermMemory, shortTermMemory);
    clearInterval(typingIndicator);

    return responseContent;
  } catch {
    clearInterval(typingIndicator);
    return '';
  }
}

export { baseSystemPrompt, generateMessage };
