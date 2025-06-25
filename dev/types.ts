import { AutocompleteInteraction, CommandInteraction, EmbedBuilder, SlashCommandBuilder, Snowflake } from 'discord.js';

/*
 * Configs--permanent data for various commands and features. stored in ./data/config.json
*/
interface ServerConfig {
  id: Snowflake,
  aiEnabled: boolean,
  heartBoard: HeartBoardConfig,
  voicePing: VoicePingConfig,
}
interface ConfigData {
  servers: ServerConfig[];
}

interface HeartBoardMessage {
  channelID: Snowflake,
  messageID: Snowflake,
  embedMessageID: Snowflake;
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

/*
 * Data--more volatile and less important than direct configs. stored in ./data/data.json
*/
interface SaveData {
  servers: ServerData[],
  grokCoreMemory: string;
}
interface ServerData {
  id: Snowflake, // server ID
  heartBoardMessages: HeartBoardMessage[]; // channelID, messageID -> embedMessageID
}

/*
 * A command is added automatically as a SlashCommand that a Discord user may call
 * i.e. Help or Config
 *
 * data is the SlashCommandBuilder to give to discord directly
 * execute is called when the SlashCommand is used
 * autocomplete function is called when a (sub)command is called that's labeled as autocomplete
*/
interface Command {
  // usage: string,
  data: SlashCommandBuilder | any, // any is for catching SlashCommandBuilders that omit certain, unused variables
  execute(interaction: CommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void>,
  autocomplete?(interaction: AutocompleteInteraction, serverConfig: ServerConfig): Promise<void>;
}

/*
 * A feature is a behaviour by the bot that isn't directly influenced by commands
 * i.e. VoicePing or HeartBoard messages
 *
 * each feature is automatically added to the help command to show its name and description
 * they are also added automatically to the config command, however edit functionality must be added manually to commands.ts
 *
 * the configEmbedBuilder is used by the config command to show the current config variables for the selected server
*/
interface Feature {
  name: string,
  description: string,
  configEmbedBuilder(embedTitle: string, serverConfig: ServerConfig): EmbedBuilder
}

/*
 * Grok (an LLM built into the Discord bot) types. Used largely in grok.ts
*/
interface GrokMessage {
  role: 'system' | 'user' | 'assistant',
  author: string, // author of message's display name
  authorID: Snowflake, // ID of the author
  timestamp: number,
  messageID: Snowflake; // saved for later in case of future reference ability
  messageContent: string,
}

/*
 * Default values for feature configs. Useful for setting default configs
*/
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
  ConfigData, SaveData, ServerData, ServerConfig, Command, Feature, // Savedata, Commands, and Features
  GrokMessage, // AI-related types
  HeartBoardMessage, HeartBoardConfig, VoicePingConfig, // Feature config types
  defaultHeartboardConfig, defaultVoicepingConfig, // Defaults
};
