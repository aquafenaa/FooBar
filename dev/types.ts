import { AutocompleteInteraction, CommandInteraction, SlashCommandBuilder, Snowflake } from 'discord.js';

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
  heartBoard: HeartBoard,
  voicePing: VoicePing,
}

interface ConfigData {
  servers: ServerConfig[];
}

interface HeartBoard {
  enabled: boolean,
  cumulative: boolean,
  denyAuthor: boolean,
  thresholdNumber: number,
  emojis: Snowflake[],
  outputChannel: Snowflake;
}

interface VoicePing {
  enabled: boolean,
  voicePingMessage: string,
  inputChannels: Snowflake[],
  outputChannel: Snowflake;
}

/* Command */
interface Command {
  data: SlashCommandBuilder | any;
  execute(interaction: CommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void>;
  autocomplete?(interaction: AutocompleteInteraction, serverConfig: ServerConfig): Promise<void>;
}

const defaultHeartboardConfig: HeartBoard = {
  enabled: false,
  cumulative: false,
  denyAuthor: false,
  thresholdNumber: 3,
  emojis: ['❤️'],
  outputChannel: '',
};

const defaultVoicepingConfig: VoicePing = {
  enabled: false,
  voicePingMessage: 'Welcome to the voice channel, {user}',
  inputChannels: [],
  outputChannel: '',
};

export {
  ServerData, SaveData, HeartBoardMessage, ConfigData, ServerConfig, HeartBoard, VoicePing, Command,
  defaultHeartboardConfig, defaultVoicepingConfig,
};
