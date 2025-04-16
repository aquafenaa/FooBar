import { Client, EmbedBuilder, Events, MessageReaction, PartialMessageReaction, PartialUser, TextChannel, User } from 'discord.js';
import { addConfig, addData, editServerConfig, editServerData, getServerConfig, getServerData, readConfig, readData, repairServerConfig, repairServerData } from './data';
import { commandMap } from './commands';
import { Command } from './types';

function clientEvents(client: Client) {
  client.on('ready', async () => {
    console.log(`Client logged in as ${client.user?.tag}!`);

    // verify all data and configs in case structures changed
    const data = await readData();
    const config = await readConfig();

    data.servers.forEach((s) => repairServerData(s));
    config.servers.forEach((s) => repairServerConfig(s));

    // load all heartboard messages to cache
    data.servers.forEach(async (server) => {
      const { id, heartBoardMessages } = server;
      const guild = await client.guilds.fetch(id);

      if (!guild || !heartBoardMessages) return;

      heartBoardMessages.forEach(async (messageTuple) => {
        const { channelID, messageID } = messageTuple;
        const channel = await guild.channels.fetch(channelID ?? 'undefined');

        if (!channel || !channel.isSendable()) return;

        channel.messages.fetch(messageID ?? 'undefined'); // load message into cache
      });
    });
  });

  // Create a base config when joining a new server
  client.on('guildCreate', (guild) => {
    addData(guild.id);
    addConfig(guild.id);
  });

  // On command
  client.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isCommand() && !interaction.isAutocomplete()) return;

    if (!interaction.guild) { return; }

    const { commandName } = interaction;
    const command: Command = commandMap.get(commandName)!;
    const guildID: string = interaction.guild.id;

    if (!command) { console.error(`No command found! Command Name: ${commandName}`); return; }

    const serverConfig = await getServerConfig(guildID) ?? await addConfig(guildID);

    if (interaction.isAutocomplete()) {
      command.autocomplete!(interaction, serverConfig);
      return;
    }

    // deny dan.
    if (interaction.user.id === '276892442521894913') {
      await interaction.reply({ content: 'You are not to be trusted.', flags: 'Ephemeral' });
      return;
    }

    try {
      const tempConfig = await command.execute(interaction, serverConfig);

      if (tempConfig) {
        editServerConfig(tempConfig);
      }
    } catch (error) {
      console.error(error);
      await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
    }
  });

  // On user joining/leaving voice call
  client.on('voiceStateUpdate', async (oldState, newState) => {
    const config = await readConfig();
    const server = config?.servers?.find((s) => s.id === newState.guild?.id);

    if (!server || !server.voicePing.enabled) return;

    // checks if the user wasn't in a vc earlier, we're listening to the joined vc, and they're the first to join the channel
    if (oldState.channelId == null && server.voicePing.inputChannels.find((id) => id === newState.channelId)
      && newState.channel?.members.size === 1) {
      const index = server.voicePing.inputChannels.findIndex((id) => id === newState.channelId);
      const channel: TextChannel | undefined = client.channels.cache.get(config.servers[index].voicePing.outputChannel) as TextChannel;
      const { voicePingMessage } = server.voicePing;

      // send message to output channel
      if (channel) {
        channel.send(voicePingMessage.replace('{user}', `<@${newState.member?.user.id!}>`).replace('{channel}', `<#${newState.channelId!}>`));
      }
    }
  });

  // when user adds a reaction
  client.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    const { message } = reaction;

    if (!message.guild) return;

    const { guild } = message;
    const guildID = guild.id;

    const serverConfig = await getServerConfig(guildID) ?? await addConfig(guildID);

    const heartBoardConfig = serverConfig.heartBoard;

    const { enabled, cumulative, denyAuthor, emojis, thresholdNumber } = heartBoardConfig;
    const outputChannel = await guild.channels.fetch(heartBoardConfig.outputChannel);

    if (!enabled || !outputChannel || !outputChannel.isSendable() || !emojis.includes(reaction.emoji.toString())) return;

    // Deny author
    if (denyAuthor && user.id === message.author?.id && emojis.includes(reaction.emoji.toString())) {
      // reaction.remove();
      // return;
    }
    const messageReactions = message.reactions.cache.filter((r) => emojis.includes(r.emoji.toString())); // filter relevant emojis

    let total = 0;
    const reactedEmojis = [];

    if (cumulative) { // whether we should tally all valid emojis
      messageReactions.forEach(({ emoji, count }) => {
        total += count;
        reactedEmojis.push(emoji.toString());
      });
    } else { // if we only care about a specific emoji being above threshold value instead
      const reactionsWithVotes = messageReactions.filter(({ emoji, count }) => emojis.includes(emoji.toString()) && (count >= thresholdNumber));

      if (reactionsWithVotes.size >= 1) {
        total = Math.max(...reactionsWithVotes.map((r) => r.count));
        const largestReaction = reactionsWithVotes.find(({ count }) => count === total)!; // get emoji with largest amount of reactions to use

        reactedEmojis.push(largestReaction.emoji.toString());
      }
    }

    if (total < thresholdNumber) return;

    const serverData = await getServerData(guildID) ?? await addData(guildID);
    const { heartBoardMessages } = serverData;

    const messageTuple = heartBoardMessages.find((mTuple) => mTuple.messageID === message.id);
    const contentMessage = `${reactedEmojis.join('')} // **${total}**\n${message.url}`;

    if (messageTuple) {
      const { embedMessageID } = messageTuple;
      const embedMessage = await outputChannel.messages.fetch(embedMessageID);

      embedMessage.edit({ content: contentMessage, embeds: embedMessage.embeds });
      return;
    }

    const guildUser = guild.members.cache.get(user.id);
    const embeds = [ // create embed
      (message.content ? new EmbedBuilder().setDescription(message.content) : new EmbedBuilder()) // set description to content if it exists
        .setAuthor({ name: guildUser?.nickname ?? guildUser?.user.username ?? '', iconURL: guildUser?.displayAvatarURL() ?? user.defaultAvatarURL })
        .setTimestamp(message.createdTimestamp),
    ];

    // scrape attachments and add them to extra embeds
    const attachments = Array.from(message.attachments.values()).filter((attachment) => attachment.contentType?.startsWith('image'));
    if (attachments.length >= 1) {
      const mainImage = attachments.shift();
      embeds[0].setImage(mainImage?.url!);

      embeds.push(...attachments.map((image) => new EmbedBuilder().setImage(image.url)));
    }

    const heartboardMessage = await outputChannel.send({ content: `${reactedEmojis.join('')} // **${total}**\n${message.url}`, embeds });

    heartBoardMessages.push({
      channelID: outputChannel.id,
      messageID: message.id,
      embedMessageID: heartboardMessage.id,
    }); // add to data for future cache reference

    serverData.heartBoardMessages = heartBoardMessages; // not sure if necessary due to confusion abt JS references, but best to be cautious
    editServerData(serverData);
  });
}

export default clientEvents;
