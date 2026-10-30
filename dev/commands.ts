import {
  ChatInputCommandInteraction,
  Snowflake, AutocompleteInteraction,
  EmbedBuilder, MessageFlags, SlashCommandBuilder,
  ChannelType,
  PermissionFlagsBits,
  ModalBuilder,
  ModalSubmitInteraction,
  LabelBuilder,
  TextInputBuilder,
  TextInputStyle,
  TextDisplayBuilder,
  CheckboxBuilder,
  CheckboxGroupBuilder,
} from 'discord.js';
import cron from 'node-cron';
import { Command, ConfigCommand } from './types/bot';
import { addChatbotSubscriber, addReminder, deleteAllHeartBoardEmojis, deleteAllVoicePingInputs, deleteAutomaticResponse, deleteChatbot,
  deleteConversationSummary, deleteHeartBoard, deleteConversation, deleteReminder, deleteVoicePing, getConversationsBySource, getAutomaticResponse, getAutomaticResponsesByServer, getChatbot,
  deleteCounter, deleteMemory, getConversationByChannel, getCounter, getCountersByServer, incrementCounter, insertCounter, setCounterValue, getConversationSummariesBySource, getHeartBoard, upsertMemory, getHeartBoardEmojis, getHeartBoardsByServer, getReminder, getRemindersByServer, getVoicePing,
  getVoicePingInputs, getVoicePingsByServer, insertAutomaticResponse, insertHeartBoard, insertHeartBoardEmoji,
  insertVoicePing, insertVoicePingInput, isChatbotSubscriber, getChatbotSubscriber, setChatbotSubscriberCrossServer, removeChatbotSubscriber, updateAutomaticResponse,
  updateHeartBoard, updateReminder, updateVoicePing, upsertChatbot, upsertConversationSummary,
  getHeartbeat, getHeartbeatsByServer, insertHeartbeat, updateHeartbeat } from './data';
import { AutomaticResponseTable, ChatbotTable, ConversationSummaryTable, ReminderTable, HeartbeatTable, HeartBoardTable, VoicePingTable } from './types/schema';
import { removeHeartbeat, scheduleHeartbeat } from './chatbot/heartbeat';
import { TOOL_GROUPS, getEmbedding, getSystemPrompt } from './chatbot/chatbot';
import { SOURCE_SEPARATOR, endConversation, fromSummarySource } from './chatbot/conversation';
import { MAIN_SOURCE, findMemory, getVisibleMemories, isAttached } from './chatbot/context';
import { fetchServerChannel } from './chatbot/dm';
import { DEFAULT_MODEL, DEFAULT_REASONING_EFFORT, DEFAULT_TEMPERATURE, MAX_TEMPERATURE, findModel, formatPricing, getModels, getSupportedEfforts, maxTemperature, supportsImages, supportsTemperature, supportsTools } from './chatbot/models';
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

const MODAL_TIMEOUT = 10 * 60_000; // 10 minutes to fill one in
const MODAL_TEXT_LIMIT = 4_000; // the most a modal's text box can hold

type TextFieldOptions = {
  description?: string,
  value?: string,
  placeholder?: string,
  paragraph?: boolean,
  maxLength?: number,
  required?: boolean,
};

// a labelled text box. ids only need to be unique within their own modal
function textField(id: string, label: string, options: TextFieldOptions = {}): LabelBuilder {
  const maxLength = options.maxLength ?? MODAL_TEXT_LIMIT;
  const input = new TextInputBuilder()
    .setCustomId(id)
    .setStyle(options.paragraph ? TextInputStyle.Paragraph : TextInputStyle.Short)
    .setMaxLength(maxLength)
    .setRequired(options.required ?? true);
  if (options.value) input.setValue(options.value.substring(0, maxLength));
  if (options.placeholder) input.setPlaceholder(options.placeholder.substring(0, 100));

  const field = new LabelBuilder().setLabel(label.substring(0, 45)).setTextInputComponent(input);
  if (options.description) field.setDescription(options.description.substring(0, 100));
  return field;
}

function checkboxField(id: string, label: string, description: string, checked = false): LabelBuilder {
  return new LabelBuilder().setLabel(label).setDescription(description)
    .setCheckboxComponent(new CheckboxBuilder().setCustomId(id).setDefault(checked));
}

// several yes/no settings in one field, since a modal only fits 5. each option's value is its key
function checkboxGroupField(id: string, label: string, options: { value: string, label: string, description: string, checked: boolean }[]): LabelBuilder {
  const group = new CheckboxGroupBuilder().setCustomId(id).setMinValues(0).setRequired(false)
    .setOptions(options.map((option) => ({ value: option.value, label: option.label, description: option.description, default: option.checked })));
  return new LabelBuilder().setLabel(label).setCheckboxGroupComponent(group);
}

// a text box only holds 4000 characters, so saving something longer would cut off its end. this says so up front
function overflowNote(text: string | undefined, what: string): TextDisplayBuilder | undefined {
  if (!text || text.length <= MODAL_TEXT_LIMIT) return undefined;
  return new TextDisplayBuilder().setContent(`⚠️ This ${what} is ${text.length.toLocaleString()} characters, but the box below only holds ${MODAL_TEXT_LIMIT.toLocaleString()}. `
    + `Saving will cut off the last ${(text.length - MODAL_TEXT_LIMIT).toLocaleString()}.`);
}

