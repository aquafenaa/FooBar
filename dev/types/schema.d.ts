import { Snowflake } from 'discord.js';

interface ServerTable {
  server_id: Snowflake;
  dm_user_id?: Snowflake; // set for a DM with the bot, treated as a server of its own: whose DM it is, which is also its server_id
}
interface ChannelTable {
  server_id: Snowflake,
  channel_id: Snowflake;
}
interface MessageTable {
  server_id: Snowflake,
  channel_id: Snowflake,
  message_id: Snowflake,

  author_id: Snowflake;
}

interface HeartBoardTable {
  server_id: Snowflake,
  board_name: string,

  enabled: boolean,
  deny_author: boolean,
  threshold: number,

  output_channel: Snowflake;
}
interface HeartBoardEmojiTable {
  server_id: Snowflake,
  board_name: string,
  emoji: string;
}
interface HeartBoardMessageTable {
  server_id: Snowflake,
  board_name: string,
  message_id: Snowflake,

  total_emojis: number,

  channel_id: Snowflake,
  embed_id: Snowflake;
}

interface VoicePingTable {
  server_id: Snowflake,
  voiceping_name: string,
  enabled: boolean,

  message_template: string,
  output_channel: Snowflake;
}
interface VoicePingInputTable {
  server_id: Snowflake,
  voiceping_name: string,
  channel_id: Snowflake;
}

interface ChatbotTable {
  server_id: Snowflake,

  chatbot_enabled: boolean,
  tools_enabled: boolean,
  detached: boolean, // true = keeps its own context, instead of sharing the 'main' context with other servers
  model?: string, // openrouter model id, e.g. z-ai/glm-5.3. the default model if unset
  reasoning_effort?: string, // e.g. low, high, max. which ones work depends on the model. the default effort if unset
  temperature?: number, // 0-2, how random its replies are. the default temperature if unset
  system_prompt_override?: string, // replaces SYSTEM.md for this server, if set
  chatbot_prompt: string, // the server's persona, layered on top of the system prompt. Empty for none
}
interface MemoryTable {
  name: string,
  source_id: string, // where the memory belongs: the server id on discord, the post path on bluesky, or 'main' if shared between servers
  content: string,
}
interface ConversationTable {
  conversation_id: string,
  platform: 'discord' | 'bluesky',
  channel_id?: string, // channel the conversation takes place in, if the platform has them
  source_id?: string, // where the conversation came from: the server id on discord, or the post path on bluesky
  expires_at: number; // date in millis
}
interface ConversationMessageTable {
  conversation_id: string,
  message_id: string,
  reference_id?: string,

  token_count?: number,

  author_name: string,
  author_id: string,
  role: 'system' | 'user' | 'assistant',

  message_content: string,
  timestamp: number;
}
interface ConversationSummaryTable {
  conversation_id: string,
  // where the conversation took place: `{server_id}#{channel_id}` on discord, or the post path on bluesky.
  // prefixed with `main#` for the copy shared between servers. See toSummarySource/fromSummarySource
  source_id: string,
  summary: string,
  timestamp: number,
  embedding: number[] | undefined;
}
interface ConversationToolResultTable {
  conversation_id: string,
  tool_name: string,
  tool_call_id: string,
  timestamp: number,
  output: string;
  dirty?: boolean, // whether the call could have changed something (sent a message, saved a memory, ran a command...), rather than only looked
  discarded?: ToolResultDiscard, // set when its reply was cancelled, failed, or replaced by another version. see getVisibleToolResults
}
// why a tool result no longer belongs to the reply on screen
type ToolResultDiscard = 'cancelled' | 'failed' | 'replaced';
interface IndexUserTable {
  conversation_id: string,
  user_id: string,
  shorthand: string;
}
interface IndexMessageTable {
  conversation_id: string,
  message_id: string,
  shorthand: string;
}
interface IndexChannelTable {
  conversation_id: string,
  channel_id: string,
  shorthand: string;
}
interface IndexRoleTable {
  conversation_id: string,
  role_id: string,
  shorthand: string;
}

interface ChatbotSubscriberTable {
  server_id: Snowflake,
  user_id: Snowflake,
  cross_server: boolean; // whether the user's messages from this server may be shared with other servers
}
interface SavedAnonymizedChat {
  server_id: Snowflake,
  message_id: Snowflake,

  reference_content?: string,
  message_content: string,
}

interface AutomaticResponseTable {
  server_id: Snowflake,
  name: string,
  enabled: boolean,

  activation_regex: string,
  capture_regex: string,
  output_template: string;
}
interface ResponseMessageTable {
  server_id: Snowflake,
  message_id: Snowflake;
}

interface CounterTable {
  server_id: Snowflake,
  counter_name: string, // not case-sensitive
  value: number;
}
interface ReminderTable {
  server_id: Snowflake,
  reminder_name: string,
  channel_id: Snowflake,

  repeats: boolean,
  cron_schedule: string,
  message_content: string;
}
// a prompt the chatbot is given on a schedule, with no message to answer
interface HeartbeatTable {
  server_id: Snowflake,
  heartbeat_name: string, // not case-sensitive
  channel_id: Snowflake,
  created_by: Snowflake, // the admin who made it, or the bot's own id if the bot scheduled it

  repeats: boolean,
  silent?: boolean, // its reply is never posted, for beats that only use tools (e.g. browsing Bluesky). it can still send_message
  cron_schedule: string,
  prompt: string,
  context?: string; // background shown with the prompt, e.g. what happened that it's following up on
}

export {
  ServerTable, // ChannelTable, MessageTable, /* Core structures */
  AutomaticResponseTable, ResponseMessageTable, ReminderTable, HeartbeatTable, CounterTable, HeartBoardTable, HeartBoardEmojiTable, HeartBoardMessageTable, VoicePingTable, VoicePingInputTable, /* Features */
  ChatbotTable, SavedAnonymizedChat, ChatbotSubscriberTable, MemoryTable, ConversationTable, ConversationMessageTable, ConversationSummaryTable, ConversationToolResultTable, ToolResultDiscard, IndexUserTable, IndexMessageTable, IndexChannelTable, IndexRoleTable, /* AI-related structures */
};
