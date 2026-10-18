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
  deleteConversationSummary, deleteHeartBoard, deleteConversation, deleteReminder, deleteVoicePing, getConversationsBySource, getAutomaticResponse, getAutomaticResponsesByServer, getChatbot,
  deleteCounter, deleteMemory, getConversationByChannel, getCounter, getCountersByServer, incrementCounter, insertCounter, setCounterValue, getConversationSummariesBySource, getHeartBoard, upsertMemory, getHeartBoardEmojis, getHeartBoardsByServer, getReminder, getRemindersByServer, getVoicePing,
  getVoicePingInputs, getVoicePingsByServer, insertAutomaticResponse, insertHeartBoard, insertHeartBoardEmoji,
  insertVoicePing, insertVoicePingInput, isChatbotSubscriber, getChatbotSubscriber, setChatbotSubscriberCrossServer, removeChatbotSubscriber, updateAutomaticResponse,
  updateHeartBoard, updateReminder, updateVoicePing, upsertChatbot, upsertConversationSummary } from './data';
import { AutomaticResponseTable, ChatbotTable, ConversationSummaryTable, ReminderTable, HeartBoardTable, VoicePingTable } from './types/schema';
import { getEmbedding, getSystemPrompt } from './chatbot/chatbot';
import { SOURCE_SEPARATOR, endConversation, fromSummarySource } from './chatbot/conversation';
import { MAIN_SOURCE, findMemory, getVisibleMemories, isAttached } from './chatbot/context';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, findModel, formatPricing, getModels, getSupportedEfforts, supportsTools } from './chatbot/models';
import { inputToSchedule, sendReminder } from './utils';

const commandMap: Map<string, Command> = new Map();