/**
 * Shows a modal, and waits for it to be sent. Undefined if it's closed or runs out of time,
 * which Discord never tells us about, so it isn't treated as an error
 */
async function askModal(interaction: ChatInputCommandInteraction, modal: ModalBuilder): Promise<ModalSubmitInteraction | undefined> {
  const modalID = `modal:${interaction.id}`;
  await interaction.showModal(modal.setCustomId(modalID));
  return interaction.awaitModalSubmit({ time: MODAL_TIMEOUT, filter: (submit) => submit.customId === modalID && submit.user.id === interaction.user.id })
    .catch(() => undefined);
}

// a modal can't be reopened from its own submission, so when one is turned down, the longest thing typed is handed back to copy
function rejectModal(submit: ModalSubmitInteraction, message: string, draft?: string): void {
  const room = 2000 - message.length - 80;
  const kept = draft && room > 0 ? `\n-# Here's what you wrote, so it isn't lost:\n\`\`\`\n${draft.replace(/```/g, '`​``').substring(0, room)}\n\`\`\`` : '';
  submit.reply({ content: `${message}${kept}`, flags: MessageFlags.Ephemeral }).catch((error) => console.error(error));
}

// what the schedule fields accept. both are stored as cron
const SCHEDULE_DESCRIPTION = 'Cron (e.g. 0 9 * * * for 9am daily), or a Discord timestamp like <t:1767225600:f>';
const INVALID_SCHEDULE_MESSAGE = 'That schedule isn\'t a valid cron schedule or Discord timestamp!';

// ==================== chatbot settings ====================
// a DM with the bot's owner runs these too, with its owner's user id as its server id

const NO_CHATBOT_MESSAGE = 'There is no chatbot here! Try making one with /chatbot create';

