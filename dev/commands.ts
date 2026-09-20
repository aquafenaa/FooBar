import {
  ChatInputCommandInteraction,
  Snowflake, AutocompleteInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
} from 'discord.js';
import cron from 'node-cron';
import { Command, ConfigCommand } from './types/bot';
import { addChatbotSubscriber, addReminder, deleteAllHeartBoardEmojis, deleteAllVoicePingInputs, deleteAutomaticResponse, deleteChatbot,
  deleteChatbotLongTermMemory, deleteHeartBoard, deleteNOldestShortTermMemory, deleteReminder, deleteVoicePing, getAutomaticResponse, getAutomaticResponsesByServer, getChatbot,
  getChatbotLongTermMemoriesByServer, getChatbotLongTermMemory, getChatbotShortTermMemoriesByServer, getHeartBoard, getHeartBoardEmojis, getHeartBoardsByServer, getReminder, getRemindersByServer, getVoicePing,
  getVoicePingInputs, getVoicePingsByServer, insertAutomaticResponse, insertChatbotLongTermMemory, insertHeartBoard, insertHeartBoardEmoji,
  insertVoicePing, insertVoicePingInput, isChatbotSubscriber, removeChatbotSubscriber, setChatbotPrompt, updateAutomaticResponse, updateChatbotLongTermMemory,
  updateHeartBoard, updateReminder, updateVoicePing, upsertChatbot } from './data';
import { AutomaticResponseTable, ChatbotTable, ReminderTable, HeartBoardTable, VoicePingTable } from './types/schema';
import { getDefaultSystemPrompt } from './chatbot';
import { inputToSchedule, sendReminder } from './utils';

const commandMap: Map<string, Command> = new Map();

