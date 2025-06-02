import { AutocompleteInteraction, CommandInteraction, EmbedBuilder, SlashCommandBuilder, Snowflake } from 'discord.js';

interface HeartBoardMessage {
  channelID: Snowflake,
  messageID: Snowflake,
  embedMessageID: Snowflake;
}

/* Data */
interface ServerData {
  id: Snowflake,
  heartBoardMessages: HeartBoardMessage[]; // channelID, messageID -> embedMessageID
}

interface SaveData {
  servers: ServerData[];
}

/* Configs */
interface ServerConfig {
  id: Snowflake,
  aiEnabled: boolean,
  heartBoard: HeartBoardConfig,
  voicePing: VoicePingConfig,
}

interface ConfigData {
  servers: ServerConfig[];
}

interface HeartBoardConfig {
  enabled: boolean,
  cumulative: boolean,
  denyAuthor: boolean,
  thresholdNumber: number,
  emojis: Snowflake[],
  outputChannel: Snowflake;
}

interface VoicePingConfig {
  enabled: boolean,
  voicePingMessage: string,
  inputChannels: Snowflake[],
  outputChannel: Snowflake;
}

/* Command */
interface Command {
  // usage: string,
  data: SlashCommandBuilder | any,
  execute(interaction: CommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void>,
  autocomplete?(interaction: AutocompleteInteraction, serverConfig: ServerConfig): Promise<void>;
}
interface Feature {
  name: string,
  description: string,
  embedBuilder(title: string, heartBoard: ServerConfig): EmbedBuilder
}

const defaultHeartboardConfig: HeartBoardConfig = {
  enabled: false,
  cumulative: false,
  denyAuthor: false,
  thresholdNumber: 3,
  emojis: ['❤️'],
  outputChannel: '',
};

const defaultVoicepingConfig: VoicePingConfig = {
  enabled: false,
  voicePingMessage: 'Welcome to the voice channel, {user}',
  inputChannels: [],
  outputChannel: '',
};

export {
  ServerData, SaveData, HeartBoardMessage, ConfigData, ServerConfig, HeartBoardConfig, VoicePingConfig, Command, Feature,
  defaultHeartboardConfig, defaultVoicepingConfig,
};
