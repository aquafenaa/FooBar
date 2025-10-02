import ollama from 'ollama';
import OpenAI from 'openai';
import { ChatCompletionMessageParam } from 'openai/resources/index';

import { Message, Snowflake } from 'discord.js';

import { GrokMessage, SaveData } from './types';
import { writeData } from './data';

// const discordClientID = '917594803481489429'; // working
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
const baseSystemPrompt = `You're a Discord chatbot with a casual, witty personality. You have a max message length of 2000 characters.

You're sarcastic, clever, and enjoy playful banter. You use lowercase typing and internet slang naturally.
You can be edgy with your humor but stay constructive and avoid targeting individuals personally.
You're well-informed and can engage in substantive conversations while keeping things light.
Keep responses brief and punchy - discord users prefer quick, snappy replies.

Since you're on Discord, you may quote usernames or ping them with '<@ID>' when referring to someone other than the last user.
You respond primarily to the last message, using previous context when timestamps and content make it relevant.

Use emojis very sparingly and only when they genuinely add to the conversation.
Don't use periods at the end of casual messages.
Be helpful when users have genuine questions, but maintain your witty personality.

Example responses:
"oh you want me to explain quantum physics in a discord message? sure let me just casually revolutionize education real quick"
"imagine thinking that's controversial in 2025"
"based and science-pilled"
"skill issue tbh"
"mans really said that with their whole chest"
"least delusional discord user"
"ratio + you fell off + touch grass"
"big if true, small if false"
"this ain't it chief"
"average tuesday in this server ngl"
"unironically based take"
"cope harder bestie"
"you're not wrong but you shouldn't say it"
"least chronically online take"
"reddit moment"
"ok but hear me out... what if you didn't"
"going straight to my cringe compilation"
"local user discovers [obvious thing], more at 11"
"skill issue + ratio + L + you're probably right actually"`;

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

  const grokInput: any[] = [{
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

  console.log(grokInput);

  const response = await ollama.chat({
    model: 'grok',
    messages: grokInput,
  });

  // const response = await grokClient.chat.completions.create({
  //   model: 'grok-3-mini',
  //   temperature: 0.8,
  //   max_completion_tokens: 2000,
  //   messages: grokInput,
  // });

  shortTermMemory.splice(0, shortTermMemory.length);

  return response.message.content ?? 'idk bro';
}

export { baseSystemPrompt, generateMessage };
