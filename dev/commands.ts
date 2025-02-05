import {
  Channel,
  ChannelType,
  ChatInputCommandInteraction,
  CommandInteraction, EmbedBuilder, SlashCommandBuilder, TextChannel,
} from 'discord.js';
import { Command, ConfigData, Server } from './types';

const Help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays all commands!'),
  async execute(interaction: CommandInteraction): Promise<void> {
    await interaction.reply('Pong!');
  },
};

function buildVoicePingEmbed(server: Server) {
  const { enabled, voicePingMessage, inputChannels, outputChannel } = server.voicePing;

  return new EmbedBuilder()
    .setTitle('Voice Ping Settings')
    .setDescription('Voice ping settings for this server')
    .addFields(
      { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
      { name: 'Message', value: voicePingMessage ?? 'No message set' },
      { name: 'Listener Channels', value: inputChannels && inputChannels.length > 0 ? inputChannels?.map((id) => `<#${id}>`)?.join(', ') : 'No channels set' },
      { name: 'Log Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
    );
}

const VoicePing: Command = {
  data: new SlashCommandBuilder()
    .setName('voiceping')
    .setDescription('Sends a message when a user joins a voice channel')
    .addSubcommand((subcommand) => subcommand.setName('test')
      .setDescription('Test the voice ping message to the output channel'))
    .addSubcommandGroup((group) => group.setName('settings')
      .setDescription('View and edit the voice ping settings')
      .addSubcommand((subcommand) => subcommand.setName('view')
        .setDescription('View the current voice ping settings'))
      .addSubcommand((subcommand) => subcommand.setName('edit')
        .setDescription('Edit the current voice ping settings')
        .addBooleanOption((option) => option.setName('enabled')
          .setDescription('Enter "True" to enable, or "False" to disable.'))
        .addStringOption((option) => option.setName('message')
          .setDescription('Message to send when a user joins. {user} mentions the user, and {channel} mentions the channel.'))
        .addStringOption((option) => option.setName('inputs')
          .setDescription('The channels to listen for voice users joining. Enter channel IDs seperated by a space.'))
        .addChannelOption((option) => option.setName('output')
          .setDescription('Desired channel to output the message to')))),

  async execute(interaction: ChatInputCommandInteraction, config: ConfigData): Promise<ConfigData | void> {
    const server = config?.servers?.find((s) => s.id === interaction.guild?.id);

    if (config === undefined) { console.error('Config is undefined'); return; }
    if (server === undefined) { console.error('Server is undefined'); return; }

    let { enabled, voicePingMessage, inputChannels, outputChannel } = server.voicePing;

    let tempMessage = '';

    if (interaction.options.getSubcommand() === 'test') {
      if (outputChannel === undefined || outputChannel === '') {
        tempMessage += 'No output channel set! Testing in this channel.\n';
        outputChannel = interaction.channel?.id ?? '';
      }
      if (voicePingMessage?.includes('{channel}') && (inputChannels === undefined || inputChannels.length === 0)) {
        tempMessage += 'No input channels set! Testing using a random voice channel.';
        inputChannels = [interaction.guild?.channels.cache?.find((c: Channel) => c.type === ChannelType.GuildVoice)?.id ?? interaction.channel?.id ?? ''];
      }

      const channel: TextChannel = interaction.guild?.channels.cache.get(outputChannel) as TextChannel;

      if (channel === undefined) {
        await interaction.reply({ content: 'Invalid output channel!', ephemeral: true });

        return;
      }

      if (tempMessage === '') {
        tempMessage += 'Testing voice ping message!';
      }

      await interaction.reply({ content: tempMessage, ephemeral: true });

      await channel.send(voicePingMessage?.replace('{user}', interaction.user.toString()).replace('{channel}', `<#${inputChannels[0]}>`));

      return;
    }

    if (interaction.options.getSubcommandGroup() === 'settings') {
      if (interaction.options.getSubcommand() === 'view') {
        await interaction.reply({ embeds: [buildVoicePingEmbed(server)], ephemeral: true });

        return;
      }

      if (interaction.options.getSubcommand() === 'edit') {
        const enable = interaction.options.getBoolean('enabled');
        const message = interaction.options.getString('message');
        const inputs = interaction.options.getString('inputs')?.split(' ');
        const output = interaction.options.getChannel('output')?.id;

        if (enable !== null) {
          enabled = enable;
        }
        if (message !== null) {
          voicePingMessage = message;
        }
        if (inputs !== undefined) {
          inputChannels = inputs;
        }
        if (output !== undefined) {
          outputChannel = output;
        }

        server.voicePing = {
          enabled,
          voicePingMessage,
          inputChannels,
          outputChannel,
        };

        await interaction.reply({ embeds: [buildVoicePingEmbed(server)], ephemeral: true });

        const index = config.servers?.findIndex((s) => s.id === interaction.guild?.id);
        const newConfig = config;
        newConfig.servers[index] = server;

        // eslint-disable-next-line consistent-return
        return newConfig;
      }
    }
  },
};

const commandMap: Map<string, Command> = new Map();
commandMap.set(Help.data.name, Help);
commandMap.set(VoicePing.data.name, VoicePing);

export { commandMap, Help, VoicePing };
