import {
  ChatInputCommandInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
} from 'discord.js';
import { Command, Feature, Response, ServerConfig } from './types';

const commandMap: Map<string, Command> = new Map();
const featureMap: Map<string, Feature> = new Map();

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

const Help: Command = {
  data: new SlashCommandBuilder()
    .setName('help')
    .setDescription('Displays all commands!')
    .addStringOption((emoji) => emoji.setName('command-name').setDescription('Name of the command to use')), // TODO: DELETE
  async execute(interaction: ChatInputCommandInteraction): Promise<void> {
    await interaction.reply('Pong!');
  },
};

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

function responseEmbedBuilder(response: Response): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${response.name} response`)
    .addFields([
      { name: 'Enabled', value: response.enabled ? 'Yes' : 'No' },
      { name: 'Activation Regex', value: response.activationRegex },
      { name: 'Capture Regex', value: response.captureRegex ?? 'None' },
      { name: 'Output Template', value: response.outputTemplateString }
    ]);
}

const ResponseCommand: Command = {
  data: new SlashCommandBuilder()
    .setName('response').setDescription('A response is an automated, generated response, upon a specific phrase.')
    .addSubcommand((createResponseSubcommand) => createResponseSubcommand.setName('create')
      .setDescription('Creates an automated, generated response, when a specific phrase is sent')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the automated response')
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the response starts enabled or not.')
        .setRequired(true))
      .addStringOption((activationRegexOption) => activationRegexOption.setName('activation-regex')
        .setDescription('Regex that activates the formatted response, when detected')
        .setRequired(true))
      .addStringOption((captureRegexOption) => captureRegexOption.setName('capture-regex')
        .setDescription('Regex for capturing and grouping terms within the original text')
        .setRequired(true))
      .addStringOption((outputTemplateOption) => outputTemplateOption.setName('output-template')
        .setDescription('String for formatted output. Use {1}, {2}..., to use captured groups')
        .setRequired(true)))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
      .setDescription('Edit pre-existing responses')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the response to edit')
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the response is enabled or not'))
      .addStringOption((activationRegexOption) => activationRegexOption.setName('activation-regex')
        .setDescription('Regex that triggers the response'))
      .addStringOption((captureRegexOption) => captureRegexOption.setName('capture-regex')
        .setDescription('Regex for capturing and grouping terms within the original text.'))
      .addStringOption((outputTemplateOption) => outputTemplateOption.setName('output-template')
        .setDescription('String for formatted output. Use {1}, {2}..., to use captured groups')))
    .addSubcommand((removeSubcommand) => removeSubcommand.setName('remove')
      .setDescription('Remove a response')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the response to remove')
        .setRequired(true)))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
      .setDescription('View current settings for a given response')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the response to view'))),
  async execute(interaction: ChatInputCommandInteraction, serverConfig: ServerConfig): Promise<ServerConfig | void> {
    if (serverConfig === undefined) { console.error('Server is undefined'); return; }

    const subCommandGroup = interaction.options.getSubcommandGroup();
    const subCommand = interaction.options.getSubcommand();

    if (subCommand === 'create') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')! ?? false;
      const activationRegex = interaction.options.getString('activation-regex')!;
      const captureRegex = interaction.options.getString('capture-regex')!;
      const outputTemplate = interaction.options.getString('output-template')!;

      if (serverConfig.serverResponses.findIndex((r) => r.name === nameOption) !== -1) {
        interaction.reply({ content: 'There is already a response with this name. Choose another and try again', flags: MessageFlags.Ephemeral });
        return;
      }

      const newResponse: Response = {
        name: nameOption,
        enabled: enabledOption,
        activationRegex,
        captureRegex,
        outputTemplateString: outputTemplate,
      };

      serverConfig.serverResponses.push(newResponse);

      interaction.reply({ content: 'Successfully created response', embeds: [responseEmbedBuilder(newResponse)], flags: MessageFlags.Ephemeral });

      return serverConfig;
    }

    if (subCommand === 'edit') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled');
      const activationRegex = interaction.options.getString('activation-regex');
      const captureRegex = interaction.options.getString('capture-regex');
      const outputTemplate = interaction.options.getString('output-template');

      // if user hasn't specified any attributes
      if (enabledOption === null && !activationRegex && !captureRegex && !outputTemplate) {
        interaction.reply({ content: 'You must select at least one attribute to edit!', flags: MessageFlags.Ephemeral });

        return;
      }

      const referencedResponseIndex = serverConfig.serverResponses.findIndex((r) => r.name === nameOption);
      if (referencedResponseIndex === -1) {
        interaction.reply({ content: 'No server responses with that name were found. Ensure you spelled it correctly!', flags: MessageFlags.Ephemeral });

        return;
      }

      const referencedResponse = serverConfig.serverResponses[referencedResponseIndex];

      if (enabledOption !== null) {
        referencedResponse.enabled = enabledOption;
      }

      referencedResponse.activationRegex = activationRegex ?? referencedResponse.activationRegex;
      referencedResponse.captureRegex = captureRegex ?? referencedResponse.captureRegex;
      referencedResponse.outputTemplateString = outputTemplate ?? referencedResponse.outputTemplateString;

      serverConfig.serverResponses[referencedResponseIndex] = referencedResponse;

      interaction.reply({ content: 'Successfully edited response!', flags: MessageFlags.Ephemeral });

      return serverConfig;
    }

    if (subCommand === 'view') {
      const nameOption = interaction.options.getString('name')!;

      const referencedResponse = serverConfig.serverResponses.find((r) => r.name === nameOption);
      if (!referencedResponse) { // none specified, so we'll view all
        const embeds = serverConfig.serverResponses.map((response) => responseEmbedBuilder(response));

        if (embeds.length === 0) {
          interaction.reply({ content: 'There are zero responses', flags: MessageFlags.Ephemeral });
          return;
        }

        interaction.reply(({ embeds, flags: MessageFlags.Ephemeral }));
        return;
      }

      interaction.reply(({ embeds: [responseEmbedBuilder(referencedResponse)], flags: MessageFlags.Ephemeral }));
      return;
    }

    if (subCommand === 'remove') {
      const nameOption = interaction.options.getString('name')!;

      const referencedResponseIndex = serverConfig.serverResponses.findIndex((r) => r.name === nameOption);

      if (referencedResponseIndex === -1) {
        interaction.reply({ content: 'No server responses with that name were found. Ensure you spelled it correctly!', flags: MessageFlags.Ephemeral });
        return;
      }

      serverConfig.serverResponses.splice(referencedResponseIndex, 1);

      interaction.reply({ content: 'Successfully removed response', flags: MessageFlags.Ephemeral });

      return serverConfig;
    }
  },
};

commandMap.set(Help.data.name, Help);
commandMap.set(ConfigCommand.data.name, ConfigCommand);
commandMap.set(ResponseCommand.data.name, ResponseCommand);

export { commandMap, Help, ConfigCommand, HeartBoardFeature, VoicePingFeature };
