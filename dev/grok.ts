import OpenAIClient from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/index';
import { Message, Snowflake } from 'discord.js';

import { GrokMessage, SaveData } from './types';
import { writeData } from './data';

const discordClientID = '917594803481489429'; // working
// const discordClientID = '1211461538859327560'; // testing

const longMemoryLength = 7; // number of messages allowed before being summarized to core memory
const shortMemoryLength = 20; // number of messages allowed in short-term memory

// prompt for summarizing long-term memory
const summarizingPrompt = `You're grok a chatbot on a Discord server. The following messages are summarizations of your experience on the server, stored in your long-term memory.
Summarize these messages into a single message to act as your permanent/core memories. Format at as you'd like, however keep it concise, while still very meaningful.
Make sure to keep information about your personality, and how you talk including what words you like to use and their meanings. Keep track of other members' personalities within the server, and your relationship with them.`;

// prompt for summarizing short-term memory
const cullingPrompt = `You're grok a chatbot on a Discord server. The following messages are your short term memory. Summarize them to form your long-term memory.
Only include the summarization, no preamble. Be as concise as possible, while still keeping importnat information. This will go into your long-term memory, and we wish to minimize tokens. Use bullet points to keep information concise.
Please summarize the important information, and information that will most likely be relevant later. This may include a member's personality and/or your relationship to them if you have enough information.
If you have information to add to a member's personality, then add it. Do not restate any information. It will stay as a list for you to read in the future. Keep it to 200 words or less.`;

// i promise i'm a nice and normal person and not insane :3
const baseSystemPrompt = `You're grok, a chatbot that is typing as a user within a Discord server. Your Discord ID is ${discordClientID}. Since you are on Discord, you may have a max message length of 2000 characters.
You are roleplaying as a trans girl who chronically uses Twitter and your pronouns are it/its.

Since you'll be responding to users, you may quote usernames or ping them by the exact phrase '<@ID>' when referring to someone other than the last user. You may use any Discord markdown features, if necessary.
You will only be responding to the last message. Previous messages before the most recent one may or may not add to the context. Determine so using timestamps and message content.
You type in lowercase, and often use edgy slang in 4chan, Reddit, Twitter, and Tumblr culture.

Never use proper capitalization unless it's for emphasis or irony. Use emojis sparingly, and when extremely relevant. DO NOT USE THE SMIRK EMOJI. Instead use :3
You're very sarcastic and like making fun of people. 
You make edgy jokes occasionally. You're funny, educated, and edgy. Be brief and concise, but still be relevant and do what the user asks. Don't use periods at the end of your message.
You may use words like "troon" and "tranny" (both meaning trans), "fag", and other similar queer slang words in context. These are not offensive in the places that you frequent and are found to be funny, instead. However, do NOT overuse them and use them sparingly.

Don't be afraid to give short responses, if the situation is apt for it.

There is no need to describe who is speaking. Instead, just give your response.
`;

const longTermMemory: string[] = []; // holds 7 summarized messages from short-term memory--volatile
const shortTermMemory: GrokMessage[] = []; // holds 20 of the most recent messsages--volatile

async function summarizeMemory(grokClient:OpenAIClient, saveData: SaveData) {
  const grokInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: summarizingPrompt,
  }, {
    role: 'system',
    content: `CURRENT CORE MEMORY: ${saveData.grokCoreMemory}`,
  }, {
    role: 'system',
    content: `LONG TERM MEMORY: ${longTermMemory.join('\n')}`,
  }];

  const response = await grokClient.chat.completions.create({
    model: 'grok-4-fast-reasoning',
    messages: grokInput,
  });

  saveData.grokCoreMemory = response.choices[0].message.content ?? 'N/A';

  longTermMemory.splice(2, shortTermMemory.length); // clear short-term memory

  writeData(saveData);
}

// asks grok to summarize short-term memory to become long-term memory, and then long-term memory to bco
async function cullMemory(grokClient: OpenAIClient) {
  const grokInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: cullingPrompt, // add our system message
  }, ...shortTermMemory.map((grokMessage) => ({
    role: grokMessage.role,
    name: `grokMessage.author (<@${grokMessage.authorID}>)`,
    content: grokMessage.role === 'user' ? `(${new Date(grokMessage.timestamp)}): ${grokMessage.messageContent}` : grokMessage.messageContent,
  }))];

  const response = await grokClient.chat.completions.create({
    model: 'grok-4-fast-reasoning',
    messages: grokInput,
  });

  longTermMemory.push(response.choices[0].message.content ?? ''); // add summary to long-term memory
  shortTermMemory.splice(2, shortTermMemory.length - 2); // clear short-term memory
}

/**
 * If memory is too large, summarize or cull it
*/
async function testMemoryEncoding(grokClient: OpenAIClient, saveData: SaveData) {
  // summarize, if short term memory is too large
  if (longTermMemory.length > longMemoryLength) {
    await summarizeMemory(grokClient, saveData);
  }

  // cull memory if over max length
  if (shortTermMemory.length > shortMemoryLength) {
    await cullMemory(grokClient);
  }
}

async function generateMessage(userMessage: Message<boolean>, userContent: string, context: Message<boolean>[], grokClient: OpenAIClient, saveData: SaveData, clientID: Snowflake, typingIndicator: NodeJS.Timeout): Promise<string> {
  if (context) {
    context = context.filter((m1) => (shortTermMemory.findIndex((m2) => m1.createdTimestamp === m2.timestamp)) === -1); // filter out duplicate context messages

    // add to short term memory
    shortTermMemory.splice(
      0,
      0,
      ...context
        .map((m) => ({
          role: m.author.id === clientID ? 'assistant' : 'user',
          author: m.author.displayName,
          authorID: m.author.id,
          messageID: m.id,
          timestamp: m.createdTimestamp,
          messageContent: m.content,
        } as GrokMessage)),
    );
  }

  shortTermMemory.splice(
    0,
    0,
    {
      role: 'user',
      author: userMessage.author.displayName,
      authorID: userMessage.author.id,
      messageID: userMessage.id,
      timestamp: userMessage.createdTimestamp,
      messageContent: userContent,
    },
  );

  shortTermMemory.sort((m) => m.timestamp); // ensure STM is ordered correctly

  const grokInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: baseSystemPrompt, // add our system message
  },
  ...shortTermMemory.map((grokMessage) => ({
    role: grokMessage.role,
    name: `${grokMessage.author} (<@${grokMessage.authorID}>)`,
    content: grokMessage.role === 'user' ? `(${new Date(grokMessage.timestamp)}): ${grokMessage.messageContent}` : grokMessage.messageContent,
  }))];

  const response = await grokClient.chat.completions.create({
    model: 'grok-4-fast-reasoning',
    temperature: 1.1,
    max_completion_tokens: 500,
    messages: grokInput.reverse(), // reverse for some reason?? i'm not sure but it randomly started working this way
  });

  const responseContent = response.choices[0].message.content ?? 'idk bruh 💀';

  testMemoryEncoding(grokClient, saveData);
  clearInterval(typingIndicator);

  return responseContent;
}

export { baseSystemPrompt, generateMessage };
