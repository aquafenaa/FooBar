import OpenAI from 'openai';
import { Client, EmbedBuilder, Events, Message, MessageReaction, PartialMessageReaction, PartialUser, Snowflake, TextChannel, User } from 'discord.js';

import { Command } from './types';
import { commandMap } from './commands';
import { generateMessage } from './grok';

import { addConfig, addData, editServerConfig, editServerData, getServerConfig, getServerData, readConfig, readData, repairServerConfig, repairServerData } from './data';

function clientEvents(discordClient: Client, grokClient: OpenAI) {
  discordClient.on('ready', async () => {
    console.log(`Client logged in as ${discordClient.user?.tag}!`);

    // verify all data and configs in case structures changed
    const data = await readData();
    const config = await readConfig();

    data.servers.forEach((s) => repairServerData(s));
    config.servers.forEach((s) => repairServerConfig(s));

    const invalidMessages: Snowflake[] = [];
    // load all heartboard messages to cache
    data.servers.forEach(async (server) => {
      const { id, heartBoardMessages } = server;
      const guild = await discordClient.guilds.fetch(id);

      if (!guild || !heartBoardMessages) return;

      heartBoardMessages.forEach(async (messageTuple) => {
        const { channelID, messageID } = messageTuple;
        const channel = await guild.channels.fetch(channelID ?? 'undefined');

        if (!channel || !channel.isSendable()) return;

        try {
          await channel.messages.fetch(messageID ?? 'undefined'); // load message into cache
        } catch (error) {
          invalidMessages.push(messageID);
        }
      });
      const filteredMessages = heartBoardMessages.filter((m) => !invalidMessages.find((invalidMessageID) => m.messageID === invalidMessageID));

      server.heartBoardMessages = filteredMessages;
      editServerData(server);
    });
  });

  // Create a base config when joining a new server
  discordClient.on('guildCreate', (guild) => {
    addData(guild.id);
    addConfig(guild.id);
  });

  // On command
  discordClient.on(Events.InteractionCreate, async (interaction) => {
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

  const allowedServers = ['917588427959058462', '1064698336185172010'];

  // grok functionality, when message was sent
  discordClient.on('messageCreate', async (message) => {
    const { author, channel, guildId } = message;

    // if we can't send messages, we don't care about the message
    if (!message.guildId || !channel.isTextBased()) return;

    const messageContent = message.content;
    const serverConfig = await getServerConfig(message.guildId);

    if (!serverConfig) return;

    serverConfig.serverResponses.forEach((response) => {
      // continue to next if response isn't enabled, or activation phrase isn't found
      if (!response.enabled || !messageContent.match(response.activationRegex)) return;

      const groups = messageContent.match(response.captureRegex!);

      if (!groups) return; // return undefined, if no groups were found

      // parse groups, and replace them with respective group number
      if (!response.outputTemplateString) { console.log(response); return; }
      const responseStr = response.outputTemplateString.replace(/\{(\d+)\}/g, (_, index) => { // thank u claude. this is actually a cute little implementation
        const i = parseInt(index, 10);
        return groups[i] ?? '';
      });

      message.reply({ content: responseStr });
    });

    // cancel if the message starts with "-ai"
    if (messageContent.substring(0, 3) === '-ai') return;

    // the bot cannot respond to itself
    if (!author.id || author.id === discordClient.user?.id) return;

    // only works within my server, sorry! otherwise it's a waste of xAI tokens & money :/
    if (!allowedServers.find((id) => guildId === id)) return;

    // we do not care if...
    if ((
      message.content.includes('@everyone') || message.content.includes('@here') // ...it's a mass ping...
      || !message.mentions.has(discordClient.user?.id ?? 'undefined') // ... bot isn't mentioned...
      || message.author.id === discordClient.user?.id)) return; // ...or the bot mentioned itself...
    // && Math.random() < 1 / 4096) return; // ...and we don't roll a 1% chance to respond anyway... <-- big bug, will fix.

    // if the ai feature isn't enabled, or there isn't an available server config
    if (!(await getServerConfig(message.guildId))?.aiEnabled) return;

    let userContent = message.content; // remove '-ai' marker from beginning of text
    const messageReference = message.reference ? await message.fetchReference() : undefined; // fetch response, if it exists
    const context: Message<boolean>[] | undefined = Array.from((await channel.messages.fetch(({ limit: 5, cache: true, before: message.id }))).values()); // fetch 5 most recent messages as context

    // if a user is responding to a message, we add it to our message
    if (messageReference && messageReference.content.length > 0) {
      userContent = `Responding to: "${messageReference.content}"\nResponse: "${userContent}"`;
    }

    message.channel.sendTyping(); // starts typing indicator...
    const typingExtension = setInterval(() => {
      message.channel.sendTyping();
    }, 5000); // ... and refreshes it every 5 seconds, until cancelled

    setTimeout(() => {
      clearInterval(typingExtension);
    }, 20000); // cancel interval after 20 seconds, if it's still somehow going

    // get response from grok, and reply
    const grokReply = await generateMessage(message, userContent, context ?? [], grokClient, await readData(), discordClient.user!.id, typingExtension);
    try {
      if (!grokReply) return;
      clearInterval(typingExtension); // disables typing

      if (grokReply.length < 2000) {
        await message.reply(grokReply);
      } else {
        await message.reply(grokReply.substring(0, 2000));
      }
    } catch (error) {
      clearInterval(typingExtension); // disables typing

      console.error(error);
    }
  });

  // On user joining/leaving voice call
  discordClient.on('voiceStateUpdate', async (oldState, newState) => {
    const guildID = newState.guild?.id;

    if (!guildID) return; // we don't care if this isn't happening a server

    const serverConfig = await getServerConfig(guildID);
    const server = await discordClient.guilds.fetch(guildID);

    const { voicePing } = serverConfig!;

    if (!server || !voicePing) return; // we don't care if we aren't able to make out a server, or if voice ping is disabled

    // checks if the user wasn't in a vc earlier, we're listening to the joined vc, and they're the first to join the channel
    if (oldState.channelId == null && voicePing.inputChannels.find((id) => id === newState.channelId)
      && newState.channel?.members.size === 1) {
      const guild = await discordClient.guilds.fetch(server.id);
      const outputChannel: TextChannel | undefined = await guild.channels.fetch(voicePing.outputChannel) as TextChannel;
      const { voicePingMessage } = voicePing;

      // send message to output channel
      if (outputChannel) {
        outputChannel.send(voicePingMessage.replace('{user}', `<@${newState.member?.user.id!}>`).replace('{channel}', `<#${newState.channelId!}>`));
      }
    }
  });

  // Heartboard reaction function
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
  discordClient.on('messageReactionAdd', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await reactionFunction(true, reaction, user);
  });

  discordClient.on('messageReactionRemove', async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await reactionFunction(false, reaction, user);
  });
}

export default clientEvents;
