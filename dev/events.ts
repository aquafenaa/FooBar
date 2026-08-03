import OpenAI from 'openai';
import { BaseMessageOptions, Channel, Client, EmbedBuilder, Events, GuildMember, Message, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from 'discord.js';

import { commandMap } from './commands';
import { generateMessage } from './chatbot';

import { Command } from './types/bot';
import { deleteHeartBoardMessage, getAutomaticResponsesByServer, getChatbot, getHeartBoardMessage, getHeartBoardMessagesByServer, getHeartBoardsByEmoji, getVoicePingInputs, getVoicePingsByServer, insertHeartBoardMessage, insertServer, isEmbedMessage, syncDatabase, updateHeartBoardMessage } from './data';

const heartboardEmbedBuilder = (author: GuildMember | null, message: Message<boolean> | PartialMessage<boolean>, reaction: MessageReaction): BaseMessageOptions => {
  const authorName = author?.nickname ?? author?.displayName;
  const authorIconURL = author?.displayAvatarURL({ forceStatic: true });
  const timestamp = message.createdTimestamp;
  const messageContent = message.content;
  const messageAttachments = Array.from(message.attachments.values()).filter((attachment) => attachment.contentType?.startsWith('image'));

  const mainEmbed = new EmbedBuilder().setTimestamp(timestamp);
  if (author) mainEmbed.setAuthor({ name: authorName!, iconURL: authorIconURL });
  if (messageContent) mainEmbed.setDescription(messageContent);
  if (messageAttachments.length > 0) {
    const mainImage = messageAttachments.shift()!;
    mainEmbed.setImage(mainImage.url ?? mainImage.proxyURL);
  }

  const embeds = [mainEmbed];

  // add blank embeds filled with only remaining image attachments
  messageAttachments.forEach((attachment) => {
    embeds.push(new EmbedBuilder().setImage(attachment.url ?? attachment.proxyURL));
  });

  const messageOptions: BaseMessageOptions = { content: `${reaction.emoji.toString()} // ${reaction.count}\n${message.url}`, embeds };

  return messageOptions;
};

function clientEvents(discordClient: Client, grokClient: OpenAI) {
  discordClient.on(Events.ClientReady, async () => {
    console.log(`Client logged in as ${discordClient.user?.tag}!`);

    // verify all server data
    syncDatabase();

    const guilds = await discordClient.guilds.fetch();
    guilds.forEach(async (guild) => {
      const server = await discordClient.guilds.fetch(guild.id);
      if (!server) return;

      // load all heartbaord messages to cache
      const heartboardMessages = getHeartBoardMessagesByServer(server.id);
      heartboardMessages.forEach(async (heartboardMessage) => {
        const channel = await server.channels.fetch(heartboardMessage.channel_id);

        if (!channel || !channel.isSendable()) return;

        try {
          await channel.messages.fetch(heartboardMessage.message_id);
        } catch {
          deleteHeartBoardMessage(server.id, heartboardMessage.board_name, heartboardMessage.message_id);
        }
      });
    });
  });

  // Add server to data when bot joins
  discordClient.on(Events.GuildCreate, (guild) => {
    insertServer(guild.id);
  });

  // On command
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    if (!interaction.isCommand() && !interaction.isAutocomplete()) return;

    if (!interaction.guild) { return; }

    const { commandName } = interaction;
    const command: Command = commandMap.get(commandName)!;
    const serverID: string = interaction.guild.id;

    if (!command) { console.error(`No command found! Command Name: ${commandName}`); return; }

    if (interaction.isAutocomplete()) {
      command.autocomplete!(interaction, serverID);
      return;
    }

    // deny dan.
    if (interaction.user.id === '276892442521894913') {
      await interaction.reply({ content: 'You are not to be trusted.', flags: 'Ephemeral' });
      return;
    }

    try {
      await command.execute(interaction, serverID);
    } catch (error) {
      console.error(error);
      await interaction.reply({ content: 'There was an error while executing this command!', ephemeral: true });
    }
  });

  const allowedServers = ['917588427959058462', '1064698336185172010', '708642778300547142', '1148069131711680633'];

  // grok functionality, when message was sent
  discordClient.on(Events.MessageCreate, async (message) => {
    const { author, channel, guildId: serverID } = message;

    // if we can't send messages, we don't care about the message
    if (!serverID || !channel.isTextBased()) return;

    // Check AutomaticResponses
    const messageContent = message.content;
    const serverResponses = getAutomaticResponsesByServer(serverID);

    serverResponses.forEach((response) => {
      // continue to next if response isn't enabled, or activation phrase isn't found
      if (!response.enabled || !messageContent.match(response.activation_regex)) return;

      const groups = messageContent.match(response.capture_regex!);

      if (!groups) return; // return undefined, if no groups were found

      // parse groups, and replace them with respective group number
      if (!response.output_template) return;
      const responseStr = response.output_template.replace(/\{(\d+)\}/g, (_, index) => { // thank u claude. this is actually a cute little implementation
        const i = parseInt(index, 10);
        return groups[i] ?? '';
      });

      message.reply({ content: responseStr });
    });

    // ChatbotResponse Handling
    const chatbot = getChatbot(serverID);
    // if chatbot doesn't exist, or isn't enabled, we don't care
    if (!chatbot || !chatbot.chatbot_enabled) return;

    // the bot cannot respond to itself
    if (!author.id || author.id === discordClient.user?.id) return;

    // only works within my servers, sorry! otherwise it's a waste of xAI tokens & money :/
    if (!allowedServers.find((id) => serverID === id)) return;

    // we also do not care if...
    if ((
      message.content.includes('@everyone') || message.content.includes('@here') // ...it's a mass ping...
      || !message.mentions.has(discordClient.user?.id ?? 'undefined') // ... bot isn't mentioned...
      || message.author.id === discordClient.user?.id)) return; // ...or the bot mentioned itself...
    // && Math.random() < 1 / 4096) return; // ...and we don't roll a 1% chance to respond anyway... <-- big bug, will fix.

    let userContent = message.content;
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

    // get response from LLM, and reply
    const agentReply = await generateMessage(grokClient, discordClient, serverID, typingExtension, message, userContent, context ?? []);
    try {
      if (!agentReply || agentReply === '') return;
      clearInterval(typingExtension); // disables typing

      if (agentReply.length < 2000) {
        await message.reply(agentReply);
      } else {
        await message.reply(agentReply.substring(0, 2000));
      }
    } catch (error) {
      clearInterval(typingExtension); // disables typing

      console.error(error);
    }
  });

  // On user joining/leaving voice call
  discordClient.on(Events.VoiceStateUpdate, async (oldState, newState) => {
    const serverID = newState.guild?.id;

    if (!serverID) return; // we don't care if this isn't happening a server

    const server = await discordClient.guilds.fetch(serverID);
    const voicePings = getVoicePingsByServer(serverID);

    voicePings.forEach(async (voicePing) => {
      if (!voicePing.output_channel || !voicePing.enabled) return;

      const voicePingInputs = getVoicePingInputs(serverID, voicePing.voiceping_name);
      // checks if the user wasn't in a vc earlier, we're listening to the joined vc, and they're the first to join the channel
      if (oldState.channelId == null && voicePingInputs.find((vpi) => vpi.channel_id === newState.channelId)
        && newState.channel?.members.size === 1) {
        const outputChannel: Channel | undefined = await server.channels.fetch(voicePing.output_channel ?? 'undefined') as Channel;

        // send message to output channel
        if (outputChannel && outputChannel.isSendable()) {
          try {
            outputChannel.send(voicePing.message_template.replace('{user}', `<@${newState.member?.user.id!}>`).replace('{channel}', `<#${newState.channelId!}>`));
          } catch (error) {
            console.error(error);
          }
        }
      }
    });
  });

  // Heartboard reaction function
  const handleReaction = async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    const { message } = reaction;

    if (!message.guild) return;

    const { guild, id: messageID } = message;
    const serverID = guild.id;
    const emojiString = reaction.emoji.toString();
    const totalReactions = reaction.count ?? 0;

    if (isEmbedMessage(message.id)) return; // we don't wish to process this reaction if it's to an existing HeartBoard embed

    const heartBoards = getHeartBoardsByEmoji(serverID, emojiString);
    heartBoards.forEach(async (heartBoard) => {
      if (!heartBoard.enabled) return;
      if (heartBoard.deny_author && user.id === message.author?.id) {
        reaction.users.remove(user.id);
        return;
      }

      const outputChannel = await guild.channels.fetch(heartBoard.output_channel);
      if (!outputChannel || !outputChannel.isTextBased()) return;

      let heartboardMessage = getHeartBoardMessage(serverID, heartBoard.board_name, messageID);

      // if it's not currently in the board, and it's not elligible, skip processing
      if (!heartboardMessage && totalReactions < heartBoard.threshold) return;

      // if it's already in this board, we simply wish to update it
      let embedMessage;
      if (heartboardMessage) {
        try {
          embedMessage = await outputChannel.messages.fetch(heartboardMessage?.embed_id ?? 'unknown');
        } catch { // if the embedMessage was deleted, delete heartboardMessage and recreate it down below
          if (totalReactions < heartBoard.threshold || reaction.partial) { // unless it is below required threshold
            deleteHeartBoardMessage(serverID, heartBoard.board_name, messageID);
            return;
          }
          deleteHeartBoardMessage(serverID, heartboardMessage.board_name, heartboardMessage.message_id);
          heartboardMessage = undefined;
        }
      }

      if (heartboardMessage && embedMessage) {
        // if the message no longer has enough reactions, we should delete the HeartBoardMessage
        if (totalReactions < heartBoard.threshold || reaction.partial) {
          embedMessage.delete();
          deleteHeartBoardMessage(serverID, heartBoard.board_name, messageID);
          return;
        }

        // if it's still above the threshold, we wish to simply edit the message
        const authorMember = await guild.members.fetch(message.author?.id ?? 'unknown');
        const messageOptions = heartboardEmbedBuilder(authorMember, message, reaction);

        embedMessage.edit(messageOptions);
        heartboardMessage.total_emojis = totalReactions;
        updateHeartBoardMessage(heartboardMessage);

        return;
      }

      // if it's not in the board, but still elligible, we must add a new HeartBoardMessage
      const authorMember = await guild.members.fetch(message.author?.id ?? 'unknown');
      const messageOptions = heartboardEmbedBuilder(authorMember, message, await reaction.fetch());
      embedMessage = await outputChannel.send(messageOptions);

      heartboardMessage = {
        server_id: serverID,
        board_name: heartBoard.board_name,
        channel_id: message.channelId,
        message_id: messageID,
        total_emojis: totalReactions,
        embed_id: embedMessage.id,
      };

      insertHeartBoardMessage(heartboardMessage);
    });
  };

  discordClient.on(Events.MessageReactionAdd, async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await handleReaction(reaction, user);
  });
  discordClient.on(Events.MessageReactionRemove, async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    await handleReaction(reaction, user);
  });
}

export default clientEvents;
