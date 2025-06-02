import { Client, EmbedBuilder, Events, MessageReaction, PartialMessageReaction, PartialUser, Snowflake, TextChannel, User } from 'discord.js';
import { Ollama } from 'ollama';

import { addConfig, addData, editServerConfig, editServerData, getServerConfig, getServerData, readConfig, readData, repairServerConfig, repairServerData } from './data';
import { commandMap } from './commands';
import { Command } from './types';

function clientEvents(client: Client, grokClient: Ollama) {
  client.on('ready', async () => {
    console.log(`Client logged in as ${client.user?.tag}!, 
      Current Models: ${(await grokClient.list()).models.map((m) => m.name.substring(0, m.name.indexOf(':'))).join(', ')}`);

    // verify all data and configs in case structures changed
    const data = await readData();
    const config = await readConfig();

    data.servers.forEach((s) => repairServerData(s));
    config.servers.forEach((s) => repairServerConfig(s));

    const invalidMessages: Snowflake[] = [];
    // load all heartboard messages to cache
    data.servers.forEach(async (server) => {
      const { id, heartBoardMessages } = server;
      const guild = await client.guilds.fetch(id);

      if (!guild || !heartBoardMessages) return;

      heartBoardMessages.forEach(async (messageTuple) => {
        const { channelID, messageID } = messageTuple;
        const channel = await guild.channels.fetch(channelID ?? 'undefined');

        if (!channel || !channel.isSendable()) return;

        try {
          channel.messages.fetch(messageID ?? 'undefined'); // load message into cache
        } catch (error) {
          invalidMessages.push(messageID);
        }
      });

      heartBoardMessages.filter((m) => invalidMessages.find((invalidMessageID) => m.messageID === invalidMessageID));
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

  client.on('messageCreate', async (message) => {
    const { channel } = message;

    if (!message.guildId || !message.mentions.has(client.user?.id ?? 'undefined') || !channel.isTextBased()) return;

    // if the ai feature isn't enabled, or there isn't an available server config
    if (!(await getServerConfig(message.guildId))?.aiEnabled) return;

    const messages = Array.from(await channel.messages.fetch({ limit: 5, before: message.id }));
    messages.push([message.id, message]);

    const grokMessages = messages.map(([, m]) => ({
      role: 'user',
      content: `${m.author.displayName ?? m.author.globalName}: ${m.content ?? 'image'}`,
    }));

    channel.sendTyping();

    grokClient.chat({
      model: 'grok',
      messages: [...grokMessages],
    }).catch((e) => console.error(e)).then((response) => {
      if (!response) return;

      message.reply({ content: response.message.content ?? 'idk bro' });
    });
  });

  // On user joining/leaving voice call
  client.on('voiceStateUpdate', async (oldState, newState) => {
    const guildID = newState.guild?.id;

    if (!guildID) return; // we don't care if this isn't happening a server

    const serverConfig = await getServerConfig(guildID);
    const server = await client.guilds.fetch(guildID);

    const { voicePing } = serverConfig!;

    if (!server || !voicePing) return; // we don't care if we aren't able to make out a server, or if voice ping is disabled

    // checks if the user wasn't in a vc earlier, we're listening to the joined vc, and they're the first to join the channel
    if (oldState.channelId == null && voicePing.inputChannels.find((id) => id === newState.channelId)
      && newState.channel?.members.size === 1) {
      const guild = await client.guilds.fetch(server.id);
      const outputChannel: TextChannel | undefined = await guild.channels.fetch(voicePing.outputChannel) as TextChannel;
      const { voicePingMessage } = voicePing;

      // send message to output channel
      if (outputChannel) {
        outputChannel.send(voicePingMessage.replace('{user}', `<@${newState.member?.user.id!}>`).replace('{channel}', `<#${newState.channelId!}>`));
      }
    }
  });

  const reactionFunction = async (reactionAdded: boolean, reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    const { message } = reaction;

    if (!message.guild) return;

    const { guild } = message;
    const guildID = guild.id;

    const serverConfig = await getServerConfig(guildID) ?? await addConfig(guildID);

    const heartBoardConfig = serverConfig.heartBoard;

    const { enabled, cumulative, denyAuthor, emojis, thresholdNumber } = heartBoardConfig;
    const outputChannel = await guild.channels.fetch(heartBoardConfig.outputChannel);

    const serverData = await getServerData(guildID) ?? await addData(guildID);
    const { heartBoardMessages } = serverData;

    // ignore this reaction if...
    if (!enabled || !outputChannel || !outputChannel.isSendable() // ...the option is disabled or we can't send the message
      || !emojis.includes(reaction.emoji.toString()) // ...the emoji isn't relevant to our search
      || heartBoardMessages.find((mTuple) => message.id === mTuple.embedMessageID)) return; // ...the targeted message is a heartboard embed

    // remove author's reaction if the setting is turned on, and the emote's relevant
    if (denyAuthor && reactionAdded && user.id === message.author?.id && emojis.includes(reaction.emoji.toString())) {
      reaction.users.remove(user.id);
      return;
    }

    let total = 0;
    const reactedEmojis = [];
    const messageReactions = message.reactions.cache.filter((r) => emojis.includes(r.emoji.toString())); // filter relevant emojis

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

    const messageTupleIndex = heartBoardMessages.findIndex((mTuple) => mTuple.messageID === message.id);
    const contentMessage = `${reactedEmojis.join('')} // **${total}**\n${message.url}`;

    if (total < thresholdNumber && messageTupleIndex === -1) return;

    if (messageTupleIndex !== -1) {
      const messageTuple = heartBoardMessages[messageTupleIndex];

      const { embedMessageID } = messageTuple;
      const embedMessage = await outputChannel.messages.fetch(embedMessageID);

      if (!embedMessage) return;

      if (total >= thresholdNumber) {
        await embedMessage.edit({ content: contentMessage, embeds: embedMessage.embeds });
        return;
      }

      // if removing the reaction has dipped below our threshold value, delete the message and tuple
      await embedMessage.delete();
      heartBoardMessages.splice(messageTupleIndex, 1);

      serverData.heartBoardMessages = heartBoardMessages;
      await editServerData(serverData);

      return;
    }

    const guildUser = await guild.members.fetch(message.author?.id ?? 'undefined');
    const embeds = [ // create embed
      (message.content ? new EmbedBuilder().setDescription(message.content) : new EmbedBuilder()) // set description to content if it exists
        .setAuthor({ name: guildUser?.nickname ?? guildUser?.user.username ?? '', iconURL: guildUser?.displayAvatarURL() ?? '' })
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
    await editServerData(serverData);
  };

  // when user adds a reaction
  client.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await reactionFunction(true, reaction, user);
  });

  client.on('messageReactionRemove', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await reactionFunction(false, reaction, user);
  });
}

export default clientEvents;
