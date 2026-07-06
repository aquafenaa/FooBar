import {
  ChatInputCommandInteraction,
  Snowflake, AutocompleteInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
  ChannelType,
} from 'discord.js';
import { Command, ConfigCommand, Feature } from './types/bot';
import { deleteAllHeartBoardEmojis, deleteAllVoicePingInputs, deleteAutomaticResponse, deleteHeartBoard, deleteVoicePing, getAutomaticResponse, getAutomaticResponsesByServer, getChatbot, getHeartBoard, getHeartBoardEmojis, getHeartBoardsByServer, getVoicePing, getVoicePingInputs, getVoicePingsByServer, insertAutomaticResponse, insertHeartBoard, insertHeartBoardEmoji, insertVoicePing, insertVoicePingInput, updateAutomaticResponse, updateHeartBoard, updateVoicePing, upsertChatbot } from './data';
import { AutomaticResponseTable, HeartBoardTable, VoicePingTable } from './types/schema';

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
//       .setTitle(titx le)
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

      if (enabledOption === null && denyAuthorOption === null && !emojisOption && !thresholdOption && !outputChannelOption) {
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
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled');
      const messageTemplateOption = interaction.options.getString('message-template');
      const inputChannelStringsOption = interaction.options.getString('input-channels')?.replace(/\s+/g, '')?.split(',');
      const outputChannelOption = interaction.options.getChannel('output-channel');

      if (enabledOption === null && !messageTemplateOption && !outputChannelOption && !inputChannelStringsOption) {
        interaction.reply({ content: 'You must edit at least a single parameter!', flags: MessageFlags.Ephemeral });
        return;
      }

      const voicePing = getVoicePing(serverID, nameOption);
      if (!voicePing) {
        interaction.reply({ content: 'There is no voiceping with this name.', flags: MessageFlags.Ephemeral });
        return;
      }

      if (inputChannelStringsOption) {
        // only implement valid channels
        const inputChannels = (await Promise.all(inputChannelStringsOption.map((channelString) => interaction.guild!.channels.fetch(channelString))))
          .filter((channel) => channel !== null);

        deleteAllVoicePingInputs(serverID, voicePing.voiceping_name);
        inputChannels.forEach((inputChannel) => {
          insertVoicePingInput({
            server_id: serverID,
            voiceping_name: voicePing.voiceping_name,
            channel_id: inputChannel.id,
          });
        });
      }
      if (outputChannelOption) {
        const outputChannel = await interaction.guild!.channels.fetch(outputChannelOption.id ?? 'unknown');
        if (!outputChannel || !outputChannel.isSendable()) {
          interaction.reply({ content: 'Please ensure that the output channel exists and that the bot can send messages to it!', flags: MessageFlags.Ephemeral });
          return;
        }

        voicePing.output_channel = outputChannel.id;
      }

      if (enabledOption !== null) {
        voicePing.enabled = enabledOption;
      }
      if (messageTemplateOption) {
        voicePing.message_template = messageTemplateOption;
      }

      try {
        updateVoicePing(voicePing);
        interaction.reply({ content: 'Successfully updated voiceping!', flags: MessageFlags.Ephemeral });
        return;
      } catch (exception) {
        interaction.reply({ content: 'There was an error when editing the voiceping. Please try again later. ', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'delete') {
      const nameOption = interaction.options.getString('name')!;

      const voicePing = getVoicePing(serverID, nameOption);
      if (!voicePing) {
        interaction.reply({ content: 'There is no VoicePing with this name! Ensure it\'s spelled correctly.', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        deleteVoicePing(serverID, nameOption);
        interaction.reply({ content: 'Successfully deleted VoicePing', flags: MessageFlags.Ephemeral });
        return;
      } catch {
        interaction.reply({ content: 'There was an issue when deleting the VoicePing. Please try again later.', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subCommand === 'view') {
      const nameOption = interaction.options.getString('name')!;

      const voicePing = getVoicePing(serverID, nameOption);
      if (!voicePing) {
        interaction.reply({ content: 'There is no VoicePing with this name! Ensure it\'s spelled correctly.', flags: MessageFlags.Ephemeral });
        return;
      }

      const configEmbed = VoicePingCommand.configEmbedBuilder(serverID, voicePing);
      interaction.reply({ embeds: [configEmbed] });
    }
  },
  configEmbedBuilder(serverID: Snowflake, voicePing: VoicePingTable) {
    const voicePingInputChannels = getVoicePingInputs(serverID, voicePing.voiceping_name).map((channel) => `<#${channel.channel_id}>`).join(', ');

    return new EmbedBuilder().setTitle(`${voicePing.voiceping_name}`)
      .addFields([
        { name: 'Status', value: voicePing.enabled ? 'Enabled' : 'Disabled' },
        { name: 'Input Channels', value: voicePingInputChannels },
        { name: 'Message Template', value: voicePing.message_template },
        { name: 'Output Channel', value: `${voicePing.output_channel !== '' ? `<#${voicePing.output_channel}>` : ''}` },
      ]);
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused();

    const voicePings = getVoicePingsByServer(serverID);
    const choices = voicePings.map((voicePing) => voicePing.voiceping_name);

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue));
    interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
  },
};

const ResponseCommand: ConfigCommand = {
  data: new SlashCommandBuilder()
    .setName('response').setDescription('A response is an automated, generated response, upon a specific phrase.')
    .addSubcommand((listSubcommand) => listSubcommand.setName('list')
      .setDescription('List all existing Responses'))
    .addSubcommand((statusSubcommand) => statusSubcommand.setName('status')
      .setDescription('Set status of an existing Response')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the Response you wish to change the status of')
        .setAutocomplete(true)
        .setRequired(true))
      .addBooleanOption((enabledOption) => enabledOption.setName('enabled')
        .setDescription('Whether the Response should be enabled or not. True = Enable')
        .setRequired(true)))
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
        .setAutocomplete(true)
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
        .setDescription('Name of the response to view')
        .setAutocomplete(true)
        .setRequired(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
    if (serverID === undefined) { console.error('Server is undefined'); return; }

    const subCommand = interaction.options.getSubcommand();

    if (subCommand === 'list') {
      const responses = getAutomaticResponsesByServer(serverID);

      if (!responses || responses.length === 0) {
        interaction.reply({ content: 'There are zero Responses on this server!', flags: MessageFlags.Ephemeral });
        return;
      }

      const responseEmbeds = responses.map((response) => ResponseCommand.configEmbedBuilder(serverID, response));
      interaction.reply({ embeds: responseEmbeds, flags: MessageFlags.Ephemeral });
      return;
    }

    if (subCommand === 'status') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')! ?? false;

      const referencedResponse = getAutomaticResponse(serverID, nameOption);
      if (!referencedResponse) {
        interaction.reply({ content: 'There are no existing Responses with this name! Ensure you spelled it correctly.', flags: MessageFlags.Ephemeral });
        return;
      }

      referencedResponse.enabled = enabledOption;

      try {
        updateAutomaticResponse(referencedResponse);
        interaction.reply({ content: 'Successfully edited Response!', embeds: [ResponseCommand.configEmbedBuilder(serverID, referencedResponse)], flags: MessageFlags.Ephemeral });
        return;
      } catch {
        interaction.reply({ content: 'There was an error editing the Response! Please try again later.', flags: MessageFlags.Ephemeral });
        return;
      }
    }

    if (subCommand === 'create') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')! ?? false;
      const activationRegex = interaction.options.getString('activation-regex')!;
      const captureRegex = interaction.options.getString('capture-regex')!;
      const outputTemplate = interaction.options.getString('output-template')!;

      if (getAutomaticResponse(serverID, nameOption)) {
        interaction.reply({ content: 'There is already a response with this name. Please try again with a unique name', flags: MessageFlags.Ephemeral });
        return;
      }

      const newResponse: AutomaticResponseTable = {
        server_id: serverID,
        name: nameOption,
        enabled: enabledOption,
        activation_regex: activationRegex,
        capture_regex: captureRegex,
        output_template: outputTemplate,
      };

      insertAutomaticResponse(newResponse);

      interaction.reply({ content: 'Successfully created response!', embeds: [ResponseCommand.configEmbedBuilder(serverID, newResponse)], flags: MessageFlags.Ephemeral });
      return;
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

      const referencedResponse = getAutomaticResponse(serverID, nameOption);
      if (!referencedResponse) {
        interaction.reply({ content: 'No server responses with that name were found. Ensure you spelled it correctly!', flags: MessageFlags.Ephemeral });
        return;
      }

      if (enabledOption !== null) {
        referencedResponse.enabled = enabledOption;
      }

      if (activationRegex) {
        referencedResponse.activation_regex = activationRegex;
      }
      if (captureRegex) {
        referencedResponse.capture_regex = captureRegex;
      }
      if (outputTemplate) {
        referencedResponse.output_template = outputTemplate;
      }

      try {
        updateAutomaticResponse(referencedResponse);
        interaction.reply({ content: 'Successfully edited the Response!', embeds: [ResponseCommand.configEmbedBuilder(serverID, referencedResponse)], flags: MessageFlags.Ephemeral });
        return;
      } catch {
        interaction.reply({ content: 'There was an error when attempting to edit the Response. Please try again later. ', flags: MessageFlags.Ephemeral });
        return;
      }
    }

    if (subCommand === 'view') {
      const nameOption = interaction.options.getString('name')!;

      const referencedResponse = getAutomaticResponse(serverID, nameOption);
      if (!referencedResponse) { // none specified, so we'll view all
        interaction.reply({ content: 'There are no Responses with that name! Ensure you spelled it correctly.', flags: MessageFlags.Ephemeral });
        return;
      }

      interaction.reply(({ embeds: [ResponseCommand.configEmbedBuilder(serverID, referencedResponse)], flags: MessageFlags.Ephemeral }));
      return;
    }

    if (subCommand === 'remove') {
      const nameOption = interaction.options.getString('name')!;

      const referencedResponse = getAutomaticResponse(serverID, nameOption);

      if (!referencedResponse) {
        interaction.reply({ content: 'No server responses with that name were found. Ensure you spelled it correctly!', flags: MessageFlags.Ephemeral });
        return;
      }

      try {
        deleteAutomaticResponse(serverID, nameOption);
        interaction.reply({ content: 'Successfully removed response!', flags: MessageFlags.Ephemeral });
      } catch {
        interaction.reply({ content: 'There was an error when deleting this Response! Please try again later.', flags: MessageFlags.Ephemeral });
      }
    }
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused();

    const responses = getAutomaticResponsesByServer(serverID);
    const choices = responses.map((response) => response.name);

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue));
    interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
  },
  configEmbedBuilder(serverID: Snowflake, automaticResponse: AutomaticResponseTable) {
    return new EmbedBuilder().setTitle(automaticResponse.name)
      .addFields([
        { name: 'Status', value: automaticResponse.enabled ? 'Enabled' : 'Disabled' },
        { name: 'Activation Phrase', value: automaticResponse.activation_regex },
        { name: 'Capture Regex', value: automaticResponse.capture_regex },
        { name: 'Output Channel', value: automaticResponse.output_template },
      ]);
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
    .addSubcommand((viewSubcommandGroup) => viewSubcommandGroup.setName('view')
      .setDescription('View current config settings of a feature')
      .addStringOption((viewFeatureName) => viewFeatureName.setName('feature-name')
        .setDescription('Name of the feature you wish to view')
        .setRequired(true)
        .addChoices(Array.from(featureMap.values()).map((feature) => ({ name: feature.name, value: feature.name }))))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
    if (serverID === undefined) { console.error('Server is undefined'); return; }

    const subCommand = interaction.options.getSubcommand();

    if (subCommand === 'status') {
      const enabledOption = interaction.options.getBoolean('enabled')!;
      const featureNameOption = interaction.options.getString('feature-name')!;
      const feature = featureMap.get(featureNameOption)!;

      if (featureNameOption === AIFeature.name) {
        let chatbot = getChatbot(serverID);
        if (!chatbot) {
          chatbot = {
            server_id: serverID,
            chatbot_enabled: enabledOption,
            chatbot_core_memory: '',
          };
          upsertChatbot(chatbot);
        } else if (enabledOption !== chatbot.chatbot_enabled) {
          chatbot.chatbot_enabled = enabledOption;
          upsertChatbot(chatbot);
        }
      }

      interaction.reply({ embeds: [feature.configEmbedBuilder('Updated Config', serverID)], flags: MessageFlags.Ephemeral });
    } else if (subCommand === 'view') {
      const featureNameOption = interaction.options.getString('feature-name')!;
      const feature = featureMap.get(featureNameOption)!;

      await interaction.reply({
        embeds: [feature.configEmbedBuilder('Current Config', serverID)],
        flags: MessageFlags.Ephemeral,
      });
    }
  },
};

commandMap.set(HeartboardCommand.data.name, HeartboardCommand);
commandMap.set(VoicePingCommand.data.name, VoicePingCommand);
commandMap.set(SettingsCommand.data.name, SettingsCommand);
commandMap.set(ResponseCommand.data.name, ResponseCommand);

export { commandMap, SettingsCommand, ResponseCommand, HeartboardCommand, VoicePingCommand };
