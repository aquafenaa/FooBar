import { CommandInteraction, SlashCommandBuilder, Snowflake } from 'discord.js';

type Location = 'YOUTUBE' | 'SPOTIFY' | 'SOUNDCLOUD';

interface VoicePing {
  enabled: boolean,
  voicePingMessage: string,
  inputChannels: string[],
  outputChannel: string;
}

interface Server {
  id: string,
  voicePing: VoicePing,
  musicChannel?: Snowflake;
}

interface ConfigData {
  servers: Server[];
}

interface Command {
  data: SlashCommandBuilder | any;
  execute(interaction: CommandInteraction, config: ConfigData): Promise<ConfigData | void>;
}

export {
  Location, ConfigData, Server, VoicePing, Command,
};
