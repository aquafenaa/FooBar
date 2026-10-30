import { BaseMessageOptions, Channel, ChannelType, Client, EmbedBuilder, Events, GuildMember, Message, MessageFlags, MessageReaction, PartialMessage, PartialMessageReaction, PartialUser, User } from 'discord.js';
import cron from 'node-cron';

import { commandMap, dmCommandMap } from './commands';
import { THINKING_STATUS, generateReply, isAllowedServer, markMessageDeleted } from './chatbot/chatbot';
import { loadHeartbeats } from './chatbot/heartbeat';
import { PendingReply, discardToolResults, forgetReply, nextAttempt, restartReply, handleReplyButton, handleStatusButton, sendReply, statusButtons, trackReply, untrackReply } from './chatbot/replies';

import { Command } from './types/bot';
import { addResponseMessage, deleteConversationMessageByID, deleteHeartBoardMessage, deleteResponseMessage, getAllConversations, getAutomaticResponsesByServer, getChatbot, getDMServers, getHeartBoardMessage, getHeartBoardMessagesByServer, getHeartBoardsByEmoji, getRemindersByServer, updateReminder, getVoicePingInputs, getVoicePingsByServer, insertHeartBoardMessage, insertServer, isChatbotSubscriber, isConversationMessage, isEmbedMessage, isResponseMessage, saveAnonymizedMessage, updateDatabase, updateHeartBoardMessage } from './data';
import { inputToSchedule, safeFetch, sendReminder } from './utils';
import { scheduleExpireTask } from './chatbot/conversation';
import { loadModels } from './chatbot/models';
import { dmRecipient, ensureDMServer, fetchServerChannel, handleDMCommand, isDMServer, isDMUser } from './chatbot/dm';

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

/**
 * Writes the chatbot's reply to a message, and sends it: in a server, or in a DM with the bot's owner, whose server id is their user id.
 * Until it's sent, a status message shows what it's doing, with Stop and Cancel buttons
 */
async function respondTo(message: Message, serverID: string): Promise<void> {
  const { author, channel } = message;
  if (!channel.isSendable()) return;

  let messageReference: Message | undefined = message.reference ? await message.fetchReference() : undefined; // fetch response, if it exists
  const fetchContext = async (before: Message) => Array.from((await channel.messages.fetch(({ limit: 5, cache: true, before: before.id }))).values()); // the 5 most recent messages
  let context: Message<boolean>[] = await fetchContext(message);

  // sent first, so the user sees a sign of a reply right away. edited as it uses tools, then deleted once the reply is sent.
  // it has Stop (no more tools, answer now) and Cancel (throw it all away) buttons, which only work while it's tracked
  let status = THINKING_STATUS;
  let pending: PendingReply | undefined;
  const statusMessage = await safeFetch(async () => {
    const sent = await channel.send({ content: status });
    pending = trackReply(sent.id, author.id);
    await sent.edit({ components: statusButtons(pending) }).catch((err) => console.error(err)); // added once tracked, so a press always finds its reply
    return sent;
  });
  // edits take turns, and each shows the latest status when it goes, so an older one can never land after a newer one
  let shown = status;
  let finished = false; // once the reply is sent or fails, nothing more is edited in
  let editing = Promise.resolve();
  const onStatus = (newStatus: string) => {
    status = newStatus;
    editing = editing.then(async () => {
      if (status === shown || finished || !statusMessage || pending?.cancel.signal.aborted) return;
      shown = status;
      await statusMessage.edit({ content: status, components: pending ? statusButtons(pending) : [] });
    }).catch((err) => console.error(err));
  };

  // get response from LLM, and reply. nothing is sent until the whole reply is ready
  try {
    let replyTo: Message = message;
    let chunks: string[];
    for (;;) {
      try {
        ({ chunks } = await generateReply(serverID, { channel, context, message: replyTo, reference: messageReference, onStatus, control: pending?.control }));
        if (!pending?.restart.signal.aborted) break;
      } catch (error) {
        if (!pending?.restart.signal.aborted || pending.cancel.signal.aborted) throw error;
      }
      // its author added a message to it: start over answering that, as a follow-up to what they first said. what its tools did is kept
      const next = nextAttempt(pending!);
      if (!next) throw new Error('The reply started over, but lost the message it was starting over for.');
      messageReference = replyTo;
      replyTo = next;
      context = await fetchContext(next);
    }
    if (pending) pending.sending = true; // too late to start over now, so a new message from its author gets its own reply
    finished = true;
    const sent = await sendReply(serverID, replyTo, chunks!, pending);
    if (!pending?.cancel.signal.aborted) statusMessage?.delete().catch((err) => console.error(err));
    // a Cancel that came too late to stop it keeps the reply's tool results as they are, since the reply is there
    else if (!sent) discardToolResults(pending, 'cancelled');
  } catch (error: any) {
    if (pending) discardToolResults(pending, pending.cancel.signal.aborted ? 'cancelled' : 'failed');
    // cancelled with its button, which already deleted the status message
    if (pending?.cancel.signal.aborted) return;

    finished = true;
    console.error(error);
    const errorText = `There was an issue... Please try again later...\n\`\`\`${error?.message ?? ''}\`\`\``;
    (statusMessage ? statusMessage.edit({ content: errorText, components: [] }) : message.reply(errorText)).catch((err) => console.error(err));
  } finally {
    if (statusMessage) untrackReply(statusMessage.id);
  }
}