// a server's own summaries: its local ones, and the copies it shared with other servers. oldest first
function getServerSummaries(serverID: Snowflake): ConversationSummaryTable[] {
  return [
    ...getConversationSummariesBySource(serverID),
    ...getConversationSummariesBySource(`${MAIN_SOURCE}${SOURCE_SEPARATOR}${serverID}`),
  ].sort((a, b) => a.timestamp - b.timestamp);
}
// identifies one summary, since a conversation can have both a local and a shared one
function summaryKey(summary: ConversationSummaryTable): string {
  return `${summary.conversation_id}|${summary.source_id}`;
}
function summaryScopeLabel(summary: ConversationSummaryTable): string {
  return fromSummarySource(summary.source_id).shared ? 'shared' : 'local';
}

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
    .addSubcommand((modelSubcommand) => modelSubcommand.setName('model')
      .setDescription('Change the AI model the chatbot uses, from any model on OpenRouter')
      .addStringOption((queryOption) => queryOption.setName('query')
        .setDescription('Search for a model by name or ID, e.g. "glm" or "anthropic/"')
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((reasoningSubcommand) => reasoningSubcommand.setName('reasoning-effort')
      .setDescription('Change how much the chatbot thinks before replying. Options depend on the current model')
      .addStringOption((queryOption) => queryOption.setName('query')
        .setDescription('The effort level, e.g. "low" or "high"')
        .setRequired(true)
        .setAutocomplete(true)))
    .addSubcommand((detachSubcommand) => detachSubcommand.setName('detach')
      .setDescription('Whether the bot keeps its own memories, instead of sharing them with other servers')
      .addBooleanOption((detachOption) => detachOption.setName('enable').setDescription('True = Separate from other servers, False = Joins the hivemind')
        .setRequired(true)))
    .addSubcommandGroup((personaSubcommandGroup) => personaSubcommandGroup.setName('persona')
      .setDescription('Set or delete the persona for the chatbot, which is added on top of the system prompt.')
      .addSubcommand((setPersonaSubcommand) => setPersonaSubcommand.setName('set')
        .setDescription('Set the persona.'))
      .addSubcommand((deletePersonaSubcommand) => deletePersonaSubcommand.setName('delete')
        .setDescription('Delete the persona.')))
    .addSubcommandGroup((systemPromptSubcommandGroup) => systemPromptSubcommandGroup.setName('system-prompt')
      .setDescription('Override the base system prompt for this server.')
      .addSubcommand((setSystemPromptSubcommand) => setSystemPromptSubcommand.setName('set')
        .setDescription('Set the system prompt override.'))
      .addSubcommand((deleteSystemPromptSubcommand) => deleteSystemPromptSubcommand.setName('delete')
        .setDescription('Delete the override, going back to the base system prompt.')))
    .addSubcommand((clearMemoryCommand) => clearMemoryCommand.setName('clear-memory').setDescription('Clears this server\'s conversations and summaries. Memories are kept')
      .addBooleanOption((confirmationOption) => confirmationOption.setName('confirmation').setDescription('Are you sure you wish to clear the memory? True = Yes, False = No.')))
    .addSubcommandGroup((summariesGroup) => summariesGroup.setName('summaries')
      .setDescription('View, edit, and delete the conversation summaries for the chatbot.')
      .addSubcommand((createSubcommand) => createSubcommand.setName('create')
        .setDescription('Summarize the current conversation, and delete context'))
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
        .setDescription('View the conversation summaries in this server.'))
      .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
        .setDescription('Edit a conversation summary.')
        .addStringOption((summaryOption) => summaryOption.setName('summary')
          .setDescription('The summary to edit.')
          .setRequired(true)
          .setAutocomplete(true)))
      .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
        .setDescription('Delete a conversation summary.')
        .addStringOption((summaryOption) => summaryOption.setName('summary')
          .setDescription('The summary to delete. Leave blank to delete all of this server\'s summaries')
          .setAutocomplete(true))))
    .addSubcommandGroup((memoriesGroup) => memoriesGroup.setName('memories')
      .setDescription('View, set, and delete the memories for the chatbot.')
      .addSubcommand((viewSubcommand) => viewSubcommand.setName('view')
        .setDescription('View a memory, or every memory in this server.')
        .addStringOption((nameOption) => nameOption.setName('name')
          .setDescription('Name of the memory to view. Leave blank to view all')
          .setAutocomplete(true)))
      .addSubcommand((setSubcommand) => setSubcommand.setName('set')
        .setDescription('Create a memory, or edit an existing one.')
        .addStringOption((nameOption) => nameOption.setName('name')
          .setDescription('Name of the memory. Not case-sensitive')
          .setRequired(true)
          .setMaxLength(100)
          .setAutocomplete(true))
        .addBooleanOption((sharedOption) => sharedOption.setName('shared')
          .setDescription('For new memories: share with other servers. Defaults to False')))
      .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
        .setDescription('Delete a memory.')
        .addStringOption((nameOption) => nameOption.setName('name')
          .setDescription('Name of the memory to delete.')
          .setRequired(true)
          .setAutocomplete(true))))
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

    if (subcommandGroup === 'memories') {
      const name = interaction.options.getString('name');

      // attached servers also see the memories shared between servers. their own come first, when names clash
      const scopeLabel = (source_id: string) => (source_id === MAIN_SOURCE ? 'shared' : 'this server');

      if (subcommand === 'view') {
        if (name) {
          const memory = findMemory(serverID, name);
          if (!memory) {
            interaction.reply({ content: 'There is no memory with that name!', flags: MessageFlags.Ephemeral });
            return;
          }

          const memoryEmbed = new EmbedBuilder().setTitle(memory.name).setDescription(memory.content)
            .setFooter({ text: scopeLabel(memory.source_id) });
          interaction.reply({ embeds: [memoryEmbed], flags: MessageFlags.Ephemeral });
          return;
        }

        const memories = getVisibleMemories(serverID);
        if (memories.length === 0) {
          interaction.reply({ content: 'There are no memories in this server!', flags: MessageFlags.Ephemeral });
          return;
        }

        // embeds cap at 25 fields, 1024 chars per field, and 6000 chars total, so show the memories that fit
        const fields: { name: string, value: string }[] = [];
        let totalLength = 0;
        for (const memory of memories) {
          const field = {
            name: `${memory.name} (${scopeLabel(memory.source_id)})`.substring(0, 256),
            value: memory.content.length > 200 ? `${memory.content.substring(0, 197)}...` : memory.content,
          };
          if (fields.length === 25 || totalLength + field.name.length + field.value.length > 5_800) break;

          fields.push(field);
          totalLength += field.name.length + field.value.length;
        }

        const memoriesEmbed = new EmbedBuilder().setTitle('Memories')
          .addFields(...fields)
          .setFooter({ text: `Showing ${fields.length} of ${memories.length} memories. View one by name to see all of it` });
        interaction.reply({ embeds: [memoriesEmbed], flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'set') {
        const existingMemory = findMemory(serverID, name!);
        const shared = interaction.options.getBoolean('shared') ?? false;
        if (!existingMemory && shared && !isAttached(serverID)) {
          interaction.reply({ content: 'This server is detached, so it can\'t share memories! Try /chatbot detach enable:False first', flags: MessageFlags.Ephemeral });
          return;
        }

        const modalID = `memory:${interaction.id}`;
        const memoryModal = new ModalBuilder().setCustomId(modalID).setTitle(existingMemory ? 'Edit Memory' : 'Create Memory');

        const paragraphID = `memory:paragraph:${interaction.id}`;
        const memoryParagraph = new TextInputBuilder()
          .setCustomId(paragraphID)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(existingMemory?.content.substring(0, 4000) ?? '')
          .setMaxLength(4_000);
        const memoryLabel = new LabelBuilder().setLabel(`Content of "${name}"`.substring(0, 45)).setTextInputComponent(memoryParagraph);

        memoryModal.addLabelComponents(memoryLabel);

        await interaction.showModal(memoryModal);

        try {
          const submitModal = await interaction.awaitModalSubmit({
            time: 60_000 * 10, // 10 minutes
            filter: (inter) => inter.customId === modalID && inter.user.id === interaction.user.id,
          });
          const content = submitModal.fields.getTextInputValue(paragraphID);

          // an existing memory stays where it is, and keeps its casing, since names aren't case-sensitive
          upsertMemory({
            source_id: existingMemory?.source_id ?? (shared ? MAIN_SOURCE : serverID),
            name: existingMemory?.name ?? name!,
            content,
          });

          submitModal.reply({ content: `Successfully ${existingMemory ? 'updated' : 'created'} memory!`, flags: MessageFlags.Ephemeral });
          return;
        } catch (error) {
          console.error(error);
          return;
        }
      }
      if (subcommand === 'delete') {
        const memory = findMemory(serverID, name!);
        if (!memory) {
          interaction.reply({ content: 'There is no memory with that name!', flags: MessageFlags.Ephemeral });
          return;
        }

        deleteMemory(memory.source_id, memory.name);
        interaction.reply({ content: `Successfully deleted ${memory.source_id === MAIN_SOURCE ? 'shared ' : ''}memory!`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subcommandGroup === 'summaries') {
      const summaries = getServerSummaries(serverID);
      // autocomplete gives `{conversation_id}|{source_id}`. a bare conversation id picks the local summary first
      const summaryOption = interaction.options.getString('summary');
      const selectedSummary = summaryOption
        ? summaries.find((s) => summaryKey(s) === summaryOption)
          ?? summaries.find((s) => s.conversation_id === summaryOption && !fromSummarySource(s.source_id).shared)
          ?? summaries.find((s) => s.conversation_id === summaryOption)
        : undefined;

      if (subcommand === 'create') {
        const conversation = getConversationByChannel(interaction.channelId);
        if (!conversation) {
          interaction.reply({ content: 'There is no active conversation in this channel!', flags: MessageFlags.Ephemeral });
          return;
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral }); // summarizing can take longer than discord's 3 second reply window

        try {
          const summary = await endConversation(conversation);
          if (!summary) {
            interaction.editReply({ content: 'There was nothing to summarize in this conversation!' });
            return;
          }

          interaction.editReply({ content: `Successfully summarized conversation!\n${summary}`.substring(0, 2000) });
        } catch (error) {
          console.error(error);
          interaction.editReply({ content: 'Failed to summarize the conversation.' });
        }
        return;
      }
      if (subcommand === 'view') {
        if (summaries.length === 0) {
          interaction.reply({ content: 'There are no conversation summaries in this server!', flags: MessageFlags.Ephemeral });
          return;
        }

        // embeds cap at 25 fields, 1024 chars per field, and 6000 chars total, so show the newest summaries that fit
        const fields: { name: string, value: string }[] = [];
        let totalLength = 0;
        for (const summary of [...summaries].reverse()) {
          const field = {
            name: `${summary.conversation_id} (${summaryScopeLabel(summary)}, ${new Date(summary.timestamp).toLocaleString()})`,
            value: summary.summary.substring(0, 1024),
          };
          if (fields.length === 25 || totalLength + field.name.length + field.value.length > 5_800) break;

          fields.push(field);
          totalLength += field.name.length + field.value.length;
        }

        const summariesEmbed = new EmbedBuilder().setTitle('Conversation Summaries')
          .addFields(...fields)
          .setFooter({ text: `Showing ${fields.length} of ${summaries.length} summaries` });
        interaction.reply({ embeds: [summariesEmbed], flags: MessageFlags.Ephemeral });
        return;
      }
      if (subcommand === 'edit') {
        const summary = selectedSummary;
        if (!summary) {
          interaction.reply({ content: 'There is no summary with that ID!', flags: MessageFlags.Ephemeral });
          return;
        }

        const modalID = `summary:${interaction.id}`;
        const summaryModal = new ModalBuilder().setCustomId(modalID).setTitle('Edit Summary');

        const paragraphID = `summary:paragraph:${interaction.id}`;
        const summaryParagraph = new TextInputBuilder()
          .setCustomId(paragraphID)
          .setStyle(TextInputStyle.Paragraph)
          .setValue(summary.summary.substring(0, 4000))
          .setMaxLength(4_000);
        const summaryLabel = new LabelBuilder().setLabel('Edit the conversation summary.').setTextInputComponent(summaryParagraph);

        summaryModal.addLabelComponents(summaryLabel);

        await interaction.showModal(summaryModal);

        try {
          const submitModal = await interaction.awaitModalSubmit({
            time: 60_000 * 10, // 10 minutes
            filter: (inter) => inter.customId === modalID && inter.user.id === interaction.user.id,
          });
          const newSummary = submitModal.fields.getTextInputValue(paragraphID);

          // re-embed, so relevant summary lookup matches the new text
          upsertConversationSummary({ ...summary, summary: newSummary, embedding: await getEmbedding(newSummary) });

          submitModal.reply({ content: 'Successfully updated summary!', flags: MessageFlags.Ephemeral });
          return;
        } catch (error) {
          console.error(error);
          return;
        }
      }
      if (subcommand === 'delete') {
        // deletes both the local and shared copies of every conversation from this server
        if (!summaryOption) {
          summaries.forEach((s) => deleteConversationSummary(s.conversation_id, s.source_id));
          interaction.reply({ content: `Successfully deleted ${summaries.length} summaries!`, flags: MessageFlags.Ephemeral });
          return;
        }

        if (!selectedSummary) {
          interaction.reply({ content: 'There is no summary with that ID!', flags: MessageFlags.Ephemeral });
          return;
        }

        deleteConversationSummary(selectedSummary.conversation_id, selectedSummary.source_id);
        interaction.reply({ content: `Successfully deleted ${summaryScopeLabel(selectedSummary)} summary!`, flags: MessageFlags.Ephemeral });
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
        interaction.reply({ embeds: [ChatbotCommand.configEmbedBuilder('Chatbot Settings', chatbot)], flags: MessageFlags.Ephemeral });
        return;
      }
    }
    // the persona is layered on top of the system prompt. the system prompt is SYSTEM.md, unless this server overrides it
    if (subcommandGroup === 'persona' || subcommandGroup === 'system-prompt') {
      const chatbot = getChatbot(serverID);
      if (!chatbot) {
        interaction.reply({ content: 'There is no chatbot! Try making one first with /chatbot create', flags: MessageFlags.Ephemeral });
        return;
      }

      const isPersona = subcommandGroup === 'persona';
      const promptName = isPersona ? 'persona' : 'system prompt override';

      if (subcommand === 'set') {
        const modalID = `${subcommandGroup}:${interaction.id}`;
        const promptModal = new ModalBuilder().setCustomId(modalID).setTitle(isPersona ? 'Set Persona' : 'Override System Prompt');

        // an override starts from the current system prompt, so it can be tweaked rather than written from scratch
        const currentPrompt = isPersona ? chatbot.chatbot_prompt : getSystemPrompt(chatbot);
        const paragraphID = `${subcommandGroup}:paragraph:${interaction.id}`;
        const promptParagraph = new TextInputBuilder()
          .setCustomId(paragraphID)
          .setStyle(TextInputStyle.Paragraph)
          .setValue((currentPrompt ?? '').substring(0, 4000))
          .setMaxLength(4_000);
        const promptLabel = new LabelBuilder()
          .setLabel(isPersona ? 'Persona, added on top of the system prompt.' : 'Replaces the system prompt for this server.')
          .setTextInputComponent(promptParagraph);

        promptModal.addLabelComponents(promptLabel);

        await interaction.showModal(promptModal);

        try {
          const submitModal = await interaction.awaitModalSubmit({
            time: 60_000 * 10, // 10 minutes
            filter: (inter) => inter.customId === modalID && inter.user.id === interaction.user.id,
          });

          const newPrompt = submitModal.fields.getTextInputValue(paragraphID);
          if (isPersona) chatbot.chatbot_prompt = newPrompt;
          else chatbot.system_prompt_override = newPrompt || undefined;
          upsertChatbot(chatbot);

          submitModal.reply({ content: `Successfully updated ${promptName}!`, flags: MessageFlags.Ephemeral });
          return;
        } catch (error) {
          console.error(error);
          return;
        }
      }
      if (subcommand === 'delete') {
        if (isPersona) chatbot.chatbot_prompt = '';
        else chatbot.system_prompt_override = undefined;
        upsertChatbot(chatbot);

        interaction.reply({ content: `Successfully deleted ${promptName}!`, flags: MessageFlags.Ephemeral });
        return;
      }
    }
    if (subcommand === 'model') {
      const chatbot = getChatbot(serverID);
      if (!chatbot) {
        interaction.reply({ content: 'There is no chatbot in this server! Try making one with /chatbot create', flags: MessageFlags.Ephemeral });
        return;
      }

      // autocomplete fills in the exact id. checked against OpenRouter, so a typo can't leave the bot on a model that doesn't exist
      const query = interaction.options.getString('query')!;
      const model = findModel(query);
      if (!model) {
        interaction.reply({ content: `There's no model with the ID \`${query}\` on OpenRouter. Pick one from the suggestions as you type!`, flags: MessageFlags.Ephemeral });
        return;
      }

      chatbot.model = model.id === DEFAULT_MODEL ? undefined : model.id; // the default is stored as empty, so it follows DEFAULT_MODEL if that changes
      upsertChatbot(chatbot);

      const hasTools = supportsTools(model.id);
      // efforts differ between models, so say if the current one won't do anything here
      const effort = chatbot.reasoning_effort ?? DEFAULT_REASONING_EFFORT;
      const efforts = getSupportedEfforts(model.id);
      const effortNote = efforts.length === 0 ? 'This model doesn\'t reason, so the reasoning effort is ignored.'
        : !efforts.includes(effort) ? `This model doesn't support the current \`${effort}\` reasoning effort. Try /chatbot reasoning-effort: it supports ${efforts.join(', ')}.`
          : '';

      interaction.reply({
        content: `Switched to **${model.name}** (\`${model.id}\`)\n`
          + `-# ${formatPricing(model)} tokens · ${model.context_length.toLocaleString()} token context · tools ${hasTools ? 'supported' : 'not supported, so they\'ll be off while this model is in use'}`
          + (effortNote ? `\n${effortNote}` : ''),
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === 'reasoning-effort') {
      const chatbot = getChatbot(serverID);
      if (!chatbot) {
        interaction.reply({ content: 'There is no chatbot in this server! Try making one with /chatbot create', flags: MessageFlags.Ephemeral });
        return;
      }

      const effort = interaction.options.getString('query')!.toLowerCase();
      const modelID = chatbot.model ?? DEFAULT_MODEL;
      const efforts = getSupportedEfforts(modelID);
      if (efforts.length === 0) {
        interaction.reply({ content: `\`${modelID}\` doesn't reason, so there's no effort to set. Try a different model with /chatbot model!`, flags: MessageFlags.Ephemeral });
        return;
      }
      if (!efforts.includes(effort)) {
        interaction.reply({ content: `\`${modelID}\` doesn't support \`${effort}\`. It supports: ${efforts.join(', ')}`, flags: MessageFlags.Ephemeral });
        return;
      }

      chatbot.reasoning_effort = effort === DEFAULT_REASONING_EFFORT ? undefined : effort; // the default is stored as empty, like the model
      upsertChatbot(chatbot);
      interaction.reply({ content: `Reasoning effort set to **${effort}**!`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'detach') {
      const detachOption = interaction.options.getBoolean('enable')!;
      const chatbot = getChatbot(serverID);

      if (!chatbot) {
        interaction.reply({ content: 'There is no chatbot in this server! Try making one with /chatbot create', flags: MessageFlags.Ephemeral });
        return;
      }
      if (detachOption === chatbot.detached) {
        interaction.reply({ content: `The chatbot is already ${detachOption ? 'detached' : 'sharing with other servers'}!`, flags: MessageFlags.Ephemeral });
        return;
      }

      chatbot.detached = detachOption;
      upsertChatbot(chatbot);
      interaction.reply({
        content: detachOption
          ? 'Detached! The chatbot will only use this server\'s memories and summaries. Ones already shared stay shared.'
          : 'Attached! The chatbot now shares memories and summaries with other servers, for users who opt in with /subscribe.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }
    if (subcommand === 'clear-memory') {
      const confirmation = interaction.options.getBoolean('confirmation')!;

      if (!confirmation) {
        interaction.reply({ content: 'Confirmation set to false! To clear the memory, set the confirmation option to true!', flags: MessageFlags.Ephemeral });
        return;
      }

      // only this server's conversations. deleting them also deletes their messages, summaries, tool results, and index
      const conversations = getConversationsBySource(serverID);

      if (conversations.length === 0) {
        interaction.reply({ content: 'There are no conversations to clear in this server!', flags: MessageFlags.Ephemeral });
        return;
      }

      // cancel their pending summaries, since there'll be nothing left to summarize
      const conversationIDs = new Set(conversations.map((conversation) => conversation.conversation_id));
      cron.getTasks().forEach((task) => {
        if (task.name && conversationIDs.has(task.name)) task.destroy();
      });
      conversations.forEach((conversation) => deleteConversation(conversation.conversation_id));

      interaction.reply({ content: `Successfully cleared ${conversations.length} conversation${conversations.length === 1 ? '' : 's'} and their summaries!`, flags: MessageFlags.Ephemeral });
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
        detached: false,
        chatbot_prompt: '', // SYSTEM.md is used as the base, so a persona is optional
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
        { name: 'Context', value: (chatbot?.detached ? 'Detached (this server only)' : 'Shared with other servers (for opted-in users)') },
        { name: 'System Prompt', value: (chatbot?.system_prompt_override ? 'Overridden for this server' : 'Default (SYSTEM.md)') },
        { name: 'Persona', value: (chatbot?.chatbot_prompt ? 'Set' : 'None') },
        { name: 'Model', value: chatbot?.model ?? `${DEFAULT_MODEL} (default)` },
        { name: 'Reasoning Effort', value: chatbot?.reasoning_effort ?? `${DEFAULT_REASONING_EFFORT} (default)` },
      );
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused().toLowerCase();

    if (interaction.options.getSubcommand() === 'model') {
      // matches on the id or name. ids starting with the query come first, e.g. "anthropic/" lists anthropic's models
      const matches = getModels()
        .filter((model) => model.id.toLowerCase().includes(focusedValue) || model.name.toLowerCase().includes(focusedValue))
        .sort((a, b) => Number(b.id.toLowerCase().startsWith(focusedValue)) - Number(a.id.toLowerCase().startsWith(focusedValue)))
        .slice(0, 25);

      await interaction.respond(matches.map((model) => ({
        name: `${model.name} · tools ${supportsTools(model.id) ? '✓' : '✗'} · ${formatPricing(model)}`.substring(0, 100),
        value: model.id.substring(0, 100),
      })));
      return;
    }
    if (interaction.options.getSubcommand() === 'reasoning-effort') {
      // only the levels the current model supports, marking its own default
      const modelID = getChatbot(serverID)?.model ?? DEFAULT_MODEL;
      const modelDefault = findModel(modelID)?.reasoning?.default_effort;

      await interaction.respond(getSupportedEfforts(modelID)
        .filter((effort) => effort.includes(focusedValue))
        .map((effort) => ({ name: effort === modelDefault ? `${effort} (model's default)` : effort, value: effort })));
      return;
    }

    if (interaction.options.getSubcommandGroup() === 'memories') {
      const filtered = getVisibleMemories(serverID)
        .filter((m) => m.name.toLowerCase().includes(focusedValue))
        .slice(0, 25);

      await interaction.respond(filtered.map((m) => ({ name: m.name, value: m.name })));
      return;
    }

    // newest first, matching on either the id or the summary text
    const summaries = getServerSummaries(serverID).reverse();
    const filtered = summaries
      .filter((s) => s.conversation_id.startsWith(focusedValue) || s.summary.toLowerCase().includes(focusedValue))
      .slice(0, 25);

    await interaction.respond(filtered.map((s) => ({
      name: `[${summaryScopeLabel(s)}] ${new Date(s.timestamp).toLocaleDateString()}: ${s.summary.replace(/\s+/g, ' ')}`.substring(0, 100),
      value: summaryKey(s),
    })));
  },
};

// have to have these commands separate from Chatbot, as anyone may use this command, and i cannot change perms between subcommands.
const SubscribeCommand: Command = {
  data: new SlashCommandBuilder().setName('subscribe').setDescription('Subscribe to the chatbot, allowing it to reply and talk to you.')
    .addBooleanOption((shareOption) => shareOption.setName('share-across-servers')
      .setDescription('Let the chatbot remember your conversations here in other servers too. Defaults to False')),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake) {
    const userID = interaction.user.id;
    const shareOption = interaction.options.getBoolean('share-across-servers');
    const subscriber = getChatbotSubscriber(serverID, userID);

    // already subscribed, so the only thing to do is change whether they share
    if (subscriber) {
      if (shareOption === null || shareOption === subscriber.cross_server) {
        interaction.reply({
          content: `You are already subscribed${subscriber.cross_server ? ', and sharing across servers' : ''}!`,
          flags: MessageFlags.Ephemeral,
        });
        return;
      }

      setChatbotSubscriberCrossServer(serverID, userID, shareOption);
      interaction.reply({
        content: shareOption
          ? 'You\'re now sharing across servers! Your future conversations here can be remembered in other servers.'
          : 'You\'ve stopped sharing across servers. Your future conversations here will stay in this server.',
        flags: MessageFlags.Ephemeral,
      });
      return;
    }

    addChatbotSubscriber(serverID, userID, shareOption ?? false);
    interaction.reply({ content: `Successfully subscribed you${shareOption ? ', and shared across servers' : ''}!`, flags: MessageFlags.Ephemeral });
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

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue)).slice(0, 25);
    await interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
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

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue)).slice(0, 25);
    await interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
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

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue)).slice(0, 25);
    await interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
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
        cron_schedule: cronSchedule,
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
      if (!scheduleOption && !messageOption && !channelOption && repeatOption === null) {
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

      // if schedule or channel has changed, recreate cron task
      if (scheduleOption || channelOption) {
        const taskName = `${reminder.server_id}${reminder.reminder_name}`;
        cron.getTasks().forEach((task) => {
          if (task.name === taskName) {
            task.destroy();
          }
        });

        const outputChannel = (await interaction.guild!.channels.fetch(reminder.channel_id))!;
        cron.schedule(reminder.cron_schedule, () => sendReminder(outputChannel, serverID, reminder.reminder_name), {
          name: taskName,
        });
      }

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

    const filtered = choices.filter((choice) => choice.startsWith(focusedValue)).slice(0, 25);
    await interaction.respond(filtered.map((choice) => ({ name: choice, value: choice })));
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

const CounterCommand: Command = {
  data: new SlashCommandBuilder().setName('counter').setDescription('Create counters to keep track of numbers')
    .addSubcommand((createSubcommand) => createSubcommand.setName('create').setDescription('Create a counter')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the counter. Not case-sensitive')
        .setRequired(true).setMaxLength(40))
      .addIntegerOption((startOption) => startOption.setName('start').setDescription('Starting value of the counter. Defaults to 0')))
    .addSubcommand((addSubcommand) => addSubcommand.setName('add').setDescription('Add to a counter. Use a negative amount to subtract')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the counter')
        .setRequired(true).setAutocomplete(true))
      .addIntegerOption((amountOption) => amountOption.setName('amount').setDescription('Amount to add. Defaults to 1')))
    .addSubcommand((setSubcommand) => setSubcommand.setName('set').setDescription('Set a counter to a specific value')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the counter')
        .setRequired(true).setAutocomplete(true))
      .addIntegerOption((valueOption) => valueOption.setName('value').setDescription('New value of the counter')
        .setRequired(true)))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view').setDescription('View a counter, or every counter in this server')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the counter. Leave blank to view all')
        .setAutocomplete(true)))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete').setDescription('Delete a counter')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the counter')
        .setRequired(true).setAutocomplete(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const nameOption = interaction.options.getString('name');

    if (subcommand === 'create') {
      if (getCounter(serverID, nameOption!)) {
        interaction.reply({ content: 'There is already a counter with this name! Please try a different name!', flags: MessageFlags.Ephemeral });
        return;
      }

      const value = interaction.options.getInteger('start') ?? 0;
      insertCounter({ server_id: serverID, counter_name: nameOption!, value });

      interaction.reply({ content: `Created counter **${nameOption}**, starting at ${value}!`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'view' && !nameOption) {
      const counters = getCountersByServer(serverID);
      if (counters.length === 0) {
        interaction.reply({ content: 'There are no counters in this server! Try making one with /counter create', flags: MessageFlags.Ephemeral });
        return;
      }

      // one line per counter, since embed descriptions fit far more than the 25 field limit
      const counterEmbed = new EmbedBuilder().setTitle('Counters')
        .setDescription(counters.map((counter) => `**${counter.counter_name}**: ${counter.value}`).join('\n').substring(0, 4096));
      interaction.reply({ embeds: [counterEmbed], flags: MessageFlags.Ephemeral });
      return;
    }

    // every other subcommand works on an existing counter
    const counter = getCounter(serverID, nameOption!);
    if (!counter) {
      interaction.reply({ content: 'There is no counter by this name, ensure you\'ve spelled it correctly', flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'add') {
      const amount = interaction.options.getInteger('amount') ?? 1;
      const newValue = incrementCounter(serverID, counter.counter_name, amount);

      // public, so everyone sees the count go up
      interaction.reply({ content: `**${counter.counter_name}**: ${newValue} (${amount >= 0 ? '+' : ''}${amount})` });
      return;
    }
    if (subcommand === 'set') {
      const value = interaction.options.getInteger('value')!;
      setCounterValue(serverID, counter.counter_name, value);

      interaction.reply({ content: `**${counter.counter_name}** set to ${value} (was ${counter.value})` });
      return;
    }
    if (subcommand === 'view') {
      interaction.reply({ content: `**${counter.counter_name}**: ${counter.value}`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'delete') {
      deleteCounter(serverID, counter.counter_name);
      interaction.reply({ content: `Successfully deleted counter **${counter.counter_name}**! It was at ${counter.value}`, flags: MessageFlags.Ephemeral });
    }
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused().toLowerCase();

    const filtered = getCountersByServer(serverID)
      .filter((counter) => counter.counter_name.toLowerCase().includes(focusedValue))
      .slice(0, 25);
    await interaction.respond(filtered.map((counter) => ({ name: `${counter.counter_name} (${counter.value})`.substring(0, 100), value: counter.counter_name })));
  },
};

commandMap.set(ChatbotCommand.data.name, ChatbotCommand);
commandMap.set(SubscribeCommand.data.name, SubscribeCommand);
commandMap.set(UnsubscribeCommand.data.name, UnsubscribeCommand);
commandMap.set(HeartboardCommand.data.name, HeartboardCommand);
commandMap.set(VoicePingCommand.data.name, VoicePingCommand);
commandMap.set(ResponseCommand.data.name, ResponseCommand);
commandMap.set(ReminderCommand.data.name, ReminderCommand);
commandMap.set(CounterCommand.data.name, CounterCommand);

export { commandMap, ChatbotCommand, SubscribeCommand, UnsubscribeCommand, ResponseCommand, ReminderCommand, CounterCommand, HeartboardCommand, VoicePingCommand };
