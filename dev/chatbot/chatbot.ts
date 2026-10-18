import path from 'node:path';
import { Guild, GuildChannel, Message, SendableChannels, Snowflake } from 'discord.js';
import { ModelMessage, Tool } from 'ai';
import cron from 'node-cron';
import { z as zod } from 'zod';
import { Anthropic } from '@anthropic-ai/sdk';

import { MessageParam, OutputConfig, ToolResultBlockParam, ToolUnion, ToolUseBlock } from '@anthropic-ai/sdk/resources';

import { existsSync, readFileSync } from 'fs';

import { getChatbot, getConversationByChannel, getConversationMessages, getConversationTokenCount, getConversationToolResults, getIndexChannel, getIndexMessage, getIndexRole, getIndexUser, getNextChannelRef, getNextMessageRef, getNextRoleRef, getNextUserRef, insertConversationMessage, insertConversationToolResult, insertIndexChannel, insertIndexMessage, insertIndexRole, insertIndexUser, resolveChannelRef, resolveRoleRef, resolveUserRef, upsertConversation } from '../data';
import { ChatbotTable, ConversationMessageTable, ConversationTable, ConversationToolResultTable } from '../types/schema';
import { estimateTokens, millisToCronSchedule, safeFetch, splitPoint, trackFence } from '../utils';
import { anthropicClient, discordClient, openAIClient } from '..';
import { endConversation, getRelevantSummaries, summarizeConversation } from './conversation';
import localTools from './tools';
import { getVisibleMemories, isShareable } from './context';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, supportsTools } from './models';

const promptPath = path.join(__dirname, '../../data/SYSTEM.md'); // two levels up: this file is in dev/chatbot/ (src/chatbot/ once built)
const { DISCORD_ID } = process.env;

const MAX_MESSAGE_LENGTH = 2000;
const PADDING_LENGTH = 8;
const ALLOWED_QUANTIZATIONS = ['fp8', 'fp16', 'bf16', 'fp32'];
const MAX_TOOL_STEPS = 5; // number of model calls allowed per reply, when it keeps asking for tools
const DELETED_MEMORY_DURATION = 10 * 60_000; // 10 minutes, far longer than a reply takes to generate
const MAX_PROMPT_TOOL_RESULTS = 10; // most recent tool results given back to the model each reply
const MAX_PROMPT_TOOL_RESULT_LENGTH = 4000; // characters of each one. the full result stays in the database
const MAX_CONVERSATION_TOKENS = 10_000; // ~125 messages. past this, the conversation is summarized and a new one starts

// messages deleted recently, so a reply that's still generating doesn't save them afterwards
const recentlyDeleted = new Set<string>();
function markMessageDeleted(message_id: string): void {
  recentlyDeleted.add(message_id);
  setTimeout(() => recentlyDeleted.delete(message_id), DELETED_MEMORY_DURATION).unref(); // unref, so it never holds up shutdown
}

// converts one of our AI SDK tools into the shape the Anthropic SDK expects
function toAnthropicTool(name: string, localTool: Tool<any, any>): Anthropic.Tool {
  // the Anthropic format has no field for examples, so they're added to the end of the description
  const examples = (localTool.inputExamples ?? []).map((example) => JSON.stringify(example.input)).join('\n');
  const description = typeof localTool.description === 'string' ? localTool.description : '';

  return {
    name,
    description: (examples ? `${description}\n\nExample inputs:\n${examples}` : description) || undefined,
    input_schema: zod.toJSONSchema(localTool.inputSchema as unknown as zod.ZodType) as Anthropic.Tool.InputSchema,
  };
}

/**
 * The base system prompt, from SYSTEM.md. Read fresh each time, so edits apply without a restart.
 * SYSTEM.md is gitignored, so a fresh clone won't have one. That's fine, it just means no base prompt
 */
function getBaseSystemPrompt(): string {
  if (!existsSync(promptPath)) return '';
  return readFileSync(promptPath, 'utf-8').replace('<discord-id>', DISCORD_ID ?? 'undefined');
}
async function getDefaultSystemPrompt(): Promise<string> {
  return getBaseSystemPrompt();
}
// the server's override if it has one, otherwise SYSTEM.md
function getSystemPrompt(chatbot: ChatbotTable): string {
  return chatbot.system_prompt_override || getBaseSystemPrompt();
}

