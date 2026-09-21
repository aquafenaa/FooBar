import { Snowflake } from 'discord.js';

interface ServerTable {
  server_id: Snowflake;
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
  chatbot_prompt: string,
  chatbot_core_memory: string;
}
interface ChatbotSubscriberTable {
  server_id: Snowflake,
  user_id: Snowflake;
}
interface ChatbotLongTermMemoryTable {
  server_id: Snowflake,
  memory_id: number,
  message_content: string,
  timestamp: number;
}
interface ChatbotShortTermMemoryTable {
  server_id: Snowflake,
  message_id: Snowflake,
  reference_id?: Snowflake,

  embedding: number[] | undefined,

  author_name: string,
  author_id: Snowflake,
  role: 'system' | 'user' | 'assistant',

  message_content: string,
  timestamp: number;
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

interface ReminderTable {
  server_id: Snowflake,
  reminder_name: string,

  channel_id: Snowflake,
  repeats: boolean,
  cron_schedule: string,
  message_content: string;
}

export {
  ServerTable, // ChannelTable, MessageTable, /* Core structures */
  AutomaticResponseTable, ResponseMessageTable, ReminderTable, HeartBoardTable, HeartBoardEmojiTable, HeartBoardMessageTable, VoicePingTable, VoicePingInputTable, /* Features */
  ChatbotTable, SavedAnonymizedChat, ChatbotSubscriberTable, ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable, /* AI-related structures */
};
