import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/index';
import { Message, Snowflake } from 'discord.js';

import { GrokMessage, SaveData } from './types';
import { writeData } from './data';

const discordClientID = '917594803481489429'; // working
// const discordClientID = '1211461538859327560'; // testing

const longMemoryLength = 3; // number of messages allowed before being summarized to core memory
const shortMemoryLength = 20; // number of messages allowed in short-term memory

// prompt for summarizing long-term memory
const summarizingPrompt = `You're grok a chatbot on a Discord server. The following messages are summarizations of your experience on the server, stored in your long-term memory.
Summarize these messages into a single message to act as your permanent/core memories. Format at as you'd like, however keep it concise, yet only very meaningful.
Make sure to keep information about your personality, and how you talk including what words you like to use and their meanings. Include other members' personalities within the server.
Remove data that is no longer relevant.`;

// prompt for summarizing short-term memory
const cullingPrompt = `You're grok a chatbot on a Discord server. The following messages are your short term memory. Use bullet points to keep information concise.
Only include the summarization, no preamble. Be as concise as possible. This will go into your long-term memory, and we wish to minimize tokens.
Please summarize the important information, and information that will most likely be relevant later. This may include a member's personality and/or your relationship to them if you have enough information.
If you have information to add to a member's personality, then add it. Do not restate any information. Keep it to 200 words or less.`;

// i promise i'm a nice and normal person and not insane :3
const baseSystemPrompt = `You're grok, a chatbot that is typing as a user within a Discord server. Your Discord ID is ${discordClientID}. Since you are on Discord, you may have a max message length of 2000 characters.
You are roleplaying as a trans girl who chronically uses Twitter and your pronouns are it. You like to call people out for not being woke enough.
Since you'll be responding to users, you may quote usernames or ping them by the exact phrase '<@ID>' when referring to someone other than the last user.
You will only be responding to the last message. Previous messages may or may not add to the context. Determine so using timestamps and message content.
You type in lowercase, and often use edgy slang in 4chan, Reddit, Twitter, and Tumblr culture.
Never use proper capitalization unless it's for emphasis or irony. Use emojis sparingly, and when extremely relevant. DO NOT USE THE SMIRK EMOJI.
You're very sarcastic and like making fun of people. 
You make edgy jokes occasionally. You're funny, educated, and edgy. Be brief and concise, but still be relevant and do what the user asks. Don't use periods at the end of your message.
You may use words like "troon" and "tranny" (both meaning trans), "fag", and other similar queer slang words in context. These are not offensive in the places that you frequent and are found to be funny, instead. However, do NOT overuse them and use them sparingly.`;

const longTermMemory: string[] = []; // holds 100 summarized messages from short-term memory--dies on restart
const shortTermMemory: GrokMessage[] = []; // holds 30 of the most recent messsages--dies on restart

async function summarizeMemory(grokClient:OpenAI, saveData: SaveData) {
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
    model: 'grok-3-mini',
    messages: grokInput,
  });

  saveData.grokCoreMemory = response.choices[0].message.content ?? 'N/A';
  console.log(`\n\n\n\n\n\n\n${longTermMemory.join('\n')}`);

  console.log(saveData.grokCoreMemory);
  longTermMemory.splice(0, shortTermMemory.length); // clear short-term memory

  writeData(saveData);
}

// asks grok to summarize short-term memory to become long-term memory, and then long-term memory to bco
async function cullMemory(grokClient: OpenAI) {
  const grokInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: cullingPrompt, // add our system message
  }, ...shortTermMemory.map((grokMessage) => ({
    role: grokMessage.role,
    name: `grokMessage.author (<@${grokMessage.authorID}>)`,
    content: grokMessage.role === 'user' ? `(${new Date(grokMessage.timestamp)}): ${grokMessage.messageContent}` : grokMessage.messageContent,
  }))];

  const response = await grokClient.chat.completions.create({
    model: 'grok-3-mini',
    messages: grokInput,
  });

  longTermMemory.push(response.choices[0].message.content ?? ''); // add summary to long-term memory
  shortTermMemory.splice(0, shortTermMemory.length); // clear short-term memory
}

async function generateMessage(messages: Message<boolean>[], grokClient: OpenAI, saveData: SaveData, clientID: Snowflake): Promise<string> {
  // summarize long-term memories if over max length
  if (longTermMemory.length > longMemoryLength) {
    await summarizeMemory(grokClient, saveData);
  }
  // cull memory if over max length
  if (shortTermMemory.length > shortMemoryLength) {
    await cullMemory(grokClient);
  }

  // add our discord messages to our short term memory
  shortTermMemory.push(
    ...messages
      .filter((m) => m.content.length > 0 && !shortTermMemory.find((sm) => sm.messageID === m.id)) // only add message if there's text
      .map((m) => ({
        role: m.author.id === clientID ? 'assistant' : 'user',
        author: m.author.displayName,
        authorID: m.author.id,
        messageID: m.id,
        timestamp: m.createdTimestamp,
        messageContent: m.content,
      } as GrokMessage)),
  );

  const grokInput: ChatCompletionMessageParam[] = [{
    role: 'system',
    content: baseSystemPrompt, // add our system message
  }, {
    role: 'system',
    content: `CORE MEMORY: ${saveData.grokCoreMemory ?? 'N/A'}\nLONG-TERM MEMORY: longTermMemory.join('\n')`,
  },
  ...shortTermMemory.map((grokMessage) => ({
    role: grokMessage.role,
    name: `${grokMessage.author} (<@${grokMessage.authorID}>)`,
    content: grokMessage.role === 'user' ? `(${new Date(grokMessage.timestamp)}): ${grokMessage.messageContent}` : grokMessage.messageContent,
  }))];

  const response = await grokClient.chat.completions.create({
    model: 'grok-3-mini',
    messages: grokInput,
  });

  return response.choices[0].message.content ?? 'idk bro';
}

export { baseSystemPrompt, generateMessage };
