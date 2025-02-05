import { CommandInteraction, SlashCommandBuilder } from 'discord.js';

interface VoicePing {
  enabled: boolean,
  voicePingMessage: string,
  inputChannels: string[],
  outputChannel: string;
}

interface Server {
  id: string,
  voicePing: VoicePing,
}

interface ConfigData {
  servers: Server[];
}

interface Command {
  data: SlashCommandBuilder | any;
  execute(interaction: CommandInteraction, config: ConfigData): Promise<ConfigData | void>;
}

export {
  ConfigData, Server, VoicePing, Command,
};
