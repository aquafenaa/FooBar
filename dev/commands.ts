import {
  ChatInputCommandInteraction,
  Snowflake, AutocompleteInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
  ChannelType,
} from 'discord.js';
import { Command, ConfigCommand, Feature } from './types/bot';
import { deleteAllHeartBoardEmojis, deleteHeartBoard, getChatbot, getHeartBoard, getHeartBoardEmojis, getHeartBoardsByServer, getVoicePing, getVoicePingsByServer, insertHeartBoard, insertHeartBoardEmoji, insertVoicePing, insertVoicePingInput, updateHeartBoard, updateVoicePing } from './data';
import { HeartBoardTable, VoicePingTable } from './types/schema';

const commandMap: Map<string, Command> = new Map();
const featureMap: Map<string, Feature> = new Map();

const AIFeature: Feature = {
  name: 'ai-messages',
  description: 'When pinged or replied to, the bot generates an LLM response',
  configEmbedBuilder(title: string, serverID: Snowflake) {
    const chatbot = getChatbot(serverID);

    return new EmbedBuilder()
      .setTitle(title)
      .addFields(
        { name: 'Enabled', value: (chatbot?.chatbot_enabled ? 'Yes' : 'No') },
      );
  },
};

// const VoicePingFeature: Feature = {
//   name: 'voice-ping',
//   description: 'Sends a message when a user joins a voice channel',
//   configEmbedBuilder(title: string, serverID: Snowflake) {
//     const voicePing = getVoicePing(serverID);
//     const { enabled, voicePingMessage, inputChannels, outputChannel } = serverConfig.voicePing;

//     return new EmbedBuilder()
//       .setTitle(title)
//       .addFields(
//         { name: 'Enabled', value: (enabled ? 'Yes' : 'No') },
//         { name: 'Message', value: voicePingMessage ?? 'No message set' },
//         { name: 'Listener Channels', value: inputChannels && inputChannels.length > 0 ? inputChannels?.map((id) => `<#${id}>`)?.join(', ') : 'No channels set' },
//         { name: 'Log Channel', value: outputChannel ? `<#${outputChannel}>` : 'No channel set' },
//       );
//   },
// };

// set features before config so that we can generate feature name choices
// featureMap.set(HeartBoardFeature.name, HeartBoardFeature);
// featureMap.set(VoicePingFeature.name, VoicePingFeature);
featureMap.set(AIFeature.name, AIFeature);

