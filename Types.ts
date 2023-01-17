import { CommandInteraction, SlashCommandBuilder } from 'discord.js';

interface Config {
  servers: Server[];
}

interface VoicePing {
  enabled: boolean;
  voicePingMessage: string;
  inputChannels: string[];
  outputChannel: string;
}

interface Server {
  id: string;
  voicePing: VoicePing;
}

interface Command {
  data: SlashCommandBuilder | any;
  execute(interaction: CommandInteraction | any, config?: Config): Promise<void | Config>;
}

export {
  Config, Server, VoicePing, Command,
};
