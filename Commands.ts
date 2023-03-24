/* eslint-disable consistent-return, no-param-reassign */
import {
  Channel,
  ChannelType,
  ChatInputCommandInteraction,
  EmbedBuilder, SlashCommandBuilder, TextChannel,
} from 'discord.js';
import { Command, ICommand, Config, Server } from './Types';

function buildCommand(command: ICommand) {
  const commandBuilder = new SlashCommandBuilder();

  commandBuilder.setName(command.name);
  commandBuilder.setDescription(command.description);

  if (command.subCommandGroups) {
    command.subCommandGroups.forEach((commandGroup) => {
      if (commandGroup.subCommands) {
        commandBuilder.addSubcommandGroup((group) => {
          group.setName(commandGroup.name);
          group.setDescription(commandGroup.description);

          commandGroup.subCommands!.forEach((subcommand) => {
            group.addSubcommand((subCommandBuilder) => {
              subCommandBuilder.setName(subcommand.name);
              subCommandBuilder.setDescription(subcommand.description);

              if (subcommand.options) {
                subcommand.options.forEach((option) => {
                  if (option.type === 'string') {
                    subCommandBuilder.addStringOption((subcommandOption) => {
                      subcommandOption.setName(option.name);
                      subcommandOption.setDescription(option.description);

                      return subcommandOption;
                    });
                  } else if (option.type === 'boolean') {
                    subCommandBuilder.addBooleanOption((subcommandOption) => {
                      subcommandOption.setName(option.name);
                      subcommandOption.setDescription(option.description);

                      return subcommandOption;
                    });
                  } else if (option.type === 'channel') {
                    subCommandBuilder.addChannelOption((subcommandOption) => {
                      subcommandOption.setName(option.name);
                      subcommandOption.setDescription(option.description);

                      return subcommandOption;
                    });
                  } else {
                    console.log(`[ERROR]: Unknown type ${option.type} loaded in command ${subcommand.name}`);
                  }
                });
              }

              return subCommandBuilder;
            });
          });

          return group;
        });
      } else {
        commandBuilder.addSubcommand((subcommand) => {
          subcommand.setName(commandGroup.name);
          subcommand.setDescription(commandGroup.description);

          return subcommand;
        });
      }
    });
  }

  return commandBuilder;
}

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

const voicePingCommand: ICommand = {
  name: 'voiceping',
  description: 'Sends a message when a user joins a voice channel',
  subCommandGroups: [
    {
      name: 'test',
      description: 'Test the voice ping message to the output channel',
    },
    {
      name: 'settings',
      description: 'View and edit the voice ping settings',
      subCommands: [
        {
          name: 'view',
          description: 'View the current voice ping settings',
        },
        {
          name: 'edit',
          description: 'Edit the current voice ping settings',
          options: [
            {
              type: 'boolean',
              name: 'enabled',
              description: 'Enter "True" to enable, or "False" to disable.',
            },
            {
              type: 'string',
              name: 'message',
              description: 'Message to send when a user joins. {user} mentions the user, and {channel} mentions the channel.',
            },
            {
              type: 'string',
              name: 'inputs',
              description: 'The channels the bot is listening for voice users joining. Enter channel IDs seperated by a space.',
            },
            {
              type: 'channel',
              name: 'output',
              description: 'Desired channel to output the message to',
            }],
        }],
    }],
};

const VoicePing: Command = {
  data: buildCommand(voicePingCommand),
  async execute(interaction: ChatInputCommandInteraction, config?: Config): Promise<void | Config> {
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

        config.servers[index] = server;
        return config;
      }
    }
  },
};

const commandMap: Map<string, Command> = new Map();
commandMap.set(VoicePing.data.name, VoicePing);

export { commandMap, VoicePing };
