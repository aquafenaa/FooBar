import { AutocompleteInteraction, CommandInteraction, EmbedBuilder, SlashCommandBuilder, Snowflake } from 'discord.js';

// Configs--permanent data for various commands and features. stored in ./data/config.json

/**
 * Holds configuration data for a discordJS Guild
 *
*/
// interface ServerConfig {
//   id: Snowflake,

//   aiEnabled: boolean,
//   serverResponses: AutomaticResponse[],
//   heartBoard: HeartBoardConfig,
//   voicePing: VoicePingConfig;
// }
// interface ConfigData {
//   servers: ServerConfig[];
// }

// interface HeartBoardConfig {
//   enabled: boolean,
//   cumulative: boolean,
//   denyAuthor: boolean,
//   thresholdNumber: number,
//   emojis: Snowflake[],
//   outputChannel: Snowflake;
// }
// interface HeartBoardMessage {
//   channelID: Snowflake,
//   messageID: Snowflake,
//   embedMessageID: Snowflake;
// }

// interface VoicePingConfig {
//   enabled: boolean,
//   voicePingMessage: string,
//   inputChannels: Snowflake[],
//   outputChannel: Snowflake;
// }

/**
 * Data--more volatile and less important than direct configs. stored in ./data/data.json (stupid name, ik)
*/
// interface SaveData {
//   servers: ServerData[],
// }
// interface ServerData {
//   id: Snowflake, // server ID
//   heartBoardMessages: HeartBoardMessage[],

//   chatbotShortTermMessages: ChatbotMessage[],
//   chatbotLongtermMemory: string[],
//   chatbotCoreMemory: string;
// }

/**
 * A SlashCommand that a Discord user may call within a server
 * i.e. Help or Config
 *
 * data is the SlashCommandBuilder to give to discord directly
 * execute is called when the SlashCommand is used
 * autocomplete function is called when a (sub)command is called that's labeled as autocomplete
*/
interface Command {
  // usage: string,
  data: SlashCommandBuilder | any, // any is for catching SlashCommandBuilders that omit certain, unused variables
  execute(interaction: CommandInteraction, serverID: Snowflake): Promise<void>,
  autocomplete?(interaction: AutocompleteInteraction, serverID: Snowflake): Promise<void>;
}

interface ConfigCommand extends Command {
  configEmbedBuilder(serverID: Snowflake, input: any): EmbedBuilder;
}
/**
 * A behaviour by the bot that isn't directly influenced by commands
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
  configEmbedBuilder(embedTitle: string, serverID: Snowflake): EmbedBuilder;
}

/**
 * An automatic response from the bot
 *
*/
// interface AutomaticResponse {
//   enabled: boolean,
//   name: string,
//   activationRegex: string,
//   captureRegex: string | undefined, // capturing regex for the response to use
//   outputTemplateString: string;
// }

/*
 * Cok (an LLM built into the Discord bot) types. Mostly implemented in chatbot.ts
*/
// interface ChatbotMessage {
//   role: 'system' | 'user' | 'assistant', // role, as defined by OpenAI API
//   author: string, // author of message's display name
//   authorID: Snowflake, // ID of the author
//   timestamp: number, // time the message was originally sent
//   messageID: Snowflake, // saved for later in case of future reference ability
//   messageContent: string;
// }

/*
 * Default values for feature configs. Useful for setting default configs
*/
// const defaultHeartboardConfig: HeartBoardConfig = {
//   enabled: false,
//   cumulative: false,
//   denyAuthor: false,
//   thresholdNumber: 3,
//   emojis: ['❤️'], // all UTF emojis MUST be in their UTF form, instead of discord's :heart: format ("❤️", not ":heart:")
//   outputChannel: '',
// };
// const defaultVoicepingConfig: VoicePingConfig = {
//   enabled: false,
//   voicePingMessage: 'Welcome to the voice channel, {user}',
//   inputChannels: [],
//   outputChannel: '',
// };

export {
  // ConfigData, SaveData, ServerData, ServerConfig, // Save data
  Command, ConfigCommand, Feature, // Savedata, Commands, and Features
  // AutomaticResponse
  // ChatbotMessage, // AI-related types (🤮)
  // HeartBoardMessage, HeartBoardConfig, VoicePingConfig, // Feature config types
  // defaultHeartboardConfig, defaultVoicepingConfig, // Defaults
};