async function getEmbedding(text: string): Promise<number[]> {
  const embedding = await openAIClient.embeddings.create({
    model: 'text-embedding-3-small',
    input: text,
    encoding_format: 'float',
  });

  return embedding.data[0].embedding;
}

/**
 * Given short term memories, return a formatted chatbot input
 * Resolves user, channel, and role mentions.
*/
async function formatInput(guild: Guild, currentChannel: SendableChannels, conversation: ConversationTable, referenceMessage: ConversationMessageTable | undefined, toolList: ConversationToolResultTable[], convoContext: ConversationMessageTable[]): Promise<ModelMessage[]> {
  if (!convoContext) return [];

  const MENTION_RE = /<(?:@!?(\d{17,20})|#(\d{17,20})|@&(\d{17,20}))>/g; // 3 capture groups for users, channels, & role mentions respectively
  const esc = (s: unknown) => String(s ?? '').replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

  // e.g. no permission to read pins in this channel. not worth failing the reply over
  const pinnedMessages = (await safeFetch(() => currentChannel.messages.fetchPins()))?.items ?? [];
  // the referenced message too, so its author and anyone it mentions are known, even when it's from outside the context
  const allMessages = referenceMessage ? [referenceMessage, ...convoContext] : convoContext;
  const mentionedUserIDs: Snowflake[] = allMessages.map((m) => m.author_id);
  const mentionedChannelIDs: Snowflake[] = [];
  const mentionedRoleIDs: Snowflake[] = [];

  // get all references from each message
  allMessages.forEach((msg) => {
    for (const m of msg.message_content.matchAll(MENTION_RE)) {
      const [, userId, channelId, roleId] = m; // exactly one of the three is defined
      if (userId) mentionedUserIDs.push(userId);
      if (channelId) mentionedChannelIDs.push(channelId);
      if (roleId) mentionedRoleIDs.push(roleId);
    }
  });

  // resolve mentionables in guild from IDs
  const mentionedUsers = Array.from((await Promise.all([...new Set(mentionedUserIDs)].map((user) => safeFetch(() => guild.members.fetch(user))))).filter((m) => m !== undefined && m !== null).values());
  let mentionedChannels = Array.from((await Promise.all([...new Set(mentionedChannelIDs)].map((channel) => safeFetch(() => guild.channels.fetch(channel))))).filter((m) => m !== undefined && m !== null).values()) as GuildChannel[];
  const mentionedRoles = Array.from((await Promise.all([...new Set(mentionedRoleIDs)].map((role) => safeFetch(() => guild.roles.fetch(role))))).filter((m) => m !== undefined && m !== null).values());

  const referenceMap = new Map<string, string>();

  // populate all references with their relevant symbols, and add to map
  mentionedUsers.map((user) => {
    let indexUser = getIndexUser(conversation.conversation_id, user.id);
    if (indexUser) {
      referenceMap.set(indexUser.user_id, indexUser.shorthand);
      return indexUser;
    }

    // if it doesn't exist, we must create it and insert it
    indexUser = {
      conversation_id: conversation.conversation_id,
      user_id: user.id,
      shorthand: `[@${getNextUserRef(conversation.conversation_id)}]`,
    };
    insertIndexUser(indexUser);
    referenceMap.set(indexUser.user_id, indexUser.shorthand);

    return indexUser;
  });
  mentionedChannels.map((channel) => {
    let indexChannel = getIndexChannel(conversation.conversation_id, channel.id);
    if (indexChannel) {
      referenceMap.set(indexChannel.channel_id, indexChannel.shorthand);
      return indexChannel;
    }

    // if it doesn't exist, we must create it and insert it
    indexChannel = {
      conversation_id: conversation.conversation_id,
      channel_id: channel.id,
      shorthand: `[#${getNextChannelRef(conversation.conversation_id)}]`,
    };
    insertIndexChannel(indexChannel);
    referenceMap.set(indexChannel.channel_id, indexChannel.shorthand);

    return indexChannel;
  });
  mentionedRoles.map((role) => {
    let indexRole = getIndexRole(conversation.conversation_id, role.id);
    if (indexRole) {
      referenceMap.set(indexRole.role_id, indexRole.shorthand);
      return indexRole;
    }

    // if it doesn't exist, we must create it and insert it
    indexRole = {
      conversation_id: conversation.conversation_id,
      role_id: role.id,
      shorthand: `[&${getNextRoleRef(conversation.conversation_id)}]`,
    };
    insertIndexRole(indexRole);
    referenceMap.set(indexRole.role_id, indexRole.shorthand);

    return indexRole;
  });
  convoContext.map((message) => {
    let indexMessage = getIndexMessage(conversation.conversation_id, message.message_id);
    if (indexMessage) {
      referenceMap.set(indexMessage.message_id, indexMessage.shorthand);
      return indexMessage;
    }

    // if it doesn't exist, we must create it and insert it
    indexMessage = {
      conversation_id: conversation.conversation_id,
      message_id: message.message_id,
      shorthand: `[$${getNextMessageRef(conversation.conversation_id)}]`,
    };
    insertIndexMessage(indexMessage);
    referenceMap.set(indexMessage.message_id, indexMessage.shorthand);

    return indexMessage;
  });

  // if there's a reference message, but not currently in the conversation's context, we must insert it to both the list and the map
  if (referenceMessage && !referenceMap.get(referenceMessage.message_id)) {
    referenceMap.set(referenceMessage.message_id, '[$0]');
    convoContext.unshift(referenceMessage);
  }

  // the current channel is always [#0], so drop it if it was also mentioned, or it'd be listed twice
  mentionedChannels = mentionedChannels.filter((channel) => channel.id !== currentChannel.id);
  mentionedChannels.unshift(currentChannel as GuildChannel);
  referenceMap.set(currentChannel.id, '[#0]');

  // replaces mentioned IDs with their shorter references. (saves a HUGE number of input tokens, since long numbers tokenize poorly)
  const stm = convoContext.map((msg) => ({
    ...msg,
    message_content: msg.message_content.replace(/^> -# .*(?:\r?\n|$)/gm, '').replace(MENTION_RE, (_, u, c, r) => referenceMap.get(u ?? c ?? r) ?? 'unknown'),
  }));

  // format the message to include message number, and reference message number
  const modelMessages: ModelMessage[] = stm.map((msg) => {
    const messageShorthand = referenceMap.get(msg.message_id) ?? '[$unknown]';

    return {
      role: msg.author_id === discordClient.user!.id ? 'assistant' : 'user',
      content: msg.author_id !== discordClient.user!.id // if not us
        ? `${messageShorthand} ${referenceMap.get(msg.reference_id ?? '') !== undefined ? `↪ ${referenceMap.get(msg.reference_id!)} ` : ''}${msg.author_name}: ${msg.message_content}`
        : `${messageShorthand} ${msg.message_content}`,
    };
  });

  const indexMsg: ModelMessage = {
    role: 'system',
    content:
    `<index>
    ${mentionedUsers.length === 0
    ? ''
    : `<users>
      ${mentionedUsers.map((user) => `<user id="${user.id}" name="${esc(user.user.displayName)}" nick="${esc(user.nickname ?? '')}" bot="${user.user.bot}" refID="${referenceMap.get(user.id)}" />`).join('\n\t')}
    </users>`}
    ${mentionedChannels.length === 0
    ? ''
    : `<channels>
      ${mentionedChannels.map((channel) => `<channel id="${channel.id}" name="${esc(channel.name ?? '')}" refID="${referenceMap.get(channel.id)}" />`).join('\n\t')}
    </channels>`}
    ${mentionedRoles.length === 0
    ? ''
    : `<roles>
      ${mentionedRoles.map((role) => `<role id="${role.id}" name="${esc(role.name)}" mentionable="${role.mentionable}" refID="${referenceMap.get(role.id)}" />`).join('\n\t')}
      </roles>`}
    ${toolList.length === 0 // past tool results go here, since the Anthropic API only accepts a tool result right after the call that made it
    ? ''
    : `<tool_results>
      ${toolList.map((tool) => `<tool_result name="${esc(tool.tool_name)}" time="${new Date(tool.timestamp).toLocaleString()}"${tool.output.length > MAX_PROMPT_TOOL_RESULT_LENGTH ? ' truncated="true"' : ''}>${esc(tool.output.substring(0, MAX_PROMPT_TOOL_RESULT_LENGTH))}</tool_result>`).join('\n\t')}
    </tool_results>`}
    ${pinnedMessages.length === 0
    ? ''
    : `<pinned_messages>
      ${pinnedMessages.map((msg) => `<msg authorID="${msg.message.author.id}">${esc(msg.message.content)}</msg>`).join('\n\t')}
    </pinned_messages>`}
    </index>`,
  };
  modelMessages.unshift(indexMsg);

  return modelMessages;
}

/**
 * Splits a finished LLM response into Discord-safe message chunks (<= 2000 chars),
 * preserving open code fences across the split.
*/
async function formatResponse(conversationID: string, agentResponse: string): Promise<string[]> {
  const chunks: string[] = [];
  let rest = agentResponse
    // turn user, channel, & role shorthands back into Discord mentions. unknown ones are left as written
    .replace(/\[@\d+\]/g, (ref) => { const id = resolveUserRef(conversationID, ref); return id ? `<@${id}>` : ref; })
    .replace(/\[#\d+\]/g, (ref) => { const id = resolveChannelRef(conversationID, ref); return id ? `<#${id}>` : ref; })
    .replace(/\[&\d+\]/g, (ref) => { const id = resolveRoleRef(conversationID, ref); return id ? `<@&${id}>` : ref; })
    .replace(/(?<!")\[\$\d+\]|\[\$\d+\](?!")/g, ''); // replace local message numbers from output
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

// wraps generateReply, so the typing indicator always stops and nothing goes unhandled, even if it fails or returns early
async function handleChatbotReply(serverID: Snowflake, typingIndicator: NodeJS.Timeout, userMessage: Message<boolean>, userContent: string, messageReference: Message<boolean> | undefined, context: Message<boolean>[]): Promise<void> {
  try {
    await generateReply(serverID, userMessage, userContent, messageReference, context);
  } catch (error) {
    console.error(error);
  } finally {
    clearInterval(typingIndicator);
  }
}

async function generateReply(serverID: Snowflake, userMessage: Message<boolean>, userContent: string, messageReference: Message<boolean> | undefined, context: Message<boolean>[]): Promise<void> {
  if (!userMessage?.channel.isSendable()) return;

  const chatbot = getChatbot(serverID)!;
  const guild = await discordClient.guilds.fetch(serverID)!;

  if (!userMessage.inGuild()) return;
  const messageChannel: GuildChannel = userMessage.channel as GuildChannel;
  if (!messageChannel.isSendable()) return;

  let conversation = getConversationByChannel(messageChannel.id);
  if (!conversation) { // if no active conversations, create a new one
    conversation = {
      conversation_id: `${messageChannel.id}${userMessage.id}`,
      channel_id: messageChannel.id,
      source_id: serverID,
      platform: 'discord',
      expires_at: Date.now() + 3_600_000, // expires in an hour
    };
  } else {
    conversation.expires_at = Date.now() + 3_600_000; // expires in an hour
    // delete any current archival task for this conversation
    cron.getTasks().forEach((task) => {
      if (task.name === conversation?.conversation_id) {
        task.destroy();
      }
    });
  }

  // save the conversation (or its new expiry), so its index and messages have something to reference
  upsertConversation(conversation);

  // schedule new archive task
  cron.schedule(millisToCronSchedule(conversation.expires_at)!, () => summarizeConversation(conversation.conversation_id), {
    name: conversation.conversation_id,
  });

  const conversationContext = getConversationMessages(conversation.conversation_id);
  const uniqueContext: ConversationMessageTable[] = context.filter((txt) => !conversationContext.find((convoTxt) => convoTxt.message_id === txt.id))
    .map((ctx) => ({
      conversation_id: conversation.conversation_id,
      message_id: ctx.id,
      // context includes the bot's own earlier replies. as 'user', they'd count as someone who hasn't opted in to sharing
      role: ctx.author.id === discordClient.user?.id ? 'assistant' : 'user',

      author_id: ctx.author.id,
      author_name: ctx.author.displayName,
      timestamp: ctx.createdTimestamp,

      reference_id: ctx.reference?.messageId ?? undefined,
      message_content: ctx.content,
      token_count: estimateTokens(ctx.content),
    }));
  const userConvoMessage: ConversationMessageTable = {
    conversation_id: conversation.conversation_id,
    role: 'user',
    author_name: userMessage.author.displayName,
    author_id: userMessage.author.id,
    message_id: userMessage.id,
    reference_id: messageReference?.id ?? undefined,
    timestamp: userMessage.createdTimestamp,
    message_content: userContent,
    token_count: estimateTokens(userContent),
  };

  conversationContext.push(...uniqueContext);
  conversationContext.push(userConvoMessage);

  // summaries are a nice-to-have, so a failed embedding call shouldn't stop the reply
  const relevantSummaries = await getRelevantSummaries(conversation, userConvoMessage).catch((error) => {
    console.error(error);
    return [];
  });

  // add the referenced message to beginning of context if it isn't already included
  let referenceMessage: ConversationMessageTable | undefined;

  if (messageReference) {
    if (!conversationContext.find((stm) => messageReference.id === stm.message_id)) {
      referenceMessage = {
        role: messageReference.author.id === discordClient.user?.id ? 'assistant' : 'user',
        conversation_id: conversation.conversation_id,
        timestamp: messageReference.createdTimestamp,
        author_id: messageReference.author.id,
        author_name: messageReference.author.displayName,
        message_content: messageReference.content,
        message_id: messageReference.id,
      };
    }
  }

  // sort by chronological order
  conversationContext.sort((msg1, msg2) => msg1.timestamp - msg2.timestamp);

  // only the latest results, so a long conversation's prompt doesn't keep growing. all of them are still kept for the summary
  const toolContext = getConversationToolResults(conversation.conversation_id).slice(-MAX_PROMPT_TOOL_RESULTS);
  const agentInput = await formatInput(guild, messageChannel, conversation, referenceMessage, toolContext, conversationContext);
  const indexMsg = agentInput.shift()!;
  const summaryStr = relevantSummaries.map((summary) => `<summary>${summary.summary}</summary>`).join('\n');
  const memories = getVisibleMemories(serverID);
  // given to every tool by the bot, never by the model
  const replyContext = {
    server_id: serverID,
    // memory tools only save to the shared context when everyone in this conversation has opted in
    shareable: isShareable(serverID, conversationContext.filter((msg) => msg.role === 'user').map((msg) => msg.author_id)),
    reference_message_id: messageReference?.id, // the message the user is replying to, shown to the model as [$0]
  };

  let status = '-# thinking...';
  const toolMessage = await messageChannel.send(status);

  // SYSTEM.md (or the server's override), with the server's persona layered on top
  const systemPrompt = `<system>
      ${getSystemPrompt(chatbot)}
    </system>
    ${chatbot.chatbot_prompt ? `<persona>
      ${chatbot.chatbot_prompt}
    </persona>` : ''}
    <relevant_summaries>
      ${summaryStr}
    </relevant_summaries>
    <memory_list>
      ${memories.map((memory) => memory.name).join('\n')}
    </memory_list>
    <conversation conversation_id="${conversation.conversation_id}" server_id="${serverID}" current_date="${new Date().toLocaleString('en-US', { dateStyle: 'full', timeStyle: 'long' })}" />
    <index>
      ${indexMsg.content}
    </index>`;

  const model = chatbot.model ?? DEFAULT_MODEL;
  // models without tool support get none, rather than an error
  const tools: ToolUnion[] | undefined = chatbot.tools_enabled && supportsTools(model) ? [
    {
      type: 'openrouter:web_search',
      parameters: { engine: 'native', max_results: 5 }, // "native" on Grok includes X search
    } as unknown as ToolUnion,
    {
      // runs commands in a sandbox on openrouter's side (python 3.11 and node 22 are installed), never on this machine.
      // a fresh container each reply. network is limited to package registries, so it can still pip/npm install
      type: 'openrouter:shell',
      parameters: {
        engine: 'openrouter',
        environment: {
          type: 'container_auto',
          network_policy: { type: 'allowlist', allowed_domains: ['*'] },
        },
      },
    } as unknown as ToolUnion,
    toAnthropicTool('react_to_message', localTools.reactToMessage),
    toAnthropicTool('create_reminder', localTools.createReminder),
    toAnthropicTool('edit_reminder', localTools.editReminder),
    toAnthropicTool('list_reminders', localTools.listReminders),
    toAnthropicTool('view_reminder', localTools.viewReminder),
    toAnthropicTool('remove_reminder', localTools.removeReminder),
    toAnthropicTool('create_memory', localTools.createMemory),
    toAnthropicTool('edit_memory', localTools.editMemory),
    toAnthropicTool('list_memories', localTools.listMemories),
    toAnthropicTool('view_memory', localTools.viewMemory),
    toAnthropicTool('remove_memory', localTools.removeMemory),
    toAnthropicTool('fetch_url', localTools.fetchURL),
    toAnthropicTool('counter', localTools.counter),
    // only offered once the key is in .env, so the model doesn't reach for a tool that can't work
    ...(process.env.TWITTER_API_KEY ? [toAnthropicTool('x_search', localTools.xSearch)] : []),
  ] : undefined;

  // tools we execute ourselves. web search runs on OpenRouter's side
  const localToolMap: Record<string, Tool<any, any>> = {
    react_to_message: localTools.reactToMessage,

    create_reminder: localTools.createReminder,
    edit_reminder: localTools.editReminder,
    list_reminders: localTools.listReminders,
    view_reminder: localTools.viewReminder,
    remove_reminder: localTools.removeReminder,

    create_memory: localTools.createMemory,
    edit_memory: localTools.editMemory,
    list_memories: localTools.listMemories,
    view_memory: localTools.viewMemory,
    remove_memory: localTools.removeMemory,

    fetch_url: localTools.fetchURL,
    counter: localTools.counter,
    x_search: localTools.xSearch,
  };

  const messages = agentInput as MessageParam[];
  let streamStr = '';
  const toolList: ConversationToolResultTable[] = [];

  try {
    // unlike streamText, the Anthropic SDK doesn't run tools for us, so loop until the model stops asking for them
    for (let step = 0; step < MAX_TOOL_STEPS; step++) {
      const stream = anthropicClient.messages.stream({
        model,
        temperature: 1.0,
        max_tokens: 0,
        system: systemPrompt,
        // openrouter quietly ignores efforts a model can't use. it also accepts 'none' and 'minimal', which the sdk's type doesn't list
        output_config: { effort: (chatbot.reasoning_effort ?? DEFAULT_REASONING_EFFORT) as OutputConfig['effort'] },
        messages,
        tools,
        // openrouter-only, so the sdk's type doesn't list it. skips providers serving heavily quantized (int4/int8/fp4/fp6) weights.
        // 'unknown' stays allowed, since closed models' providers (anthropic, xai, etc.) don't report a quantization
        provider: { quantizations: ALLOWED_QUANTIZATIONS },
      } as Parameters<typeof anthropicClient.messages.stream>[0]);

      let stepText = ''; // text from this round only, so a "let me check" before a tool call doesn't get posted alongside the real answer
      let afterToolUse = false; // server tools (web search, shell) run mid-response, so text can continue right after one
      for await (const event of stream) {
        if (event.type === 'content_block_start' && (event.content_block.type === 'tool_use' || event.content_block.type === 'server_tool_use')) {
          status = `-# using ${String(event.content_block.name).replace(/^openrouter:/, '')}...`; // e.g. openrouter:web_search -> web_search
          toolMessage.edit(status).catch((err) => console.error(err));
          afterToolUse = true;
        } else if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') {
          // the model never adds a line break itself, so text before and after a tool would run together ("...hellOKAY...")
          if (afterToolUse && stepText && !stepText.endsWith('\n')) stepText += '\n';
          afterToolUse = false;
          stepText += event.delta.text;
        }
      }
      streamStr = stepText || streamStr; // keep the earlier text if the final round has none

      const response = await stream.finalMessage();

      // record server-side tool calls (web search, shell), which come back already executed. each is a server_tool_use block,
      // with its results either in a result block pointing back to it (shell: openrouter_shell_tool_result),
      // or for web search, which has no result block, as citations on the text blocks after it
      response.content.forEach((block, i) => {
        if (block.type !== 'server_tool_use') return;

        const resultBlock = response.content.find((other: any) => other.tool_use_id === block.id) as any;
        let results;
        if (resultBlock) {
          results = resultBlock.content;
        } else {
          // up to the next call of the same tool, since other tools' calls can come in between (e.g. a search then a shell call)
          const nextCall = response.content.findIndex((other, j) => j > i && other.type === 'server_tool_use' && other.name === block.name);
          results = response.content.slice(i + 1, nextCall === -1 ? undefined : nextCall)
            .flatMap((other) => (other.type === 'text' ? other.citations ?? [] : []))
            .map((citation: any) => ({ title: citation.title, url: citation.url, cited_text: citation.cited_text }));
        }

        toolList.push({
          conversation_id: conversation.conversation_id,
          timestamp: Date.now(),
          tool_call_id: block.id,
          tool_name: String(block.name).replace(/^openrouter:/, ''), // e.g. openrouter:web_search -> web_search
          output: JSON.stringify({ input: block.input, results }),
        });
      });

      const toolUses = response.content.filter((block): block is ToolUseBlock => block.type === 'tool_use');
      if (response.stop_reason !== 'tool_use' || toolUses.length === 0) break;

      // run each requested tool, then hand the results back for the next step
      const toolResults: ToolResultBlockParam[] = await Promise.all(toolUses.map(async (toolUse): Promise<ToolResultBlockParam> => {
        const localTool = localToolMap[toolUse.name];
        const output = localTool?.execute
          ? await localTool.execute(toolUse.input, { toolCallId: toolUse.id, messages: [], context: replyContext })
          : { result: 'failure', message: `There is no tool named ${toolUse.name}` };
        const outputStr = typeof output === 'string' ? output : JSON.stringify(output);

        toolList.push({
          conversation_id: conversation.conversation_id,
          timestamp: Date.now(),
          tool_call_id: toolUse.id,
          tool_name: toolUse.name,
          output: outputStr,
        });

        return { type: 'tool_result', tool_use_id: toolUse.id, content: outputStr };
      }));

      messages.push({ role: 'assistant', content: response.content });
      messages.push({ role: 'user', content: toolResults });
    }

    // insert tools into database while mapping to string
    const toolStr = toolList.map((tool) => {
      insertConversationToolResult(tool);
      return `> -# used ${tool.tool_name}`;
    }).join('\n');
    const replyArr = await formatResponse(conversation.conversation_id, `${toolStr}\n\n${streamStr}`);

    toolMessage.delete();

    const initialResponse = replyArr.shift() ?? '';
    await userMessage.reply(initialResponse);
    replyArr.forEach(async (reply) => {
      await messageChannel.send(reply);
    });

    // skip any message deleted while the reply was generating, since its delete event found nothing to delete yet
    conversationContext.filter((ctx) => !recentlyDeleted.has(ctx.message_id)).forEach((ctx) => insertConversationMessage(ctx));

    // every reply resends the whole conversation, so once it's this big, wrap it up into a summary and start fresh
    if (getConversationTokenCount(conversation.conversation_id) > MAX_CONVERSATION_TOKENS) {
      endConversation(conversation).catch((error) => console.error(error)); // in the background, so it doesn't hold up anything
    }
  } catch (error: any) {
    console.error(error);
    toolMessage.edit(`There was an issue... Please try again later...\n\`\`\`${error?.message ?? ''}\`\`\``).catch((err) => console.error(err));
  }
}

export { getBaseSystemPrompt, getDefaultSystemPrompt, getSystemPrompt, getEmbedding, handleChatbotReply, markMessageDeleted };