const ChatbotCommand: ConfigCommand = {
  data: new SlashCommandBuilder()
    .setName('chatbot').setDescription('Chatbot for the server.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((createSubcommand) => createSubcommand.setName('create')
      .setDescription('Create the chatbot for a server that doesn\'t currently have one.'))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
      .setDescription('Remove the chatbot for a server that already has one.'))
    .addSubcommand((toolSubcommand) => toolSubcommand.setName('tools').setDescription('Whether the bot is able to use tools or not')
      .addBooleanOption((enabledOption) => enabledOption.setName('enable').setDescription('Enable or disable tool use. True = Enable, False = Disable')
        .setRequired(true)))
    .addSubcommandGroup((promptSubcommandGroup) => promptSubcommandGroup.setName('prompt')
      .setDescription('Set or delete the system prompt for the chatbot.')
      .addSubcommand((setPromptSubcommand) => setPromptSubcommand.setName('set')
        .setDescription('Set the system prompt.'))
      .addSubcommand((deletePromptSubcommand) => deletePromptSubcommand.setName('delete')
        .setDescription('Delete the system prompt.')))
    .addSubcommand((clearMemoryCommand) => clearMemoryCommand.setName('clear-memory').setDescription('Clears the memory of the bot')
      .addBooleanOption((confirmationOption) => confirmationOption.setName('confirmation').setDescription('Are you sure you wish to clear the memory? True = Yes, False = No.')))
    .addSubcommandGroup((coreMemoryGroup) => coreMemoryGroup.setName('core-memory')
      .setDescription('View, edit, and delete the longterm memory for the chatbot.')
      .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
        .setDescription('Edit the core memory for the chatbot'))
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view').setDescription('View the current core memory.')))
    .addSubcommandGroup((longtermMemoryGroup) => longtermMemoryGroup.setName('longterm-memory')
      .setDescription('View, and delete the longterm memory for the chatbot.')
      .addSubcommand((addSubcommand) => addSubcommand.setName('add')
        .setDescription('Add a longterm memory for the bot to use.')
        .addStringOption((textOption) => textOption.setName('text')
          .setDescription('Text of the longterm memory.')
          .setRequired(true)))
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
        .setDescription('View the current longterm memory of the bot'))
      .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
        .setDescription('Edit a current longterm memory.')
        .addNumberOption((idOption) => idOption.setName('ltm-id')
          .setDescription('ID of the longterm memory to edit.')
          .setRequired(true))
        .addStringOption((textOption) => textOption.setName('memory-text')
          .setDescription('The new content of the core memory.')
          .setRequired(true)))
      .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
        .setDescription('Delete a current longterm memory of the bot')
        .addNumberOption((ltmIDOption) => ltmIDOption.setName('ltm-id')
          .setDescription('ID of the longterm memory. Leave blank to delete all'))))
    .addSubcommandGroup((statusGroup) => statusGroup.setName('status')
      .setDescription('Whether the chatbot is enabled or disabled.')
      .addSubcommand((setSubcommand) => setSubcommand.setName('set')
        .setDescription('Set the status of the chatbot')
        .addBooleanOption((enabledOption) => enabledOption.setName('enabled').setRequired(true)
          .setDescription('True = Enable, False = Disable')))
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
        .setDescription('View the current enabled status of the chatbot.'))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake) {
    const subcommandGroup = interaction.options.getSubcommandGroup();
    const subcommand = interaction.options.getSubcommand();

    if (subcommandGroup === 'core-memory') {
      const chatbot = getChatbot(serverID);
      if (!chatbot) {
        interaction.reply({ content: 'No current chatbot in the server! Try /chatbot create', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'view') {
        const coreMemory = chatbot.chatbot_core_memory;

        interaction.reply({ content: coreMemory, flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'edit') {
        const modalID = `core-memory:${interaction.id}`;
        const coreMemoryModal = new ModalBuilder().setCustomId(modalID).setTitle('Set Core Memory');

        const paragraphID = `core-memory:paragraph:${interaction.id}`;
        const coreMemoryParagraph = new TextInputBuilder()
          .setCustomId(paragraphID)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(chatbot.chatbot_core_memory ?? '')
          .setMaxLength(4_000);
        const coreMemoryLabel = new LabelBuilder().setLabel('Set the core memory for the bot.').setTextInputComponent(coreMemoryParagraph);

        coreMemoryModal.addLabelComponents(coreMemoryLabel);

        await interaction.showModal(coreMemoryModal);

        const submitModal = await interaction.awaitModalSubmit({
          time: 60_000 * 10, // 10 minutes
          filter: (inter) => inter.customId === modalID && inter.user.id === interaction.user.id,
        });

        const newCoreMemory = submitModal.fields.getTextInputValue(paragraphID);
        chatbot.chatbot_core_memory = newCoreMemory;
        upsertChatbot(chatbot);

        submitModal.reply({ content: 'Successfully updated server prompt!', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subcommandGroup === 'longterm-memory') {
      const longtermMemories = getChatbotLongTermMemoriesByServer(serverID);
      if (subcommand === 'add') {
        const textOption = interaction.options.getString('text')!;
        if (textOption === '') {
          interaction.reply({ content: 'You must enter some text for the memory!', flags: MessageFlags.Ephemeral });
          return;
        }

        insertChatbotLongTermMemory({
          server_id: serverID,
          timestamp: Date.now(),
          message_content: textOption,
        });

        interaction.reply({ content: 'Successfully added longterm memory!', flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'view') {
        if (!longtermMemories || longtermMemories.length === 0) {
          interaction.reply({ content: 'There are no longterm memories in this server!', flags: MessageFlags.Ephemeral });
          return;
        }

        const longtermMemoryEmbed = new EmbedBuilder().setTitle('Long Term Memories')
          .addFields(...longtermMemories.map((ltm) => ({ name: `${ltm.memory_id}`, value: ltm.message_content })));
        interaction.reply({ embeds: [longtermMemoryEmbed], flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'edit') {
        const ltmID = interaction.options.getNumber('ltm-id')!;
        const longtermMemory = getChatbotLongTermMemory(serverID, ltmID);
        const newContent = interaction.options.getString('memory-text') ?? '';

        if (!longtermMemory) {
          interaction.reply({ content: 'There is no message with that ID!', flags: MessageFlags.Ephemeral });
          return;
        }

        updateChatbotLongTermMemory(serverID, ltmID, newContent);

        interaction.reply({ content: 'Successfully updated memory!', flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'delete') {
        const ltmID = interaction.options.getNumber('ltm-id')!;
        const longtermMemory = getChatbotLongTermMemory(serverID, ltmID);

        if (!longtermMemory) {
          interaction.reply({ content: 'There is no memory with that ID!', flags: MessageFlags.Ephemeral });
          return;
        }

        deleteChatbotLongTermMemory(serverID, ltmID);
        interaction.reply({ content: 'Successfully deleted memory!', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subcommandGroup === 'status') {
      const chatbot = getChatbot(serverID);
      if (!chatbot) {
        interaction.reply('There is no chatbot on this server! Try making one with /chatbot create');
        return;
      }

      if (subcommand === 'set') {
        const enabledOption = interaction.options.getBoolean('enabled')!;

        if (enabledOption !== chatbot.chatbot_enabled) {
          chatbot.chatbot_enabled = enabledOption;
          upsertChatbot(chatbot);
          interaction.reply({ content: 'Successfully set bot status.', flags: MessageFlags.Ephemeral });
          return;
        }
        interaction.reply({ content: 'Already set to status!', flags: MessageFlags.Ephemeral });
        return;
      }

      if (subcommand === 'view') {
        interaction.reply({ embeds: [ChatbotCommand.configEmbedBuilder('Chatbot Settings', serverID)], flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subcommandGroup === 'prompt') {
      if (subcommand === 'set') {
        const chatbot = getChatbot(serverID);
        if (!chatbot) {
          interaction.reply({ content: 'There is no chatbot! Try making one first with /chatbot create', flags: MessageFlags.Ephemeral });
          return;
        }

        const modalID = `prompt:${interaction.id}`;
        const promptModal = new ModalBuilder().setCustomId(modalID).setTitle('Set System Prompt');

        const paragraphID = `prompt:paragraph:${interaction.id}`;
        const promptParagraph = new TextInputBuilder()
          .setCustomId(paragraphID)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(chatbot.chatbot_prompt ?? '')
          .setMaxLength(4_000);
        const promptLabel = new LabelBuilder().setLabel('Set the system prompt for the bot.').setTextInputComponent(promptParagraph);

        promptModal.addLabelComponents(promptLabel);

        await interaction.showModal(promptModal);

        const submitModal = await interaction.awaitModalSubmit({
          time: 60_000 * 10, // 10 minutes
          filter: (inter) => inter.customId === modalID && inter.user.id === interaction.user.id,
        });

        const newPrompt = submitModal.fields.getTextInputValue(paragraphID);

        chatbot.chatbot_prompt = newPrompt;
        upsertChatbot(chatbot);

        submitModal.reply({ content: 'Successfully updated server prompt!', flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'delete') {
        const chatbot = getChatbot(serverID);
        if (!chatbot) {
          interaction.reply({ content: 'There is no chatbot! Try making one first with /chatbot create', flags: MessageFlags.Ephemeral });
          return;
        }

        setChatbotPrompt(serverID, await getDefaultSystemPrompt());
        interaction.reply({ content: 'Successfully updated system prompt!', flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subcommand === 'clear-memory') {
      const confirmation = interaction.options.getBoolean('confirmation')!;

      if (!confirmation) {
        interaction.reply({ content: 'Confirmation set to false! To clear the memory, set the confirmation option to true!', flags: MessageFlags.Ephemeral });
        return;
      }

      const shortTermMemories = getChatbotShortTermMemoriesByServer(serverID);

      if (!shortTermMemories || shortTermMemories.length === 0) {
        interaction.reply({ content: 'There are no short term memories on the server!', flags: MessageFlags.Ephemeral });
        return;
      }

      deleteNOldestShortTermMemory(serverID, shortTermMemories.length);
      interaction.reply({ content: 'Successfully deleted all short term memories!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'tools') {
      const enabledOption = interaction.options.getBoolean('enable')!;
      const chatbot = getChatbot(serverID);

      if (!chatbot) {
        interaction.reply({ content: 'There is no chatbot in this server! Try making one with /chatbot create', flags: MessageFlags.Ephemeral });
        return;
      }

      if (enabledOption && chatbot.tools_enabled) {
        interaction.reply({ content: 'Tools are already enabled in this server!', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!enabledOption && !chatbot.tools_enabled) {
        interaction.reply({ content: 'Tools are already disabled in this server!', flags: MessageFlags.Ephemeral });
        return;
      }

      chatbot.tools_enabled = enabledOption;
      upsertChatbot(chatbot);
      interaction.reply({ content: 'Successfully updated the chatbot!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'create') {
      const chatbot = getChatbot(serverID);
      if (chatbot) {
        interaction.reply({ content: 'There is already a chatbot in this server! Try deleting it first to create a new one!', flags: MessageFlags.Ephemeral });
        return;
      }

      upsertChatbot({
        server_id: serverID,
        chatbot_enabled: false,
        tools_enabled: false,
        chatbot_prompt: await getDefaultSystemPrompt(),
        chatbot_core_memory: '',
      });

      interaction.reply({ content: 'Successfully created chatbot!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'delete') {
      const chatbot = getChatbot(serverID);

      if (!chatbot) {
        interaction.reply({ content: 'There is no chatbot in the server to delete!', flags: MessageFlags.Ephemeral });
        return;
      }

      deleteChatbot(serverID);
      interaction.reply({ content: 'Successfully deleted chatbot!', flags: MessageFlags.Ephemeral });
    }
  },
  configEmbedBuilder(serverID: Snowflake, chatbot: ChatbotTable) {
    if (!chatbot) {
      return new EmbedBuilder()
        .setTitle('No current chatbot');
    }

    return new EmbedBuilder()
      .setTitle('Chatbot settings')
      .addFields(
        { name: 'Enabled', value: (chatbot?.chatbot_enabled ? 'Yes' : 'No') },
        { name: 'Tools Enabled', value: (chatbot?.tools_enabled ? 'Yes' : 'No') },
      );
  },
};

// have to have these commands separate from Chatbot, as anyone may use this command, and i cannot change perms between subcommands.
const SubscribeCommand: Command = {
  data: new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe to the chatbot, allowing it to reply and talk to you.'),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake) {
    const userID = interaction.user.id;
    const isSubscriber = isChatbotSubscriber(serverID, userID);

    if (isSubscriber) {
      interaction.reply({ content: 'You are already subscribed!', flags: MessageFlags.Ephemeral });
      return;
    }

    addChatbotSubscriber(serverID, userID);
    interaction.reply({ content: 'Successfully subscribed you!', flags: MessageFlags.Ephemeral });
  },
};
const UnsubscribeCommand: Command = {
  data: new SlashCommandBuilder().setName('unsubscribe').setDescription('Unsubscribe to the chatbot, disallowing it to reply and talk to you.'),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake) {
    const userID = interaction.user.id;
    const isSubscriber = isChatbotSubscriber(serverID, userID);

    if (!isSubscriber) {
      interaction.reply({ content: 'You are already unsubscribed!', flags: MessageFlags.Ephemeral });
      return;
    }

    removeChatbotSubscriber(serverID, userID);
    interaction.reply({ content: 'Successfully unsubscribed you!', flags: MessageFlags.Ephemeral });
  },
};

const HeartboardCommand: ConfigCommand = {
  data: new SlashCommandBuilder()
    .setName('heartboard')
    .setDescription('A board that keeps track of all messages above a threshold of reactions')
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
      if (!heartBoards || heartBoards.length === 0) {
        interaction.reply({ content: 'There are currently no heartboards on this server.', flags: MessageFlags.Ephemeral });
        return;
      }

      const heartboardFields = heartBoards.map((heartboard) => ({
        name: `${heartboard.board_name} (${heartboard.enabled ? '✔' : '✘'})`,
        value: getHeartBoardEmojis(serverID, heartboard.board_name).map((emoji) => emoji.emoji).join(', '),
      }));
      const embed = new EmbedBuilder().setTitle('Heartboards').addFields(...heartboardFields);

      interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
      return;
    }
    if (subCommand === 'status') {
      const nameOption = interaction.options.getString('name')!;
      const enabledOption = interaction.options.getBoolean('enabled')!;

      const heartBoard = getHeartBoard(serverID, nameOption);

      if (!heartBoard) {
        interaction.reply({ content: 'There is no heartboard with that name', flags: MessageFlags.Ephemeral });
        return;
      }

      heartBoard.enabled = enabledOption;
      updateHeartBoard(heartBoard);

      interaction.reply({ content: 'Successfully updated heartboard', flags: MessageFlags.Ephemeral });
      return;
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

      updateHeartBoard(heartBoard);
      interaction.reply({ content: 'Successfully updated heartboard!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subCommand === 'delete') {
      const nameOption = interaction.options.getString('name')!;
      const heartBoard = getHeartBoard(serverID, nameOption);

      if (!heartBoard) {
        interaction.reply({ content: 'There is no heatboard with this name.', flags: MessageFlags.Ephemeral });
        return;
      }

      deleteHeartBoard(serverID, heartBoard.board_name);
      interaction.reply({ content: 'Successfully deleted heartboard.', flags: MessageFlags.Ephemeral });
      return;
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
      if (!voicePings || voicePings.length === 0) {
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

      const voicePing = getVoicePing(serverID, nameOption);

      if (!voicePing) {
        interaction.reply({ content: 'There is no VoicePings with that name', flags: MessageFlags.Ephemeral });
        return;
      }

      voicePing.enabled = enabledOption;
      updateVoicePing(voicePing);

      interaction.reply({ content: 'Successfully updated VoicePing', flags: MessageFlags.Ephemeral });
      return;
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

      updateVoicePing(voicePing);
      interaction.reply({ content: 'Successfully updated voiceping!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subCommand === 'delete') {
      const nameOption = interaction.options.getString('name')!;

      const voicePing = getVoicePing(serverID, nameOption);
      if (!voicePing) {
        interaction.reply({ content: 'There is no VoicePing with this name! Ensure it\'s spelled correctly.', flags: MessageFlags.Ephemeral });
        return;
      }

      deleteVoicePing(serverID, nameOption);
      interaction.reply({ content: 'Successfully deleted VoicePing', flags: MessageFlags.Ephemeral });
      return;
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
    .setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
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
        .setAutocomplete(true)
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

      updateAutomaticResponse(referencedResponse);
      interaction.reply({ content: 'Successfully edited Response!', embeds: [ResponseCommand.configEmbedBuilder(serverID, referencedResponse)], flags: MessageFlags.Ephemeral });
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

      updateAutomaticResponse(referencedResponse);
      interaction.reply({ content: 'Successfully edited the Response!', embeds: [ResponseCommand.configEmbedBuilder(serverID, referencedResponse)], flags: MessageFlags.Ephemeral });
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

      deleteAutomaticResponse(serverID, nameOption);
      interaction.reply({ content: 'Successfully removed response!', flags: MessageFlags.Ephemeral });
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
        { name: 'Output Channel', value: automaticResponse.output_template.replace('https://', 'https​://') }, // invisible character to stop "{1}" displaying as "%7B1%7D" in link
      ]);
  },
};

const ReminderCommand: ConfigCommand = {
  data: new SlashCommandBuilder().setName('reminder').setDescription('Create a reminder for a later date, or a reoccuring reminder')
    .addSubcommand((addSubcommand) => addSubcommand.setName('add').setDescription('Add a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the reminder')
        .setRequired(true).setMaxLength(40))
      .addStringOption((scheduleOption) => scheduleOption.setName('schedule').setDescription('Discord @time string (<t:xxxxxxxxxx:s>) or cron schedule for the reminder')
        .setRequired(true).setMaxLength(40))
      .addStringOption((messageOption) => messageOption.setName('message').setDescription('Reminder message to send')
        .setRequired(true).setMaxLength(2000))
      .addChannelOption((channelOption) => channelOption.setName('output-channel').setDescription('Channel the reminder should be sent to')
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildAnnouncement, ChannelType.PrivateThread, ChannelType.GuildVoice))
      .addBooleanOption((repeatsOption) => repeatsOption.setName('repeats').setDescription('Whether the schedule repeats, or deletes after single use. True = Repeats, False = Deletes')))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit').setDescription('Edit a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the schedule to edit')
        .setRequired(true).setAutocomplete(true))
      .addStringOption((scheduleOption) => scheduleOption.setName('schedule').setDescription('New discord @time string or cron schedule to change to').setAutocomplete(true))
      .addStringOption((messageOption) => messageOption.setName('message').setDescription('New message to change to'))
      .addChannelOption((channelOption) => channelOption.setName('output-channel').setDescription('Channel the reminder should be sent to')
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildAnnouncement, ChannelType.PrivateThread, ChannelType.GuildVoice))
      .addBooleanOption((repeatOption) => repeatOption.setName('repeat').setDescription('New value whether the schedule repeats, or deletes after single use.')))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view').setDescription('View the contents of a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the reminder')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete').setDescription('Delete a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the reminder')
        .setRequired(true).setAutocomplete(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    if (subcommand === 'add') {
      const nameOption = interaction.options.getString('name')!;
      const scheduleOption = interaction.options.getString('schedule')!;
      const messageOption = interaction.options.getString('message')!;
      const channelOption = interaction.options.getChannel('output-channel');
      const repeatOption = interaction.options.getBoolean('repeats');

      const existingReminder = getReminder(serverID, nameOption);
      if (existingReminder) {
        interaction.reply({ content: 'There is already a reminder with this name! Please try a different name!', flags: MessageFlags.Ephemeral });
        return;
      }

      // create cron schedule either from the cron string, or the discord date tag
      const cronSchedule = inputToSchedule(scheduleOption);

      if (!cronSchedule) {
        interaction.reply({ content: 'The given schedule is not a valid Discord @time or cron schedule! Please ensure it follows one of these formats!', flags: MessageFlags.Ephemeral });
        return;
      }

      const guild = interaction.guild!;
      const outputChannel = channelOption ? (await guild.channels.fetch(channelOption.id))! : (await guild.channels.fetch(interaction.channelId))!;

      const reminder = {
        server_id: serverID,
        reminder_name: nameOption,

        channel_id: outputChannel.id,
        repeats: repeatOption ?? false,
        cron_schedule: scheduleOption,
        message_content: messageOption,
      };

      addReminder(reminder);
      cron.schedule(cronSchedule, () => sendReminder(outputChannel, serverID, reminder.reminder_name), {
        name: `${reminder.server_id}${reminder.reminder_name}`,
      });

      interaction.reply({ content: 'Successfully created schedule!', flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'edit') {
      const nameOption = interaction.options.getString('name')!;
      const scheduleOption = interaction.options.getString('schedule');
      const messageOption = interaction.options.getString('message');
      const channelOption = interaction.options.getChannel('output-channel');
      const repeatOption = interaction.options.getBoolean('repeats');

      const reminder = getReminder(serverID, nameOption);
      if (!reminder) {
        interaction.reply({ content: 'There is no reminder with this name! Please ensure you\'ve spelled it correctly!', flags: MessageFlags.Ephemeral });
        return;
      }
      if (!scheduleOption && !messageOption && repeatOption === null) {
        interaction.reply({ content: 'You must edit at least one field!', flags: MessageFlags.Ephemeral });
        return;
      }

      if (scheduleOption) {
        const cronSchedule = inputToSchedule(scheduleOption);
        if (!cronSchedule) {
          interaction.reply({ content: 'The given schedule is not a valid Discord @time or cron schedule! Please ensure it follows one of these formats!', flags: MessageFlags.Ephemeral });
          return;
        }

        reminder.cron_schedule = cronSchedule;
      }
      if (channelOption) {
        const guild = interaction.guild!;
        const outputChannel = channelOption ? (await guild.channels.fetch(channelOption.id))! : (await guild.channels.fetch(interaction.channelId))!;
        if (!outputChannel.isSendable()) {
          interaction.reply({ content: 'The channel given must be able to be sent to!', flags: MessageFlags.Ephemeral });
          return;
        }

        reminder.channel_id = outputChannel.id;
      }
      if (messageOption && messageOption !== '') {
        reminder.message_content = messageOption;
      }
      if (repeatOption !== null) {
        reminder.repeats = repeatOption;
      }

      updateReminder(reminder);
      interaction.reply({ content: 'Successfully updated reminder!', flags: MessageFlags.Ephemeral });
      // return;
    }
    if (subcommand === 'view') {
      const nameOption = interaction.options.getString('name')!;

      const reminder = getReminder(serverID, nameOption);
      if (!reminder) {
        interaction.reply({ content: 'There is no reminder by this name, ensure you\'ve spelled it correctly', flags: MessageFlags.Ephemeral });
        return;
      }

      interaction.reply({ embeds: [this.configEmbedBuilder(serverID, reminder)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'delete') {
      const nameOption = interaction.options.getString('name')!;

      const reminder = getReminder(serverID, nameOption);
      if (!reminder) {
        interaction.reply({ content: 'There is no reminder by this name, ensure you\'ve spelled it correctly', flags: MessageFlags.Ephemeral });
        return;
      }

      deleteReminder(reminder);
      interaction.reply({ content: 'Successfully deleted reminder!', flags: MessageFlags.Ephemeral });
    }
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused();

    const reminders = getRemindersByServer(serverID);
    const choices = reminders.map((response) => response.reminder_name);

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue));
    interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
  },
  configEmbedBuilder(serverID: Snowflake, reminder: ReminderTable) {
    return new EmbedBuilder().setTitle('Reminder Settings')
      .addFields(
        { name: 'Name:', value: reminder.reminder_name },
        { name: 'Output Channel', value: `<#${reminder.channel_id}>` },
        { name: 'Schedule', value: reminder.cron_schedule },
        { name: 'Message', value: reminder.message_content.substring(0, 1024) },
        { name: 'Repeats', value: reminder.repeats ? 'Yes' : 'No' },
      );
  },
};

commandMap.set(ChatbotCommand.data.name, ChatbotCommand);
commandMap.set(SubscribeCommand.data.name, SubscribeCommand);
commandMap.set(UnsubscribeCommand.data.name, UnsubscribeCommand);
commandMap.set(HeartboardCommand.data.name, HeartboardCommand);
commandMap.set(VoicePingCommand.data.name, VoicePingCommand);
commandMap.set(ResponseCommand.data.name, ResponseCommand);
commandMap.set(ReminderCommand.data.name, ReminderCommand);

export { commandMap, ChatbotCommand, SubscribeCommand, UnsubscribeCommand, ResponseCommand, ReminderCommand, HeartboardCommand, VoicePingCommand };
