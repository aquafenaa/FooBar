import {
  ChatInputCommandInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command, Feature, ServerConfig } from './types';

const commandMap: Map<string, Command> = new Map();
const featureMap: Map<string, Feature> = new Map();

const Help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays all commands!')
    .addStringOption((emoji) => emoji.setName('command-name').setDescription('Name of the command to use')), // TODO: DELETE
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply('Pong!');
  },
};

const HeartBoardFeature: Feature = {
  name: 'heartboard',
  description: 'Highlights beloved messages with a certain amount of reactions',
  configEmbedBuilder(title: string, serverConfig: ServerConfig) {
    const { enabled, cumulative, denyAuthor, thresholdNumber, emojis, outputChannel } = serverConfig.heartBoard;

    return new EmbedBuilder()
      .setTitle(title)
      .addFields(
        { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
        { name: 'Cumulative Threshold', value: (cumulative ? 'Yes' : 'No') },
        { name: 'Exclude Author\'s Reactions', value: `${denyAuthor ? 'Yes' : 'No'}` },
        { name: 'Threshold Value', value: `${thresholdNumber}` },
        { name: 'Emojis', value: `${emojis.join(', ')}` },
        { name: 'HeartBoard Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
      );
  },
};

const AIFeature: Feature = {
  name: 'ai-messages',
  description: 'When pinged or replied to, the bot generates an LLM response',
  configEmbedBuilder(title: string, serverConfig: ServerConfig) {
    const { aiEnabled } = serverConfig;

    return new EmbedBuilder()
      .setTitle(title)
      .addFields(
        { name: 'Enabled', value: (aiEnabled ? 'Yes' : 'No') },
      );
  },
};

const VoicePingFeature: Feature = {
  name: 'voice-ping',
  description: 'Sends a message when a user joins a voice channel',
  configEmbedBuilder(title: string, serverConfig: ServerConfig) {
    const { enabled, voicePingMessage, inputChannels, outputChannel } = serverConfig.voicePing;

    return new EmbedBuilder()
      .setTitle(title)
      .addFields(
        { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
        { name: 'Message', value: voicePingMessage ?? 'No message set' },
        { name: 'Listener Channels', value: inputChannels && inputChannels.length > 0 ? inputChannels?.map((id) => `<#${id}>`)?.join(', ') : 'No channels set' },
        { name: 'Log Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
      );
  },
};

// set features before config so that we can generate feature name choices
featureMap.set(HeartBoardFeature.name, HeartBoardFeature);
featureMap.set(AIFeature.name, AIFeature);
featureMap.set(VoicePingFeature.name, VoicePingFeature);

const ConfigCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('config')
    .setDescription('Control server-wide settings of bot\'s features')
    .addSubcommand(
      (statusSubcommand) => statusSubcommand.setName('status')
        .setDescription('Enable or disable a feature')
        .addStringOption((statusFeatureName) => statusFeatureName.setName('feature-name')
          .setDescription('Name of the feature you wish to view')
          .setRequired(true)
          .addChoices(
            Array.from(featureMap.values()).map((feature) => ({ name: feature.name, value: feature.name })),
          ))
        .addBooleanOption((statusEnabled) => statusEnabled.setName('enabled')
          .setDescription('Whether the feature is enabled (true) or not (false)')
          .setRequired(true)),
    )
    .addSubcommandGroup(
      (editSubcommandGroup) => editSubcommandGroup.setName('edit')
        .setDescription('Edit the current settings of a feature')
        .addSubcommand(
          (heartBoardEdit) => heartBoardEdit.setName(HeartBoardFeature.name)
            .setDescription(HeartBoardFeature.description)
            .addBooleanOption((heartBoardCumulative) => heartBoardCumulative.setName('cumulative')
              .setDescription('Whether a single emoji must reach threshold (true), or total of all emojis reach threshold (false)')
              .setRequired(false))
            .addBooleanOption((heartBoardAuthor) => heartBoardAuthor.setName('deny-author')
              .setDescription('Whether to remove relevant reactions from message author (true) or not (false)')
              .setRequired(false))
            .addIntegerOption((heartBoardThreshold) => heartBoardThreshold.setName('threshold')
              .setDescription('Number of reactions to reach the heartboard')
              .setRequired(false))
            .addStringOption((heartBoardEmojis) => heartBoardEmojis.setName('emojis')
              .setDescription('What emojis are tracked for the heartboard')
              .setRequired(false))
            .addChannelOption((heartBoardOutput) => heartBoardOutput.setName('output-channel')
              .setDescription('Heartboard channel to send messages in')
              .setRequired(false)),
        ).addSubcommand(
          (voicePingEdit) => voicePingEdit.setName(VoicePingFeature.name)
            .setDescription(VoicePingFeature.description)
            .addStringOption((voicePingMessage) => voicePingMessage.setName('message')
              .setDescription('Message sent when a user joins a relevant channel')
              .setRequired(false))
            .addStringOption((voicePingInputs) => voicePingInputs.setName('input-channels')
              .setDescription('Voice Channels to listen to. Enter a list of channel IDs separated by a space')
              .setRequired(false))
            .addChannelOption((voicePingOutput) => voicePingOutput.setName('output-channel')
              .setDescription('Desired channel to send the message to')
              .setRequired(false)),
        ),
    )
    .addSubcommand((viewSubcommandGroup) => viewSubcommandGroup.setName('view')
      .setDescription('View current config settings of a feature')
      .addStringOption((viewFeatureName) => viewFeatureName.setName('feature-name')
        .setDescription('Name of the feature you wish to view')
        .setRequired(true)
        .addChoices(Array.from(featureMap.values()).map((feature) => ({ name: feature.name, value: feature.name }))))),
  async execute(interaction: ChatInputCommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void> {
    if (serverConfig === undefined) { console.error('Server is undefined'); return; }

    const subCommandGroup = interaction.options.getSubcommandGroup();
    const subCommand = interaction.options.getSubcommand();

    if (subCommand === 'status') {
      const enabledOption = interaction.options.getBoolean('enabled')!;
      const featureNameOption = interaction.options.getString('feature-name')!;
      const feature = featureMap.get(featureNameOption)!;

      if (featureNameOption === AIFeature.name) serverConfig.aiEnabled = enabledOption;
      if (featureNameOption === HeartBoardFeature.name) serverConfig.heartBoard.enabled = enabledOption;
      if (featureNameOption === VoicePingFeature.name) serverConfig.voicePing.enabled = enabledOption;

      interaction.reply({ embeds: [feature.configEmbedBuilder('New Config', serverConfig)], flags: MessageFlags.Ephemeral });
    } else if (subCommandGroup === 'edit') {
      if (subCommand === HeartBoardFeature.name) {
        const cumulativeOption = interaction.options.getBoolean('cumulative');
        const denyAuthorOption = interaction.options.getBoolean('deny-author');
        const thresholdOption = interaction.options.getInteger('threshold');
        const emojisOption = interaction.options.getString('emojis')?.split(' '); // separate each emoji
        const outputChannelOption = interaction.options.getChannel('output-channel');

        // if we don't receive any arguments, tell them and return
        if (cumulativeOption === null && denyAuthorOption === null && thresholdOption === null && emojisOption === null && outputChannelOption === null) {
          interaction.reply({ content: 'please provide an argument to update!', flags: MessageFlags.Ephemeral });
          return;
        }

        const oldHeartBoard = serverConfig.heartBoard;

        // update the values if we received them, otherwise keep their old value
        serverConfig.heartBoard = {
          enabled: oldHeartBoard.enabled,
          cumulative: cumulativeOption ?? oldHeartBoard.cumulative,
          denyAuthor: denyAuthorOption ?? oldHeartBoard.denyAuthor,
          thresholdNumber: thresholdOption ?? oldHeartBoard.thresholdNumber,
          emojis: emojisOption ?? oldHeartBoard.emojis,
          outputChannel: outputChannelOption?.id ?? oldHeartBoard.outputChannel,
        };

        interaction.reply({ embeds: [HeartBoardFeature.configEmbedBuilder('New Config', serverConfig)], flags: MessageFlags.Ephemeral });
      } else if (subCommand === VoicePingFeature.name) {
        const messageOption = interaction.options.getString('message');
        const inputChannelsOption = interaction.options.getString('input-channels')?.split(' '); // separate each channelID
        const outputChannelOption = interaction.options.getChannel('output-channel');

        // if we don't receive any arguments, tell them and return
        if (messageOption === null && inputChannelsOption === null && outputChannelOption === null) {
          interaction.reply({ content: 'please provide an argument to update!', flags: MessageFlags.Ephemeral });
          return;
        }

        const oldVoicePingConfig = serverConfig.voicePing;

        // update the values if we received them, otherwise keep their old value
        serverConfig.voicePing = {
          enabled: oldVoicePingConfig.enabled,
          voicePingMessage: messageOption ?? oldVoicePingConfig.voicePingMessage,
          inputChannels: inputChannelsOption ?? oldVoicePingConfig.inputChannels,
          outputChannel: outputChannelOption?.id ?? oldVoicePingConfig.outputChannel,
        };

        interaction.reply({ embeds: [VoicePingFeature.configEmbedBuilder('New Config', serverConfig)], flags: MessageFlags.Ephemeral });
      }
    } else if (subCommand === 'view') {
      const featureNameOption = interaction.options.getString('feature-name')!;
      const feature = featureMap.get(featureNameOption)!;

      await interaction.reply({
        embeds: [feature.configEmbedBuilder('Current Config', serverConfig)],
        flags: MessageFlags.Ephemeral,
      });

      return; // we aren't changing config, so return early
    }

    return serverConfig;
  },
};

commandMap.set(Help.data.name, Help);
commandMap.set(ConfigCommand.data.name, ConfigCommand);

export { commandMap, Help, ConfigCommand, HeartBoardFeature, VoicePingFeature };