const HeartboardCommand: ConfigCommand = {
  data: new SlashCommandBuilder()
    .setName('heartboard')
    .setDescription('A board that keeps track of all messages above a threshold of reactions')
    .addSubcommand((listSubcommand) => listSubcommand.setName('list')
      .setDescription('Lists existing boards in the server'))
    .addSubcommand((statusSubcommand) => statusSubcommand.setName('status')
      .setDescription('Enable or disable')
      .addStringOption((heartboardNameOption) => heartboardNameOption.setName('name')
        .setDescription('Name of the board you wish to enable/disable')
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether to enable or disable the option. True = Enable')
        .setRequired(true)))
    .addSubcommand((createSubcommand) => createSubcommand.setName('create')
      .setDescription('Create a new Heartboard')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name for the new board')
        .setRequired(true))
      .addStringOption((emojisOption) => emojisOption.setName('emojis')
        .setDescription('List of emojis the board should listen for. Separate each using commas')
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the board should be enabled or not')
        .setRequired(true))
      .addBooleanOption((denyAuthorOption) => denyAuthorOption.setName('deny-author')
        .setDescription('Whether to stop the author of the message from adding a board reaction')
        .setRequired(true))
      .addIntegerOption((thresholdOption) => thresholdOption.setName('threshold')
        .setDescription('What threshold should of reactions should trigger the board')
        .setMinValue(1)
        .setRequired(true))
      .addChannelOption((outputChannelOption) => outputChannelOption.setName('output-channel')
        .setDescription('The channel to send the message is highlighted in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread)
        .setRequired(true)))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
      .setDescription('Edit the settings of an existing board')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('The name of the board to edit')
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the board is enabled or not (True = enabled)'))
      .addStringOption((emojisOption) => emojisOption.setName('emojis')
        .setDescription('List of emojis the board should listen for. Separate each using commas'))
      .addBooleanOption((denyAuthorOption) => denyAuthorOption.setName('deny-author')
        .setDescription('Whether to stop the author of the message from adding a board reaction'))
      .addIntegerOption((thresholdOption) => thresholdOption.setName('threshold')
        .setDescription('What threshold should of reactions should trigger the board')
        .setMinValue(1))
      .addChannelOption((outputChannelOption) => outputChannelOption.setName('output-channel')
        .setDescription('The channel to send the message is highlighted in')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread)))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
      .setDescription('Delete a heartboard')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the heartboard to delete')
        .setAutocomplete(true)
        .setRequired(true)))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
      .setDescription('View the current settings of a heartboard')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name for the heartboard settings to view')
        .setAutocomplete(true)
        .setRequired(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake) {
    const subCommand = interaction.options.getSubcommand();

    if (subCommand === 'list') {
      const heartBoards = getHeartBoardsByServer(serverID);
      if (!heartBoards) {
        interaction.reply({ content: 'There are currently no heartboards on this server.', flags: MessageFlags.Ephemeral });
        return;
      }

      const heartboardFields = heartBoards.map((heartboard) => ({
        name: `${heartboard.board_name} (${heartboard.enabled ? '✔' : '✘'})`,
        value: getHeartBoardEmojis(serverID, heartboard.board_name).join(', '),
      }));
      const embed = new EmbedBuilder().setTitle('Heartboards').addFields(...heartboardFields);

      interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (subCommand === 'status') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')!;

      try {
        const heartBoard = getHeartBoard(serverID, nameOption);

        if (!heartBoard) {
          interaction.reply({ content: 'There is no heartboard with that name', flags: MessageFlags.Ephemeral });
          return;
        }

        heartBoard.enabled = enabledOption;
        updateHeartBoard(heartBoard);

        interaction.reply({ content: 'Successfully updated heartboard', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error updating the board. Please try again later.', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'create') {
      const nameOption = interaction.options.getString('name')!;
      const emojisOption = interaction.options.getString('emojis')!.replace(/\s+/g, '').split(',');
      const enabledOption = interaction.options.getBoolean('enabled')!;
      const denyAuthorOption = interaction.options.getBoolean('deny-author')!;
      const thresholdOption = interaction.options.getInteger('threshold')!;
      const outputChannelOption = interaction.options.getChannel('output-channel')!;

      const outputChannel = await interaction.guild!.channels.fetch(outputChannelOption.id);
      if (!outputChannel || !outputChannel.isSendable()) {
        interaction.reply({ content: 'Please ensure that the output channel exists and that the bot can send messages to it!', flags: MessageFlags.Ephemeral });
        return;
      }

      const heartboard: HeartBoardTable = {
        server_id: serverID,
        board_name: nameOption,
        enabled: enabledOption,
        deny_author: denyAuthorOption,
        threshold: thresholdOption,
        output_channel: outputChannel.id,
      };

      try {
        insertHeartBoard(heartboard);
        emojisOption.forEach((emoji) => {
          insertHeartBoardEmoji({
            server_id: serverID,
            board_name: heartboard.board_name,
            emoji: emoji.toString(),
          });
        });

        interaction.reply({ content: 'Successfully create heartboard!', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error creating the board. Please try again later!', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'edit') {
      const nameOption = interaction.options.getString('name')!;
      const emojisOption = interaction.options.getString('emojis')?.replace(/\s+/g, '').split(',');
      const enabledOption = interaction.options.getBoolean('enabled');
      const denyAuthorOption = interaction.options.getBoolean('deny-author');
      const thresholdOption = interaction.options.getInteger('threshold');
      const outputChannelOption = interaction.options.getChannel('output-channel');

      if (!emojisOption && !enabledOption && denyAuthorOption === null && thresholdOption === null && outputChannelOption === null) {
        interaction.reply({ content: 'You must edit at least a single parameter!', flags: MessageFlags.Ephemeral });
        return;
      }

      const heartBoard = getHeartBoard(serverID, nameOption);
      if (!heartBoard) {
        interaction.reply({ content: 'There is no heartboard with this name.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (emojisOption) {
        deleteAllHeartBoardEmojis(serverID, heartBoard.board_name);
        emojisOption.forEach((emoji) => {
          insertHeartBoardEmoji({
            server_id: serverID,
            board_name: heartBoard.board_name,
            emoji: emoji.toString(),
          });
        });
      }
      if (outputChannelOption) {
        const outputChannel = await interaction.guild!.channels.fetch(outputChannelOption.id ?? 'unknown');
        if (!outputChannel || !outputChannel.isSendable()) {
          interaction.reply({ content: 'Please ensure that the output channel exists and that the bot can send messages to it!', flags: MessageFlags.Ephemeral });
          return;
        }

        heartBoard.output_channel = outputChannel.id;
      }

      if (enabledOption !== null) {
        heartBoard.enabled = enabledOption;
      }
      if (denyAuthorOption !== null) {
        heartBoard.deny_author = denyAuthorOption;
      }
      if (thresholdOption !== null) {
        heartBoard.threshold = thresholdOption;
      }

      try {
        updateHeartBoard(heartBoard);
        interaction.reply({ content: 'Successfully updated heartboard!', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error when editing the heartboard. Please try again later. ', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'delete') {
      const nameOption = interaction.options.getString('name')!;
      const heartBoard = getHeartBoard(serverID, nameOption);

      if (!heartBoard) {
        interaction.reply({ content: 'There is no heatboard with this name.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        deleteHeartBoard(serverID, heartBoard.board_name);
        interaction.reply({ content: 'Successfully deleted heartboard.', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was error deleting the heartboard. Please try again later.', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'view') {
      const nameOption = interaction.options.getString('name')!;

      const heartBoard = getHeartBoard(serverID, nameOption);
      if (!heartBoard) {
        interaction.reply({ content: 'There is no heartboard with this name.', flags: MessageFlags.Ephemeral });
        return;
      }

      const embed = HeartboardCommand.configEmbedBuilder(serverID, heartBoard);
      interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
    }
  },
  configEmbedBuilder(serverID: Snowflake, heartBoard: HeartBoardTable): EmbedBuilder {
    const heartboardEmojis = getHeartBoardEmojis(serverID, heartBoard.board_name).map((emoji) => emoji.emoji).join(', ');

    return new EmbedBuilder().setTitle(`${heartBoard.board_name}`)
      .addFields([
        { name: 'Status', value: heartBoard.enabled ? 'Enabled' : 'Disabled' },
        { name: 'Emojis', value: heartboardEmojis },
        { name: 'Deny Author', value: heartBoard.deny_author ? 'True' : 'False' },
        { name: 'Threshold', value: `${heartBoard.threshold}` },
      ]);
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused();

    const heartBoards = getHeartBoardsByServer(serverID);
    const choices = heartBoards.map((heartBoard) => heartBoard.board_name);

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue));
    interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
  },
};

const VoicePingCommand: ConfigCommand = {
  data: new SlashCommandBuilder().setName('voiceping')
    .setDescription('Pings users when someone joins a specified voice channel')
    .addSubcommand((listSubcommand) => listSubcommand.setName('list')
      .setDescription('List all existing voice pings'))
    .addSubcommand((statusSubcommand) => statusSubcommand.setName('status')
      .setDescription('Enable or disable a given voice ping')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the voice ping you wish to enable / disable')
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether to enable or disable the voice ping. True = Enable')
        .setRequired(true)))
    .addSubcommand((createSubcommand) => createSubcommand.setName('create')
      .setDescription('Create a new voice ping')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the new voice ping')
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the VoicePing should be enabled or disabled. True = Enable')
        .setRequired(true))
      .addStringOption((messageOption) => messageOption.setName('message-template')
        .setDescription('Message used when pinged. Use \'{user}\' for user, \'{channel}\' for channel')
        .setRequired(true))
      .addStringOption((inputChannelOption) => inputChannelOption.setName('input-channels')
        .setDescription('Voice channels to listen to. Give channel ID\'s, separated with \',\'')
        .setRequired(true))
      .addChannelOption((outputChannelOption) => outputChannelOption.setName('output-channel')
        .setDescription('Channel the ping message should be sent in.')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread)
        .setRequired(true)))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
      .setDescription('Edit an existing VoicePing')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the existing VoicePing')
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the VoicePing should be enabled or disabled. True = Enable'))
      .addStringOption((messageTemplateOption) => messageTemplateOption.setName('message-template')
        .setDescription('Message used when pinged. Use \'{user}\' for user, \'{channel}\' for channel'))
      .addChannelOption((outputChannelOption) => outputChannelOption.setName('output-channel')
        .setDescription('Channel the ping message should be sent in.')
        .addChannelTypes(ChannelType.GuildText, ChannelType.GuildAnnouncement, ChannelType.PublicThread))
      .addStringOption((inputChannelOption) => inputChannelOption.setName('input-channels')
        .setDescription('Voice channels to listen to. Give channel ID\'s, separated with \',\'')))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
      .setDescription('Delete an existing VoicePing')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the existing VoicePing')
        .setAutocomplete(true)
        .setRequired(true)))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
      .setDescription('View the settings of an existing VoicePing')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the existing VoicePing you wish to view')
        .setAutocomplete(true)
        .setRequired(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake) {
    const subCommand = interaction.options.getSubcommand();

    if (subCommand === 'list') {
      const voicePings = getVoicePingsByServer(serverID);
      if (!voicePings) {
        interaction.reply({ content: 'There are currently no VoicePings on this server.', flags: MessageFlags.Ephemeral });
        return;
      }

      const voicepingFields = voicePings.map((voicePing) => ({
        name: `${voicePing.voiceping_name} (${voicePing.enabled ? '✔' : '✘'})`,
        value: `<#${voicePing.output_channel}>`,
      }));
      const embed = new EmbedBuilder().setTitle('VoicePings').addFields(...voicepingFields);

      interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (subCommand === 'status') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')!;

      try {
        const voicePing = getVoicePing(serverID, nameOption);

        if (!voicePing) {
          interaction.reply({ content: 'There is no VoicePings with that name', flags: MessageFlags.Ephemeral });
          return;
        }

        voicePing.enabled = enabledOption;
        updateVoicePing(voicePing);

        interaction.reply({ content: 'Successfully updated VoicePing', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error updating the VoicePing. Please try again later.', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'create') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')!;
      const messageTemplateOption = interaction.options.getString('message-template')!;
      const inputChannelsOption = interaction.options.getString('input-channels')!.replace(/\s+/g, '').split(',');
      const outputChannelOption = interaction.options.getChannel('output-channel')!;

      const outputChannel = await interaction.guild!.channels.fetch(outputChannelOption.id);
      if (!outputChannel || !outputChannel.isSendable()) {
        interaction.reply({ content: 'Please ensure that the output channel exists and that the bot can send messages to it!', flags: MessageFlags.Ephemeral });
        return;
      }
      const inputChannels = (await Promise.all(inputChannelsOption.map((channelID) => interaction.guild!.channels.fetch(channelID))))
        .filter((channelID) => channelID !== null);

      const voicePing: VoicePingTable = {
        server_id: serverID,
        voiceping_name: nameOption,
        enabled: enabledOption,
        message_template: messageTemplateOption,
        output_channel: outputChannel.id,
      };

      try {
        insertVoicePing(voicePing);
        inputChannels.forEach((channel) => {
          insertVoicePingInput({
            server_id: serverID,
            voiceping_name: voicePing.voiceping_name,
            channel_id: channel.id,
          });
        });

        interaction.reply({ content: 'Successfully created VoicePing!', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error creating the ping. Please try again later!', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'edit') {
      const gg = interaction.options.getString('name')!;
      const dd = interaction.options.getString('emojis')?.replace(/\s+/g, '').split(',');
      const aa = interaction.options.getBoolean('enabled');
      const cc = interaction.options.getBoolean('deny-author');
      const ff = interaction.options.getInteger('threshold');
      const ee = interaction.options.getChannel('output-channel');

      if (!emojisOption && !enabledOption && denyAuthorOption === null && thresholdOption === null && outputChannelOption === null) {
        interaction.reply({ content: 'You must edit at least a single parameter!', flags: MessageFlags.Ephemeral });
        return;
      }

      const heartBoard = getHeartBoard(serverID, nameOption);
      if (!heartBoard) {
        interaction.reply({ content: 'There is no heartboard with this name.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (emojisOption) {
        deleteAllHeartBoardEmojis(serverID, heartBoard.board_name);
        emojisOption.forEach((emoji) => {
          insertHeartBoardEmoji({
            server_id: serverID,
            board_name: heartBoard.board_name,
            emoji: emoji.toString(),
          });
        });
      }
      if (outputChannelOption) {
        const outputChannel = await interaction.guild!.channels.fetch(outputChannelOption.id ?? 'unknown');
        if (!outputChannel || !outputChannel.isSendable()) {
          interaction.reply({ content: 'Please ensure that the output channel exists and that the bot can send messages to it!', flags: MessageFlags.Ephemeral });
          return;
        }

        heartBoard.output_channel = outputChannel.id;
      }

      if (enabledOption !== null) {
        heartBoard.enabled = enabledOption;
      }
      if (denyAuthorOption !== null) {
        heartBoard.deny_author = denyAuthorOption;
      }
      if (thresholdOption !== null) {
        heartBoard.threshold = thresholdOption;
      }

      try {
        updateHeartBoard(heartBoard);
        interaction.reply({ content: 'Successfully updated heartboard!', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error when editing the heartboard. Please try again later. ', flags: MessageFlags.Ephemeral });
        return;
      }
    }
  },
  configEmbedBuilder(serverID: Snowflake, voicePing: VoicePingTable) {
    return new EmbedBuilder();
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused();

    const voicePings = getVoicePingsByServer(serverID);
    const choices = voicePings.map((voicePing) => voicePing.voiceping_name);

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue));
    interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
  },
};

const SettingsCommand: Command = {
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

function responseEmbedBuilder(response: AutomaticResponse): EmbedBuilder {
  return new EmbedBuilder()
    .setTitle(`${response.name} response`)
    .addFields([
      { name: 'Enabled', value: response.enabled ? 'Yes' : 'No' },
      { name: 'Activation Regex', value: response.activationRegex },
      { name: 'Capture Regex', value: response.captureRegex ?? 'None' },
      { name: 'Output Template', value: response.outputTemplateString },
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

      const newResponse: AutomaticResponse = {
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

commandMap.set(HeartboardCommand.data.name, HeartboardCommand);
commandMap.set(VoicePingCommand.data.name, VoicePingCommand);
commandMap.set(SettingsCommand.data.name, SettingsCommand);
commandMap.set(ResponseCommand.data.name, ResponseCommand);

export { commandMap, SettingsCommand, ResponseCommand, HeartboardCommand, VoicePingCommand };
