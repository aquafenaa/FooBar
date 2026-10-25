// slash commands for a DM with the bot's owner, which change the DM's own chatbot settings. they're registered for DMs only, and only
// users in DM_USERS can use them (events.ts checks). each does what the /chatbot subcommand of the same name does in a server,
// with the same option names, so they share its code. /private is a text command instead (see chatbot/dm.ts), so nobody else ever sees it
import { ChatInputCommandInteraction, MessageFlags, SlashCommandBuilder, Snowflake } from 'discord.js';

import { Command } from './types/bot';
import { getChatbot } from './data';
import { ChatbotCommand, effortChoices, modelChoices, setModel, setPrompt, setReasoningEffort, setTemperature, setTools } from './commands';
import { DEFAULT_TEMPERATURE, MAX_TEMPERATURE } from './chatbot/models';

const ModelCommand: Command = {
  data: new SlashCommandBuilder().setName('model').setDescription('Change the AI model the chatbot uses in this DM, from any model on OpenRouter')
    .addStringOption((queryOption) => queryOption.setName('query').setDescription('Search for a model by name or ID, e.g. "glm" or "anthropic/"')
      .setRequired(true)
      .setAutocomplete(true)),
  execute: (interaction, serverID) => setModel(interaction as ChatInputCommandInteraction, serverID),
  autocomplete: (interaction) => modelChoices(interaction),
};

const EffortCommand: Command = {
  data: new SlashCommandBuilder().setName('effort').setDescription('Change how much the chatbot thinks before replying. Options depend on the current model')
    .addStringOption((queryOption) => queryOption.setName('query').setDescription('The effort level, e.g. "low" or "high"')
      .setRequired(true)
      .setAutocomplete(true)),
  execute: (interaction, serverID) => setReasoningEffort(interaction as ChatInputCommandInteraction, serverID),
  autocomplete: (interaction, serverID) => effortChoices(interaction, serverID),
};

const TemperatureCommand: Command = {
  data: new SlashCommandBuilder().setName('temperature').setDescription('Change how random the chatbot\'s replies are. Lower is more focused, higher is more creative')
    .addNumberOption((valueOption) => valueOption.setName('value').setDescription(`From 0 to ${MAX_TEMPERATURE}. Leave blank to reset to the default, ${DEFAULT_TEMPERATURE}`)
      .setMinValue(0)
      .setMaxValue(MAX_TEMPERATURE)),
  execute: (interaction, serverID) => setTemperature(interaction as ChatInputCommandInteraction, serverID),
};

const PersonaCommand: Command = {
  data: new SlashCommandBuilder().setName('persona').setDescription('Set the chatbot\'s persona in this DM, added on top of the system prompt. Leave it empty to clear it'),
  execute: (interaction, serverID) => setPrompt(interaction as ChatInputCommandInteraction, serverID, 'persona'),
};

const ToolsCommand: Command = {
  data: new SlashCommandBuilder().setName('tools').setDescription('Whether the chatbot can use tools in this DM')
    .addBooleanOption((enableOption) => enableOption.setName('enable').setDescription('True = Enable, False = Disable')
      .setRequired(true)),
  execute: (interaction, serverID) => setTools(interaction as ChatInputCommandInteraction, serverID),
};

const StatusCommand: Command = {
  data: new SlashCommandBuilder().setName('status').setDescription('View the chatbot\'s settings in this DM'),
  async execute(interaction, serverID: Snowflake) {
    const chatbot = getChatbot(serverID)!;
    const embed = ChatbotCommand.configEmbedBuilder('DM Settings', chatbot)
      .setFooter({ text: chatbot.detached ? 'Private: send /private to share memory again' : 'Shared: send /private to keep memory to this DM' });
    await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
  },
};

const dmCommandMap = new Map<string, Command>();
[ModelCommand, EffortCommand, TemperatureCommand, PersonaCommand, ToolsCommand, StatusCommand].forEach((command) => dmCommandMap.set(command.data.name, command));

export { dmCommandMap };