/**
 * A DM to the bot. Only users in DM_USERS get an answer, and they get full control: the DM is treated as a server of its own,
 * keyed by their user id. Every message gets a reply, with no mention needed, except the /private text command, which is answered directly
 */
async function handleDirectMessage(message: Message): Promise<void> {
  const { author, channel } = message;
  if (channel.type !== ChannelType.DM) return;

  // the bot's own messages to its owner get a 🗑️, which they can react with to delete it. not the status message, which goes away by itself
  if (author.id === message.client.user.id) {
    if (message.content === THINKING_STATUS) return;
    const recipient = await dmRecipient(channel);
    if (recipient && isDMUser(recipient)) await message.react('🗑️').catch((error) => console.error('Couldn\'t add 🗑️ to a DM message:', error));
    return;
  }
  if (author.bot || !isDMUser(author.id)) return; // anyone else's DMs are ignored

  // its server id is its owner's user id
  const chatbot = ensureDMServer(author.id);
  if (await handleDMCommand(message, chatbot)) return;
  if (!chatbot.chatbot_enabled) return;

  // a reply to a status message: that reply starts over with this added, rather than this getting its own
  if (restartReply(message)) return;
  await respondTo(message, author.id);
}

/**
 * A reaction in a DM: the bot's owner reacting 🗑️ to one of its messages deletes it, or the whole reply it's part of.
 * The delete event then takes it out of the bot's memory of the conversation too
 */
async function handleDMReaction(reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser): Promise<void> {
  if (!['🗑️', '🗑'].includes(reaction.emoji.name ?? '') || user.id === reaction.client.user.id || !isDMUser(user.id)) return;

  // a message from before the bot started arrives partial, without its author
  const message = reaction.message.partial ? await safeFetch(() => reaction.message.fetch()) : reaction.message;
  if (!message) {
    console.error(`🗑️ in a DM: couldn't fetch message ${reaction.message.id}, so it wasn't deleted`);
    return;
  }
  // only the bot's own messages, and only in a DM, never a server's channel
  if (message.guildId || message.channel.type !== ChannelType.DM || message.author.id !== message.client.user.id) return;

  const { channel } = message;
  await Promise.all(forgetReply(message.id).map((id) => channel.messages.delete(id).catch((error) => console.error(`Couldn't delete DM message ${id}:`, error))));
}

// schedules a server's reminders, from when the bot starts. a DM's post in the DM itself
function loadReminders(serverID: string): void {
  getRemindersByServer(serverID).forEach(async (reminder) => {
    const outputChannel = await fetchServerChannel(serverID, reminder.channel_id);
    if (!outputChannel) {
      console.error(`Reminder "${reminder.reminder_name}" (server ${serverID}): channel ${reminder.channel_id} not found`);
      return;
    }

    // older /reminder add saved the raw Discord @time tag instead of the cron schedule
    const cronSchedule = inputToSchedule(reminder.cron_schedule);
    if (!cronSchedule) {
      console.error(`Reminder "${reminder.reminder_name}" (server ${serverID}): invalid schedule "${reminder.cron_schedule}"`);
      return;
    }
    if (cronSchedule !== reminder.cron_schedule) {
      updateReminder({ ...reminder, cron_schedule: cronSchedule });
    }

    cron.schedule(cronSchedule, () => sendReminder(outputChannel, serverID, reminder.reminder_name), {
      name: `${reminder.server_id}${reminder.reminder_name}`,
    });
  });
}

