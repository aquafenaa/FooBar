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
  chatbot_core_memory: string;
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

  author_id: Snowflake,
  role: 'system' | 'user' | 'assistant',

  message_content: string,
  timestamp: number;
}

interface AutomaticResponseTable {
  server_id: Snowflake,
  name: string,
  enabled: boolean,

  activation_regex: string,
  capture_regex: string,
  output_template: string;
}

export {
  ServerTable, // ChannelTable, MessageTable, /* Core structures */
  AutomaticResponseTable, HeartBoardTable, HeartBoardEmojiTable, HeartBoardMessageTable, VoicePingTable, VoicePingInputTable, /* Features */
  ChatbotTable, ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable, /* AI-related structures */
};
