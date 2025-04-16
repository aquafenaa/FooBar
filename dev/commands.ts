import {
  Channel,
  ChannelType,
  ChatInputCommandInteraction,
  AutocompleteInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder, TextChannel,
} from 'discord.js';
import { Command, HeartBoard, ServerConfig, VoicePing } from './types';
import { editServerConfig } from './data';

const Help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays all commands!')
    .addStringOption((emoji) => emoji.setName('emoji').setDescription('ii')), // TODO: DELETE
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply('Pong!');
  },
};

function buildHeartBoardEmbed(heartBoard: HeartBoard) {
  const { enabled, cumulative, thresholdNumber, emojis, outputChannel } = heartBoard;

  return new EmbedBuilder()
    .setTitle('Heart Board Settings')
    .addFields(
      { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
      { name: 'Cumulative Threshold', value: (cumulative ? 'Yes' : 'No') },
      { name: 'Threshold Value', value: `${thresholdNumber}` },
      { name: 'Emojis', value: `${emojis.join(', ')}` },
      { name: 'HeartBoard Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
    );
}

const HeartBoardCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('heartboard')
    .setDescription('Highlights beloved messages with a certain amount of reactions')
    .addSubcommandGroup((configGroup) => configGroup.setName('config')
      .setDescription('View and edit the heart board settings')
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
        .setDescription('View current heart board settings'))
      .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
        .setDescription('Edit the current heart board settings')
        .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
          .setDescription('Whether the heart board is current enabled'))
        .addBooleanOption((cumulativeOption) => cumulativeOption.setName('cumulative')
          .setDescription('Whether a single emoji must reach threshold (true), or total count of emojis reach threshold (false)'))
        .addBooleanOption((banAuthorOption) => banAuthorOption.setName('deny-author')
          .setDescription('Whether the author may react to their own message with a heartboard emoji'))
        .addNumberOption((thresholdOption) => thresholdOption.setName('threshold')
          .setDescription('Total number of reactions in order to trigger the message highlight'))
        .addStringOption((emojisOption) => emojisOption.setName('emojis')
          .setDescription('Emojis that trigger the bot. Separate with \',\'')
          .setAutocomplete(true))
        .addChannelOption((outputChannelOption) => outputChannelOption.setName('output-channel')
          .setDescription('Channel to output highlighted messages to')))),
  async execute(interaction: ChatInputCommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void> {
    const { enabled, cumulative, denyAuthor: banAuthor, thresholdNumber, emojis, outputChannel } = serverConfig.heartBoard;

    if (interaction.options.getSubcommandGroup() === 'config') {
      const subcommand = interaction.options.getSubcommand();

      if (subcommand === 'edit') {
        const newEnabled = interaction.options.getBoolean('enabled') ?? undefined;
        const newCumulative = interaction.options.getBoolean('cumulative') ?? undefined;
        const newBanAuthor = interaction.options.getBoolean('deny-author') ?? undefined;
        const newThresholdNumber = interaction.options.getNumber('threshold');
        const newEmojis = interaction.options.getString('emojis')?.trim()?.split(',');
        const newOutputChannel = interaction.options.getChannel('output-channel');

        // if none of the options were given
        if (!(newEnabled === undefined || newCumulative === undefined || newBanAuthor === undefined
            || newThresholdNumber || newEmojis || newOutputChannel)) {
          interaction.reply({ content: 'Please give an option to change!', flags: MessageFlags.Ephemeral });
          return;
        }

        serverConfig.heartBoard = {
          enabled: newEnabled ?? enabled,
          cumulative: newCumulative ?? cumulative,
          denyAuthor: newBanAuthor ?? banAuthor,
          thresholdNumber: newThresholdNumber ?? thresholdNumber,
          emojis: newEmojis ?? emojis,
          outputChannel: newOutputChannel?.id ?? outputChannel,
        };

        editServerConfig(serverConfig);

        interaction.reply({ content: 'Successfully edited HeartBoard settings', embeds: [buildHeartBoardEmbed(serverConfig.heartBoard)], flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'view') {
        interaction.reply({ embeds: [buildHeartBoardEmbed(serverConfig.heartBoard)], flags: MessageFlags.Ephemeral });
      }
    }
  },
  async autocomplete(interaction: AutocompleteInteraction, serverConfig: ServerConfig): Promise<void> {
    const emojiString = serverConfig.heartBoard.emojis.join(',');
    await interaction.respond([{ name: emojiString, value: emojiString }]);
  },
};

function buildVoicePingEmbed(voicePing: VoicePing) {
  const { enabled, voicePingMessage, inputChannels, outputChannel } = voicePing;

  return new EmbedBuilder()
    .setTitle('Voice Ping Settings')
    .addFields(
      { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
      { name: 'Message', value: voicePingMessage ?? 'No message set' },
      { name: 'Listener Channels', value: inputChannels && inputChannels.length > 0 ? inputChannels?.map((id) => `<#${id}>`)?.join(', ') : 'No channels set' },
      { name: 'Log Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
    );
}

const VoicePingCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('voiceping')
    .setDescription('Sends a message when a user joins a voice channel')
    .addSubcommand((testSubcommand) => testSubcommand.setName('test')
      .setDescription('Test the voice ping message to the output channel'))
    .addSubcommandGroup((settingsGroup) => settingsGroup.setName('settings')
      .setDescription('View and edit the voice ping settings')
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
        .setDescription('View the current voice ping settings'))
      .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
        .setDescription('Edit the current voice ping settings')
        .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
          .setDescription('Enter "True" to enable, or "False" to disable.'))
        .addStringOption((messageOption) => messageOption.setName('message')
          .setDescription('Message to send when a user joins. {user} mentions the user, and {channel} mentions the channel.'))
        .addStringOption((inputChannelsOption) => inputChannelsOption.setName('inputs')
          .setDescription('The channels to listen for voice users joining. Enter channel IDs seperated by a space.'))
        .addChannelOption((outputChannelOption) => outputChannelOption.setName('output')
          .setDescription('Desired channel to output the message to')))),

  async execute(interaction: ChatInputCommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void> {
    if (serverConfig === undefined) { console.error('Server is undefined'); return; }

    let { enabled, voicePingMessage, inputChannels, outputChannel } = serverConfig.voicePing;

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
        await interaction.reply({ embeds: [buildVoicePingEmbed(serverConfig.voicePing)], ephemeral: true });

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

        serverConfig.voicePing = {
          enabled,
          voicePingMessage,
          inputChannels,
          outputChannel,
        };

        await interaction.reply({ embeds: [buildVoicePingEmbed(serverConfig.voicePing)], ephemeral: true });

        return serverConfig;
      }
    }
  },
};

const commandMap: Map<string, Command> = new Map();
commandMap.set(Help.data.name, Help);
commandMap.set(HeartBoardCommand.data.name, HeartBoardCommand);
commandMap.set(VoicePingCommand.data.name, VoicePingCommand);

export { commandMap, Help, HeartBoardCommand, VoicePingCommand };