function clientEvents(discordClient: Client) {
  discordClient.on(Events.ClientReady, async () => {
    console.log(`Client logged in as ${discordClient.user?.tag}!`);

    loadModels(); // so /chatbot model autocomplete is fast from the first use

    // verify all server data
    updateDatabase();

    const guilds = await discordClient.guilds.fetch();
    guilds.forEach(async (guild) => {
      const guildID = guild.id;
      const server = await discordClient.guilds.fetch(guildID);
      if (!server) return;

      // load all heartboard messages to cache
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

      loadReminders(guildID);
      loadHeartbeats(guildID);
    });
    // DMs with the bot's owner are servers of their own, with their own reminders and heartbeats, which post in the DM
    getDMServers().forEach((dm) => {
      loadReminders(dm.server_id);
      loadHeartbeats(dm.server_id);
    });

    const conversations = getAllConversations();
    conversations.forEach((conversation) => {
      scheduleExpireTask(conversation);
    });
  });

  // Add server to data when bot joins
  discordClient.on(Events.GuildCreate, (guild) => {
    insertServer(guild.id);
  });

  // On command
  discordClient.on(Events.InteractionCreate, async (interaction) => {
    // the retry and version buttons under the chatbot's replies, and the stop and cancel buttons on replies still being written
    if (interaction.isButton()) {
      if (interaction.customId.startsWith('reply:')) await handleReplyButton(interaction).catch((error) => console.error(error));
      if (interaction.customId.startsWith('status:')) await handleStatusButton(interaction).catch((error) => console.error(error));
      return;
    }
    // modal submissions are picked up by the command that showed the modal, with awaitModalSubmit
    if (!interaction.isCommand() && !interaction.isAutocomplete()) return;

    // a DM's commands change that DM's own settings, and only work for the bot's owner. its server id is their user id
    let serverID: string;
    let command: Command | undefined;
    if (interaction.guild) {
      serverID = interaction.guild.id;
      command = commandMap.get(interaction.commandName);
    } else {
      if (!isDMUser(interaction.user.id)) {
        if (interaction.isAutocomplete()) await interaction.respond([]).catch(() => undefined);
        else await interaction.reply({ content: 'These commands aren\'t available to you.', flags: MessageFlags.Ephemeral }).catch(() => undefined);
        return;
      }
      serverID = interaction.user.id;
      ensureDMServer(serverID);
      command = dmCommandMap.get(interaction.commandName);
    }

    if (!command) { console.error(`No command found! Command Name: ${interaction.commandName}`); return; }

    if (interaction.isAutocomplete()) {
      try {
        await command.autocomplete?.(interaction, serverID);
      } catch (error) {
        console.error(error); // discord just shows "loading options failed", so this is the only place the cause shows up
      }
      return;
    }

    try {
      await command.execute(interaction, serverID);
    } catch (error) {
      console.error(error);
      await interaction.reply({ content: 'There was an error while executing this command! Please try again later!', ephemeral: true });
    }
  });

  // grok functionality, when message was sent
  discordClient.on(Events.MessageCreate, async (message) => {
    // a DM, which only the bot's owner gets an answer to
    if (!message.guildId) {
      await handleDirectMessage(message).catch((error) => console.error(error));
      return;
    }

    const { author, channel, guildId: serverID } = message;

    // if we can't send messages, we don't care about the message
    if (!serverID || !channel.isTextBased()) return;

    // Check AutomaticResponses. never for bots, the bot itself included, so a response matching its own activation can't loop forever
    const messageContent = message.content;
    const serverResponses = author.bot ? [] : getAutomaticResponsesByServer(serverID);

    serverResponses.forEach((response) => {
      // continue to next if response isn't enabled, or activation phrase isn't found
      if (!response.enabled || !messageContent.match(response.activation_regex)) return;

      const groups = messageContent.match(response.capture_regex!);

      if (!groups) return; // return undefined, if no groups were found

      // parse groups, and replace them with respective group number
      if (!response.output_template) return;
      const responseStr = response.output_template.replace(/\{(\d+)\}/g, (_, index) => {
        const i = parseInt(index, 10);
        return groups[i] ?? '';
      });

      // caught, since a channel the bot can't send or react in would otherwise crash it
      message.reply({ content: responseStr }).then((responseMessage) => {
        addResponseMessage(serverID, responseMessage.id);
        return responseMessage.react('🗑️');
      }).catch((error) => console.error(error));
    });

    // ChatbotResponse Handling
    const chatbot = getChatbot(serverID);
    // if chatbot doesn't exist, or isn't enabled, we don't care
    if (!chatbot || !chatbot.chatbot_enabled) return;

    // the bot cannot respond to itself
    if (!author.id || author.id === discordClient.user?.id || !isChatbotSubscriber(serverID, author.id)) return;

    if (!isAllowedServer(serverID)) return;
    if (!message.inGuild() || !channel.isSendable()) return;

    // a reply to a status message, from whoever it's replying to: that reply starts over with this added, rather than this getting its own
    if (restartReply(message)) return;

    // we also do not care if...
    if (
      (
        message.content.includes('@everyone') || message.content.includes('@here') // ...it's a mass ping...
      || !message.mentions.has(discordClient.user?.id ?? 'undefined') // ... bot isn't mentioned...
      || message.author.id === discordClient.user?.id // ...or the bot mentioned itself...
      )
    && Math.random() >= 1 / 4096) return; // ...and we don't roll a small chance to respond anyway

    await respondTo(message, serverID);
  });

  const handleMessageDelete = (serverID: string, messageID: string) => {
    // a reply may still be generating, with this message waiting to be saved once it's done. make sure it isn't
    markMessageDeleted(messageID);

    if (isConversationMessage(messageID)) {
      deleteConversationMessageByID(messageID);
    }
    if (isResponseMessage(serverID, messageID)) {
      deleteResponseMessage(serverID, messageID);
    }
  };

  // NOTE: messages may be partial (only id, channel, and guild), if they weren't cached
  discordClient.on(Events.MessageDelete, async (message) => {
    // a DM with the bot's owner counts as a server of its own, keyed by its owner's user id
    const dmOwner = message.channel?.type === ChannelType.DM ? await dmRecipient(message.channel) : undefined;
    const serverID = message.guildId ?? (dmOwner && isDMServer(dmOwner) ? dmOwner : undefined);
    if (!serverID) return; // only care if it's in a server

    handleMessageDelete(serverID, message.id);
  });
  // e.g. a moderator purging messages
  discordClient.on(Events.MessageBulkDelete, async (messages, channel) => {
    const serverID = channel.guildId;
    messages.forEach((message) => handleMessageDelete(serverID, message.id));
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

  const acceptedEmojis = ['🩷', '❤️', '💛', '🧡', '💚', '🤍', '🩵', '💙', '💜'];
  // Heartboard reaction function
  const handleReaction = async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    const { message } = reaction;

    if (!message.guild) return;
    // uncached messages arrive partial, with no reaction count, which would read as 0 and remove heartboard posts.
    // these never reached here before partials were enabled, so skip them, as before
    if (message.partial) return;

    const { guild, id: messageID } = message;

    const serverID = guild.id;
    const emojiString = reaction.emoji.toString();
    const totalReactions = reaction.count ?? 0;

    if (emojiString === '🗑️' && !user.bot && isResponseMessage(serverID, messageID)) {
      deleteResponseMessage(serverID, messageID);
      await message.delete().catch((error) => console.error(error)); // e.g. a moderator deleted it first
      return;
    }

    const refMessage = message.reference ? await message.fetchReference() : undefined;

    // if in acceptedEmojis, save anonymized chat
    if (!user.bot && acceptedEmojis.includes(emojiString) && message.content) {
      saveAnonymizedMessage({
        server_id: serverID,
        message_id: messageID,

        reference_content: refMessage ? refMessage.content : undefined,
        message_content: message.content,
      });
    }

    if (isEmbedMessage(message.id)) return; // we don't wish to process this reaction if it's to an existing HeartBoard embed

    const heartBoards = getHeartBoardsByEmoji(serverID, emojiString);
    heartBoards.forEach(async (heartBoard) => {
      if (!heartBoard.enabled) return;
      if (heartBoard.deny_author && user.id === message.author?.id) {
        reaction.users.remove(user.id).catch((error) => console.error(error));
        return;
      }

      try {
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
            embedMessage.delete().catch((error) => console.error(error));
            deleteHeartBoardMessage(serverID, heartBoard.board_name, messageID);
            return;
          }

          // if it's still above the threshold, we wish to simply edit the message
          const authorMember = await guild.members.fetch(message.author?.id ?? 'unknown');
          const messageOptions = heartboardEmbedBuilder(authorMember, message, reaction);

          embedMessage.edit(messageOptions).catch((error) => console.error(error));
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
      } catch (error) {
        console.error(error);
      }
    });
  };

  discordClient.on(Events.MessageReactionAdd, async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    try {
      // only adding a 🗑️ deletes a DM message, so this isn't in handleReaction, which removing one runs too
      if (!reaction.message.guildId) await handleDMReaction(reaction, user);
      await handleReaction(reaction, user);
    } catch (error) {
      console.error(error);
    }
  });
  discordClient.on(Events.MessageReactionRemove, async (reaction: MessageReaction | PartialMessageReaction, user: User | PartialUser) => {
    try {
      await handleReaction(reaction, user);
    } catch (error) {
      console.error(error);
    }
  });
}

export default clientEvents;
