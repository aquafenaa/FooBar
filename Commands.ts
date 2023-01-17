/* eslint-disable no-param-reassign */
import {
  Channel, CommandInteraction, EmbedBuilder, SlashCommandBuilder,
} from 'discord.js';
import { Command, Config } from './Types';

const Help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays all commands!'),
  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.reply('Pong!');
  },
};

const VoicePing: Command = {
  data: new SlashCommandBuilder()
    .setName('voiceping')
    .setDescription('Sends a message when a user joins a voice channel')
    .addBooleanOption((option) => option.setName('enable')
      .setDescription('Enable or disable voice ping')
      .setRequired(false))
    .addStringOption((option) => option.setName('message')
      .setDescription('Message to say. {user} mentions the user, and {channel} mentions the channel.')
      .setRequired(false))
    .addStringOption((option) => option.setName('inputs')
      .setDescription('The channels to listen for voice activity. Please use channel IDs seperated by a space.')
      .setRequired(false))
    .addChannelOption((option) => option.setName('output')
      .setDescription('The channel to send the message to')
      .setRequired(false)),
  async execute(interaction: CommandInteraction | any, config?: Config): Promise<void | Config> {
    const enabledOption: boolean | undefined = interaction.options.getBoolean('enable') ?? undefined;
    const messageOption: string | undefined = interaction.options.getString('message') ?? undefined;
    const inputOptions: string[] | undefined = interaction.options.getString('inputs')?.split(' ') ?? undefined;
    const outputOption: Channel | undefined = interaction.options.getChannel('output') ?? undefined;

    if (enabledOption === undefined && messageOption === undefined && inputOptions === undefined && outputOption === undefined) {
      const server = config?.servers.find((s) => s.id === interaction.guild?.id);
      if (server === undefined) { console.error('Server is undefined'); return; }
      const { enabled, voicePingMessage, inputChannels, outputChannel } = server.voicePing;

      const embed = new EmbedBuilder()
        .setTitle('Voice Ping Settings')
        .addFields(
          { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
          { name: 'Message', value: voicePingMessage ?? 'No message set' },
          { name: 'Listener Channels', value: inputChannels.map((id) => `<#${id}>`).join(', ') },
          { name: 'Log Channel', value: `<#${outputChannel}>` },
        );

      await interaction.reply({ embeds: [embed] });
      return;
    }

    if (config === undefined) { console.error('Config is undefined'); return; }
    const server = config.servers.find((s) => s.id === interaction.guild?.id);
    if (server === undefined) { console.error('Server is undefined'); return; }

    if (enabledOption !== undefined) {
      server.voicePing.enabled = enabledOption;
    }
    if (messageOption !== undefined) {
      server.voicePing.voicePingMessage = messageOption;
    }
    if (inputOptions !== undefined) {
      server.voicePing.inputChannels = inputOptions;
    }
    if (outputOption !== undefined) {
      server.voicePing.outputChannel = outputOption.id;
    }

    const { enabled, voicePingMessage, inputChannels, outputChannel } = server.voicePing;

    const embed = new EmbedBuilder()
      .setTitle('Voice Ping')
      .setDescription('Voice ping has been updated!')
      .addFields(
        { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
        { name: 'Message', value: voicePingMessage ?? 'No message set' },
        { name: 'Listener Channels', value: inputChannels.map((id) => `<#${id}>`).join(', ') },
        { name: 'Log Channel', value: `<#${outputChannel}>` },
      );

    await interaction.reply({ embeds: [embed] });

    if (config === undefined) return;

    // eslint-disable-next-line consistent-return
    return config;
  },
};

const ReactionRole: Command = {
  data: new SlashCommandBuilder()
    .setName('reactionrole')
    .setDescription('Creates a reaction role message'),
  async execute(interaction: CommandInteraction, config: Config): Promise<Config> {
    await interaction.reply('Pong!');

    return config;
  },
};

const commandMap: Map<string, Command> = new Map();
commandMap.set(Help.data.name, Help);
commandMap.set(VoicePing.data.name, VoicePing);

export { commandMap, Help, VoicePing, ReactionRole };