// option "query": a model id, filled in by modelChoices
async function setModel(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
  const chatbot = getChatbot(serverID);
  if (!chatbot) {
    interaction.reply({ content: NO_CHATBOT_MESSAGE, flags: MessageFlags.Ephemeral });
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
    : !efforts.includes(effort) ? `This model doesn't support the current \`${effort}\` reasoning effort. It supports ${efforts.join(', ')}.`
      : '';

  interaction.reply({
    content: `Switched to **${model.name}** (\`${model.id}\`)\n`
      + `-# ${formatPricing(model)} tokens · ${model.context_length.toLocaleString()} token context · tools ${hasTools ? 'supported' : 'not supported, so they\'ll be off while this model is in use'}`
      + (effortNote ? `\n${effortNote}` : ''),
    flags: MessageFlags.Ephemeral,
  });
}

// option "query": an effort level, filled in by effortChoices
async function setReasoningEffort(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
  const chatbot = getChatbot(serverID);
  if (!chatbot) {
    interaction.reply({ content: NO_CHATBOT_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const effort = interaction.options.getString('query')!.toLowerCase();
  const modelID = chatbot.model ?? DEFAULT_MODEL;
  const efforts = getSupportedEfforts(modelID);
  if (efforts.length === 0) {
    interaction.reply({ content: `\`${modelID}\` doesn't reason, so there's no effort to set. Try a different model!`, flags: MessageFlags.Ephemeral });
    return;
  }
  if (!efforts.includes(effort)) {
    interaction.reply({ content: `\`${modelID}\` doesn't support \`${effort}\`. It supports: ${efforts.join(', ')}`, flags: MessageFlags.Ephemeral });
    return;
  }

  chatbot.reasoning_effort = effort === DEFAULT_REASONING_EFFORT ? undefined : effort; // the default is stored as empty, like the model
  upsertChatbot(chatbot);
  interaction.reply({ content: `Reasoning effort set to **${effort}**!`, flags: MessageFlags.Ephemeral });
}

// option "value": a number from 0 to MAX_TEMPERATURE, or blank to reset
async function setTemperature(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
  const chatbot = getChatbot(serverID);
  if (!chatbot) {
    interaction.reply({ content: NO_CHATBOT_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  // blank resets it. the default is stored as empty, like the model, so it follows DEFAULT_TEMPERATURE if that changes
  const value = interaction.options.getNumber('value');
  chatbot.temperature = value === null || value === DEFAULT_TEMPERATURE ? undefined : value;
  upsertChatbot(chatbot);

  // some models ignore it, so say so rather than let it seem to do nothing
  const modelID = chatbot.model ?? DEFAULT_MODEL;
  const max = maxTemperature(modelID);
  const note = !supportsTemperature(modelID) ? `\n-# \`${modelID}\` ignores temperature, so this won't change anything until you switch to a model that uses it.`
    : (chatbot.temperature ?? DEFAULT_TEMPERATURE) > max ? `\n-# \`${modelID}\` only goes up to ${max}, so it'll use ${max} while this model is in use.`
      : '';
  interaction.reply({ content: `Temperature set to **${chatbot.temperature ?? `${DEFAULT_TEMPERATURE} (default)`}**!${note}`, flags: MessageFlags.Ephemeral });
}

// option "enable": whether tools are on. without it, a modal picks which groups of tools are on
async function setTools(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
  const enabledOption = interaction.options.getBoolean('enable');
  const chatbot = getChatbot(serverID);
  if (!chatbot) {
    interaction.reply({ content: NO_CHATBOT_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  if (enabledOption === null) {
    const groupOptions = (list: string) => TOOL_GROUPS.filter((group) => group.list === list)
      .map((group) => ({ value: group.key, label: group.label, description: group.description, checked: !chatbot.disabled_tools?.includes(group.key) }));
    const toolsModal = new ModalBuilder().setTitle('Chatbot Tools');
    if (!chatbot.tools_enabled) toolsModal.addTextDisplayComponents(new TextDisplayBuilder().setContent('⚠️ Tools are off here right now, so none of these are used until they\'re enabled again (`enable: True`).'));
    toolsModal.addLabelComponents(
      checkboxGroupField('discord', 'Discord', groupOptions('discord')),
      checkboxGroupField('other', 'Web, workspace, and other', groupOptions('other')),
    );

    const submit = await askModal(interaction, toolsModal);
    if (!submit) return;

    const enabled = [...submit.fields.getCheckboxGroup('discord'), ...submit.fields.getCheckboxGroup('other')];
    chatbot.disabled_tools = TOOL_GROUPS.map((group) => group.key).filter((key) => !enabled.includes(key));
    upsertChatbot(chatbot);

    const disabled = TOOL_GROUPS.filter((group) => chatbot.disabled_tools!.includes(group.key)).map((group) => group.label);
    submit.reply({ content: disabled.length > 0 ? `Saved! Turned off: ${disabled.join(', ')}.` : 'Saved! Every tool is on.', flags: MessageFlags.Ephemeral });
    return;
  }

  if (enabledOption === chatbot.tools_enabled) {
    interaction.reply({ content: `Tools are already ${enabledOption ? 'enabled' : 'disabled'} here!`, flags: MessageFlags.Ephemeral });
    return;
  }

  chatbot.tools_enabled = enabledOption;
  upsertChatbot(chatbot);
  interaction.reply({ content: `Tools ${enabledOption ? 'enabled' : 'disabled'}!`, flags: MessageFlags.Ephemeral });
}

/**
 * Sets the persona (layered on top of the system prompt), or the system prompt override (replacing SYSTEM.md), in a modal.
 * The override starts from the current system prompt, so it can be tweaked rather than written from scratch
 */
async function setPrompt(interaction: ChatInputCommandInteraction, serverID: Snowflake, kind: 'persona' | 'system-prompt'): Promise<void> {
  const chatbot = getChatbot(serverID);
  if (!chatbot) {
    interaction.reply({ content: NO_CHATBOT_MESSAGE, flags: MessageFlags.Ephemeral });
    return;
  }

  const isPersona = kind === 'persona';
  const promptName = isPersona ? 'persona' : 'system prompt override';
  const promptModal = new ModalBuilder().setTitle(isPersona ? 'Set Persona' : 'Override System Prompt');

  const currentPrompt = isPersona ? chatbot.chatbot_prompt : getSystemPrompt(chatbot);
  const note = overflowNote(currentPrompt, isPersona ? 'persona' : 'system prompt');
  if (note) promptModal.addTextDisplayComponents(note);
  promptModal.addLabelComponents(isPersona
    ? textField('prompt', 'Persona', {
      paragraph: true,
      value: currentPrompt,
      required: false,
      placeholder: 'e.g. You\'re a laid-back pirate who loves puns, and calls everyone "matey".',
      description: 'Who the chatbot is here, added on top of the system prompt. Empty for none',
    })
    : textField('prompt', 'System prompt', {
      paragraph: true,
      value: currentPrompt,
      required: false,
      description: 'Replaces SYSTEM.md here. Empty to go back to SYSTEM.md',
    }));

  const submit = await askModal(interaction, promptModal);
  if (!submit) return;

  const newPrompt = submit.fields.getTextInputValue('prompt').trim();
  if (isPersona) chatbot.chatbot_prompt = newPrompt;
  else chatbot.system_prompt_override = newPrompt || undefined;
  upsertChatbot(chatbot);

  const result = newPrompt ? `updated ${promptName}` : `cleared ${promptName}${isPersona ? '' : ', so SYSTEM.md is used again'}`;
  submit.reply({ content: `Successfully ${result}!`, flags: MessageFlags.Ephemeral });
}

// models matching what's typed, by id or name. ids starting with it come first, e.g. "anthropic/" lists anthropic's models
async function modelChoices(interaction: AutocompleteInteraction): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const matches = getModels()
    .filter((model) => model.id.toLowerCase().includes(focusedValue) || model.name.toLowerCase().includes(focusedValue))
    .sort((a, b) => Number(b.id.toLowerCase().startsWith(focusedValue)) - Number(a.id.toLowerCase().startsWith(focusedValue)))
    .slice(0, 25);

  await interaction.respond(matches.map((model) => ({
    name: `${model.name} · tools ${supportsTools(model.id) ? '✓' : '✗'} · vision ${supportsImages(model.id) ? '✓' : '✗'} · ${formatPricing(model)}`.substring(0, 100),
    value: model.id.substring(0, 100),
  })));
}

// only the effort levels the current model supports, marking its own default
async function effortChoices(interaction: AutocompleteInteraction, serverID: Snowflake): Promise<void> {
  const focusedValue = interaction.options.getFocused().toLowerCase();
  const modelID = getChatbot(serverID)?.model ?? DEFAULT_MODEL;
  const modelDefault = findModel(modelID)?.reasoning?.default_effort;

  await interaction.respond(getSupportedEfforts(modelID)
    .filter((effort) => effort.includes(focusedValue))
    .map((effort) => ({ name: effort === modelDefault ? `${effort} (model's default)` : effort, value: effort })));
}

const ChatbotCommand: ConfigCommand = {
  data: new SlashCommandBuilder()
    .setName('chatbot').setDescription('Chatbot for the server.').setDefaultMemberPermissions(PermissionFlagsBits.Administrator)
    .addSubcommand((createSubcommand) => createSubcommand.setName('create')
      .setDescription('Create the chatbot for a server that doesn\'t currently have one.'))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete')
      .setDescription('Remove the chatbot for a server that already has one.'))
    .addSubcommand((toolSubcommand) => toolSubcommand.setName('tools').setDescription('Turn tool use on or off, or leave out "enable" to choose which tools are on')
      .addBooleanOption((enabledOption) => enabledOption.setName('enable').setDescription('Enable or disable tool use. True = Enable, False = Disable')))
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
    .addSubcommand((temperatureSubcommand) => temperatureSubcommand.setName('temperature')
      .setDescription('Change how random the chatbot\'s replies are. Lower is more focused, higher is more creative')
      .addNumberOption((valueOption) => valueOption.setName('value')
        .setDescription(`From 0 to ${MAX_TEMPERATURE}. Leave blank to reset to the default, ${DEFAULT_TEMPERATURE}`)
        .setMinValue(0)
        .setMaxValue(MAX_TEMPERATURE)))
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
    .addSubcommand((clearMemoryCommand) => clearMemoryCommand.setName('clear-memory').setDescription('Clears this server\'s conversations and summaries. Memories are kept'))
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
          .setAutocomplete(true)))
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
        // where a memory lives is picked when it's made, and only attached servers can share
        const canShare = !existingMemory && isAttached(serverID);

        const memoryModal = new ModalBuilder().setTitle(`${existingMemory ? 'Edit' : 'Create'} Memory`);
        const note = overflowNote(existingMemory?.content, 'memory');
        if (note) memoryModal.addTextDisplayComponents(note);
        memoryModal.addLabelComponents(
          textField('name', 'Name', {
            value: existingMemory?.name ?? name!,
            maxLength: 100,
            description: existingMemory ? 'Change it to rename the memory. Not case-sensitive' : 'Not case-sensitive',
          }),
          textField('content', 'Content', {
            paragraph: true,
            value: existingMemory?.content,
            placeholder: 'e.g. Sam\'s birthday is March 3rd, and they love lemon cake.',
            description: 'What the chatbot remembers. It can look this up in any conversation',
          }),
        );
        if (canShare) memoryModal.addLabelComponents(checkboxField('shared', 'Share with other servers', 'Every attached server can see it. Can\'t be changed later'));

        const submit = await askModal(interaction, memoryModal);
        if (!submit) return;

        const newName = submit.fields.getTextInputValue('name').trim();
        const content = submit.fields.getTextInputValue('content');
        const shared = canShare && submit.fields.getCheckbox('shared');

        // a rename can't take another memory's name. a change of casing is fine, since names aren't case-sensitive
        const clash = findMemory(serverID, newName);
        const isSelf = existingMemory && clash && clash.source_id === existingMemory.source_id && clash.name.toLowerCase() === existingMemory.name.toLowerCase();
        if (clash && !isSelf) {
          rejectModal(submit, `There's already a memory named "${clash.name}"!`, content);
          return;
        }

        // an existing memory stays where it is. the old row goes first, so a casing-only rename isn't deleted along with it
        const sourceID = existingMemory?.source_id ?? (shared ? MAIN_SOURCE : serverID);
        if (existingMemory && existingMemory.name !== newName) deleteMemory(existingMemory.source_id, existingMemory.name);
        upsertMemory({ source_id: sourceID, name: newName, content });

        const renamed = existingMemory && existingMemory.name !== newName ? `, renamed to "${newName}"` : '';
        submit.reply({ content: `Successfully ${existingMemory ? 'updated' : 'created'} ${sourceID === MAIN_SOURCE ? 'shared ' : ''}memory${renamed}!`, flags: MessageFlags.Ephemeral });
        return;
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

        const summaryModal = new ModalBuilder().setTitle(`Edit ${summaryScopeLabel(summary)} summary · ${new Date(summary.timestamp).toLocaleDateString()}`.substring(0, 45));
        const note = overflowNote(summary.summary, 'summary');
        if (note) summaryModal.addTextDisplayComponents(note);
        summaryModal.addLabelComponents(textField('summary', 'Summary', {
          paragraph: true,
          value: summary.summary,
          description: 'What the chatbot recalls about this conversation, when it comes up again',
        }));

        const submit = await askModal(interaction, summaryModal);
        if (!submit) return;

        await submit.deferReply({ flags: MessageFlags.Ephemeral }); // embedding can take longer than discord's 3 second reply window
        const newSummary = submit.fields.getTextInputValue('summary');
        try {
          // re-embed, so relevant summary lookup matches the new text
          upsertConversationSummary({ ...summary, summary: newSummary, embedding: await getEmbedding(newSummary) });
          submit.editReply({ content: 'Successfully updated summary!' });
        } catch (error) {
          console.error(error);
          submit.editReply({ content: `Failed to save the summary.\n-# Here's what you wrote, so it isn't lost:\n\`\`\`\n${newSummary.substring(0, 1850)}\n\`\`\`` });
        }
        return;
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
        await setPrompt(interaction, serverID, isPersona ? 'persona' : 'system-prompt');
        return;
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
      await setModel(interaction, serverID);
      return;
    }
    if (subcommand === 'reasoning-effort') {
      await setReasoningEffort(interaction, serverID);
      return;
    }
    if (subcommand === 'temperature') {
      await setTemperature(interaction, serverID);
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
      // only this server's conversations. deleting them also deletes their messages, summaries, tool results, and index
      const conversations = getConversationsBySource(serverID);

      if (conversations.length === 0) {
        interaction.reply({ content: 'There are no conversations to clear in this server!', flags: MessageFlags.Ephemeral });
        return;
      }

      const conversationIDs = new Set(conversations.map((conversation) => conversation.conversation_id));
      const summaryCount = getServerSummaries(serverID).filter((summary) => conversationIDs.has(summary.conversation_id)).length;
      const plural = (count: number, word: string) => `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`;

      const confirmModal = new ModalBuilder().setTitle('Clear Memory')
        .addTextDisplayComponents(new TextDisplayBuilder().setContent(`This deletes **${plural(conversations.length, 'conversation')}** and **${plural(summaryCount, 'summary').replace(/ys$/, 'ies')}** from this server, `
          + 'including the copies shared with other servers. The chatbot will forget them for good.\n\nMemories are kept.'))
        .addLabelComponents(checkboxField('confirm', 'Yes, delete them', 'This can\'t be undone'));

      const submit = await askModal(interaction, confirmModal);
      if (!submit) return;
      if (!submit.fields.getCheckbox('confirm')) {
        submit.reply({ content: 'Nothing was deleted, since the box wasn\'t ticked.', flags: MessageFlags.Ephemeral });
        return;
      }

      // cancel their pending summaries, since there'll be nothing left to summarize
      cron.getTasks().forEach((task) => {
        if (task.name && conversationIDs.has(task.name)) task.destroy();
      });
      conversations.forEach((conversation) => deleteConversation(conversation.conversation_id));

      submit.reply({ content: `Successfully cleared ${plural(conversations.length, 'conversation')} and their summaries!`, flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'tools') {
      await setTools(interaction, serverID);
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
        { name: 'Tools Turned Off', value: TOOL_GROUPS.filter((group) => chatbot?.disabled_tools?.includes(group.key)).map((group) => group.label).join(', ') || 'None' },
        { name: 'Context', value: (chatbot?.detached ? 'Detached (this server only)' : 'Shared with other servers (for opted-in users)') },
        { name: 'System Prompt', value: (chatbot?.system_prompt_override ? 'Overridden for this server' : 'Default (SYSTEM.md)') },
        { name: 'Persona', value: (chatbot?.chatbot_prompt ? 'Set' : 'None') },
        { name: 'Model', value: chatbot?.model ?? `${DEFAULT_MODEL} (default)` },
        { name: 'Reasoning Effort', value: chatbot?.reasoning_effort ?? `${DEFAULT_REASONING_EFFORT} (default)` },
        { name: 'Temperature', value: String(chatbot?.temperature ?? `${DEFAULT_TEMPERATURE} (default)`) },
      );
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused().toLowerCase();

    if (interaction.options.getSubcommand() === 'model') {
      await modelChoices(interaction);
      return;
    }
    if (interaction.options.getSubcommand() === 'reasoning-effort') {
      await effortChoices(interaction, serverID);
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
      .setDescription('Creates an automated, generated response, when a specific phrase is sent'))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit')
      .setDescription('Edit pre-existing responses')
      .addStringOption((nameOption) => nameOption.setName('name')
        .setDescription('Name of the response to edit')
        .setAutocomplete(true)
        .setRequired(true)))
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

    // create and edit share one modal, filled in with the response being edited
    if (subCommand === 'create' || subCommand === 'edit') {
      const existing = subCommand === 'edit' ? getAutomaticResponse(serverID, interaction.options.getString('name')!) : undefined;
      if (subCommand === 'edit' && !existing) {
        interaction.reply({ content: 'No server responses with that name were found. Ensure you spelled it correctly!', flags: MessageFlags.Ephemeral });
        return;
      }

      const responseModal = new ModalBuilder().setTitle(existing ? `Edit Response: ${existing.name}`.substring(0, 45) : 'Create Response');
      if (!existing) responseModal.addLabelComponents(textField('name', 'Name', { maxLength: 100, placeholder: 'e.g. Twitter links' }));
      responseModal.addLabelComponents(
        textField('activation', 'Activation regex', {
          value: existing?.activation_regex, maxLength: 1000, placeholder: 'e.g. https://(www\\.)?(twitter|x)\\.com/\\S+', description: 'A message matching this sets off the response',
        }),
        textField('capture', 'Capture regex', {
          value: existing?.capture_regex, maxLength: 1000, placeholder: 'e.g. (twitter|x)\\.com/(\\S+)', description: 'Its groups, in brackets, fill in {1}, {2}, ... in the output',
        }),
        textField('output', 'Output template', {
          paragraph: true, value: existing?.output_template, maxLength: 2000, placeholder: 'e.g. https://fxtwitter.com/{2}', description: 'What the bot sends. {1}, {2}, ... are the capture regex\'s groups',
        }),
        checkboxField('enabled', 'Enabled', 'Whether it responds to messages yet', existing ? !!existing.enabled : true),
      );

      const submit = await askModal(interaction, responseModal);
      if (!submit) return;

      const name = existing?.name ?? submit.fields.getTextInputValue('name').trim();
      const response: AutomaticResponseTable = {
        server_id: serverID,
        name,
        enabled: submit.fields.getCheckbox('enabled'),
        activation_regex: submit.fields.getTextInputValue('activation'),
        capture_regex: submit.fields.getTextInputValue('capture'),
        output_template: submit.fields.getTextInputValue('output'),
      };

      if (!existing && getAutomaticResponse(serverID, name)) {
        rejectModal(submit, `There's already a response named "${name}"!`, response.output_template);
        return;
      }
      // checked here, since a bad regex would otherwise only fail once a message comes in
      for (const [label, pattern] of [['activation', response.activation_regex], ['capture', response.capture_regex]]) {
        try {
          new RegExp(pattern); // eslint-disable-line no-new
        } catch (error: any) {
          rejectModal(submit, `The ${label} regex isn't valid: ${error.message}`, response.output_template);
          return;
        }
      }

      if (existing) updateAutomaticResponse(response);
      else insertAutomaticResponse(response);
      submit.reply({ content: `Successfully ${existing ? 'edited' : 'created'} response!`, embeds: [ResponseCommand.configEmbedBuilder(serverID, response)], flags: MessageFlags.Ephemeral });
      return;
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
        { name: 'Output Template', value: automaticResponse.output_template.replace('https://', 'https​://') }, // invisible character to stop "{1}" displaying as "%7B1%7D" in link
      ]);
  },
};

const ReminderCommand: ConfigCommand = {
  data: new SlashCommandBuilder().setName('reminder').setDescription('Create a reminder for a later date, or a reoccuring reminder')
    .addSubcommand((addSubcommand) => addSubcommand.setName('add').setDescription('Add a reminder')
      .addChannelOption((channelOption) => channelOption.setName('output-channel').setDescription('Channel the reminder is sent to. Defaults to this one')
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildAnnouncement, ChannelType.PrivateThread, ChannelType.GuildVoice)))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit').setDescription('Edit a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the reminder to edit')
        .setRequired(true).setAutocomplete(true))
      .addChannelOption((channelOption) => channelOption.setName('output-channel').setDescription('New channel to send it to')
        .addChannelTypes(ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildAnnouncement, ChannelType.PrivateThread, ChannelType.GuildVoice)))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view').setDescription('View the contents of a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the reminder')
        .setRequired(true).setAutocomplete(true)))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete').setDescription('Delete a reminder')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the reminder')
        .setRequired(true).setAutocomplete(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
    const subcommand = interaction.options.getSubcommand();

    // add and edit share one modal, filled in with the reminder being edited
    if (subcommand === 'add' || subcommand === 'edit') {
      const existing = subcommand === 'edit' ? getReminder(serverID, interaction.options.getString('name')!) : undefined;
      if (subcommand === 'edit' && !existing) {
        interaction.reply({ content: 'There is no reminder with this name! Please ensure you\'ve spelled it correctly!', flags: MessageFlags.Ephemeral });
        return;
      }

      // checked before the modal, so a bad channel doesn't throw away what was typed
      const channelOption = interaction.options.getChannel('output-channel');
      const outputChannel = await fetchServerChannel(serverID, channelOption?.id ?? existing?.channel_id ?? interaction.channelId);
      if (!outputChannel?.isSendable()) {
        interaction.reply({ content: 'The bot can\'t send messages in that channel!', flags: MessageFlags.Ephemeral });
        return;
      }

      const reminderModal = new ModalBuilder().setTitle(existing ? `Edit Reminder: ${existing.reminder_name}`.substring(0, 45) : 'Add Reminder');
      if (!existing) reminderModal.addLabelComponents(textField('name', 'Name', { maxLength: 40, placeholder: 'e.g. Med Alarm' }));
      reminderModal.addLabelComponents(
        textField('schedule', 'Schedule', { value: existing?.cron_schedule, maxLength: 40, placeholder: '0 22 * * *', description: SCHEDULE_DESCRIPTION }),
        textField('message', 'Message', {
          paragraph: true, value: existing?.message_content, maxLength: 2000, placeholder: 'e.g. It\'s time to take your meds!', description: `What's sent in ${'name' in outputChannel ? `#${outputChannel.name}` : 'this DM'}`,
        }),
        checkboxField('repeats', 'Repeats', 'Keep sending it on the schedule. Otherwise it\'s sent once, then deleted', !!existing?.repeats),
      );

      const submit = await askModal(interaction, reminderModal);
      if (!submit) return;

      const name = existing?.reminder_name ?? submit.fields.getTextInputValue('name').trim();
      const message = submit.fields.getTextInputValue('message');
      if (!existing && getReminder(serverID, name)) {
        rejectModal(submit, `There's already a reminder named "${name}"!`, message);
        return;
      }
      // either a cron schedule, or a discord timestamp turned into one
      const cronSchedule = inputToSchedule(submit.fields.getTextInputValue('schedule').trim());
      if (!cronSchedule) {
        rejectModal(submit, INVALID_SCHEDULE_MESSAGE, message);
        return;
      }

      const reminder: ReminderTable = {
        server_id: serverID,
        reminder_name: name,
        channel_id: outputChannel.id,
        repeats: submit.fields.getCheckbox('repeats'),
        cron_schedule: cronSchedule,
        message_content: message,
      };
      if (existing) updateReminder(reminder);
      else addReminder(reminder);

      // (re)scheduled every time, since it's cheap, and the schedule or channel may have changed
      const taskName = `${serverID}${name}`;
      cron.getTasks().forEach((task) => {
        if (task.name === taskName) task.destroy();
      });
      cron.schedule(cronSchedule, () => sendReminder(outputChannel, serverID, name), { name: taskName });

      submit.reply({ content: `Successfully ${existing ? 'updated' : 'created'} reminder!`, embeds: [this.configEmbedBuilder(serverID, reminder)], flags: MessageFlags.Ephemeral });
      return;
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

const HEARTBEAT_CHANNEL_TYPES = [ChannelType.GuildText, ChannelType.PublicThread, ChannelType.GuildAnnouncement, ChannelType.PrivateThread, ChannelType.GuildVoice] as const;

const HeartbeatCommand: ConfigCommand = {
  data: new SlashCommandBuilder().setName('heartbeat').setDescription('Give the chatbot a prompt on a schedule, so it can post on its own')
    .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild) // each beat is a model call that runs by itself
    .addSubcommand((addSubcommand) => addSubcommand.setName('add').setDescription('Add a heartbeat')
      .addChannelOption((channelOption) => channelOption.setName('channel').setDescription('Channel it posts in. Defaults to this one')
        .addChannelTypes(...HEARTBEAT_CHANNEL_TYPES)))
    .addSubcommand((editSubcommand) => editSubcommand.setName('edit').setDescription('Edit a heartbeat')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the heartbeat to edit')
        .setRequired(true).setAutocomplete(true))
      .addChannelOption((channelOption) => channelOption.setName('channel').setDescription('New channel to post in')
        .addChannelTypes(...HEARTBEAT_CHANNEL_TYPES)))
    .addSubcommand((viewSubcommand) => viewSubcommand.setName('view').setDescription('View a heartbeat, or every heartbeat in this server')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the heartbeat. Leave blank to view all')
        .setAutocomplete(true)))
    .addSubcommand((deleteSubcommand) => deleteSubcommand.setName('delete').setDescription('Delete a heartbeat')
      .addStringOption((nameOption) => nameOption.setName('name').setDescription('Name of the heartbeat')
        .setRequired(true).setAutocomplete(true))),
  async execute(interaction: ChatInputCommandInteraction, serverID: Snowflake): Promise<void> {
    const subcommand = interaction.options.getSubcommand();
    const nameOption = interaction.options.getString('name');

    // add and edit share one modal, filled in with the heartbeat being edited
    if (subcommand === 'add' || subcommand === 'edit') {
      const existing = subcommand === 'edit' ? getHeartbeat(serverID, nameOption!) : undefined;
      if (subcommand === 'edit' && !existing) {
        interaction.reply({ content: 'There is no heartbeat by this name, ensure you\'ve spelled it correctly', flags: MessageFlags.Ephemeral });
        return;
      }
      const channelID = interaction.options.getChannel('channel')?.id ?? existing?.channel_id ?? interaction.channelId;

      const heartbeatModal = new ModalBuilder().setTitle(existing ? `Edit Heartbeat: ${existing.heartbeat_name}`.substring(0, 45) : 'Add Heartbeat');
      if (!existing) heartbeatModal.addLabelComponents(textField('name', 'Name', { maxLength: 40, placeholder: 'e.g. Morning check-in', description: 'Not case-sensitive' }));
      heartbeatModal.addLabelComponents(
        textField('schedule', 'Schedule', { value: existing?.cron_schedule, maxLength: 40, placeholder: '0 9 * * *', description: SCHEDULE_DESCRIPTION }),
        textField('prompt', 'Prompt', {
          paragraph: true, value: existing?.prompt, placeholder: 'e.g. Post a short good morning, and mention any reminders due today.', description: 'What the chatbot is told each time it runs',
        }),
        textField('context', 'Context', {
          paragraph: true, value: existing?.context, required: false, description: 'Optional background shown with the prompt. It doesn\'t see the channel unless it looks',
        }),
        checkboxGroupField('options', 'Options', [
          { value: 'repeats', label: 'Repeats', description: 'Keep running on the schedule. Otherwise it runs once, then deletes itself', checked: !!existing?.repeats },
          { value: 'silent', label: 'Silent', description: 'Never post its reply, for heartbeats that only use tools', checked: !!existing?.silent },
        ]),
      );

      const submit = await askModal(interaction, heartbeatModal);
      if (!submit) return;

      const name = existing?.heartbeat_name ?? submit.fields.getTextInputValue('name').trim();
      const prompt = submit.fields.getTextInputValue('prompt');
      if (!existing && getHeartbeat(serverID, name)) {
        rejectModal(submit, `There's already a heartbeat named "${name}"!`, prompt);
        return;
      }
      // both cron and Discord timestamps are accepted, and stored as cron
      const cronSchedule = inputToSchedule(submit.fields.getTextInputValue('schedule').trim());
      if (!cronSchedule) {
        rejectModal(submit, INVALID_SCHEDULE_MESSAGE, prompt);
        return;
      }

      const options = submit.fields.getCheckboxGroup('options');
      const heartbeat: HeartbeatTable = {
        server_id: serverID,
        heartbeat_name: name,
        channel_id: channelID,
        created_by: existing?.created_by ?? interaction.user.id,
        repeats: options.includes('repeats'),
        silent: options.includes('silent'),
        cron_schedule: cronSchedule,
        prompt,
        context: submit.fields.getTextInputValue('context').trim() || undefined,
      };
      if (existing) updateHeartbeat(heartbeat);
      else insertHeartbeat(heartbeat);
      scheduleHeartbeat(heartbeat);

      submit.reply({ content: `Successfully ${existing ? 'updated' : 'created'} heartbeat!`, embeds: [this.configEmbedBuilder(serverID, heartbeat)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'view' && !nameOption) {
      const heartbeats = getHeartbeatsByServer(serverID);
      if (heartbeats.length === 0) {
        interaction.reply({ content: 'There are no heartbeats in this server! Try making one with /heartbeat add', flags: MessageFlags.Ephemeral });
        return;
      }

      const heartbeatEmbed = new EmbedBuilder().setTitle('Heartbeats')
        .setDescription(heartbeats.map((hb) => `**${hb.heartbeat_name}**: \`${hb.cron_schedule}\` in <#${hb.channel_id}>${hb.repeats ? '' : ' (once)'}${hb.silent ? ' (silent)' : ''}`).join('\n').substring(0, 4096));
      interaction.reply({ embeds: [heartbeatEmbed], flags: MessageFlags.Ephemeral });
      return;
    }

    // every other subcommand works on an existing heartbeat
    const heartbeat = getHeartbeat(serverID, nameOption!);
    if (!heartbeat) {
      interaction.reply({ content: 'There is no heartbeat by this name, ensure you\'ve spelled it correctly', flags: MessageFlags.Ephemeral });
      return;
    }

    if (subcommand === 'view') {
      interaction.reply({ embeds: [this.configEmbedBuilder(serverID, heartbeat)], flags: MessageFlags.Ephemeral });
      return;
    }
    if (subcommand === 'delete') {
      removeHeartbeat(heartbeat);
      interaction.reply({ content: `Successfully deleted heartbeat **${heartbeat.heartbeat_name}**!`, flags: MessageFlags.Ephemeral });
    }
  },
  async autocomplete(interaction: AutocompleteInteraction, serverID: Snowflake) {
    const focusedValue = interaction.options.getFocused().toLowerCase();

    const filtered = getHeartbeatsByServer(serverID)
      .filter((hb) => hb.heartbeat_name.toLowerCase().includes(focusedValue))
      .slice(0, 25);
    await interaction.respond(filtered.map((hb) => ({ name: hb.heartbeat_name, value: hb.heartbeat_name })));
  },
  configEmbedBuilder(serverID: Snowflake, heartbeat: HeartbeatTable) {
    return new EmbedBuilder().setTitle('Heartbeat Settings')
      .addFields(
        { name: 'Name', value: heartbeat.heartbeat_name },
        { name: 'Channel', value: `<#${heartbeat.channel_id}>` },
        { name: 'Schedule', value: `\`${heartbeat.cron_schedule}\`` },
        { name: 'Repeats', value: heartbeat.repeats ? 'Yes' : 'No, runs once' },
        { name: 'Silent', value: heartbeat.silent ? 'Yes, its reply is never posted' : 'No' },
        { name: 'Made by', value: `<@${heartbeat.created_by}>` },
        { name: 'Prompt', value: heartbeat.prompt.substring(0, 1024) },
        { name: 'Context', value: heartbeat.context?.substring(0, 1024) || 'None' },
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
commandMap.set(HeartbeatCommand.data.name, HeartbeatCommand);
commandMap.set(CounterCommand.data.name, CounterCommand);

// the commands a DM with the bot's owner has too. the rest are built around things only servers have: members, voice channels, reactions on a board
const dmCommandMap: Map<string, Command> = new Map();
[ChatbotCommand, ReminderCommand, HeartbeatCommand, CounterCommand].forEach((command) => dmCommandMap.set(command.data.name, command));

export { commandMap, dmCommandMap, ChatbotCommand, SubscribeCommand, UnsubscribeCommand, ResponseCommand, ReminderCommand, HeartbeatCommand, CounterCommand, HeartboardCommand, VoicePingCommand };
