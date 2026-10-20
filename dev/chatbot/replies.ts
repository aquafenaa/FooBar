// the chatbot's replies to messages: sending them, and the buttons under them to retry the reply (🔄) or switch between its versions (◀️ ▶️).
// only a channel's latest reply has buttons. once another replaces it, it keeps whichever version was on screen.
// versions are kept in memory, so the buttons on replies from before a restart stop working
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, GuildTextBasedChannel, Message, MessageFlags, Snowflake } from 'discord.js';

import { updateConversationMessageContent } from '../data';
import { estimateTokens, safeFetch } from '../utils';
import { generateReply } from './chatbot';

const MAX_VERSIONS = 5; // per reply, since each retry is a full model call
// what a message shows when the version on screen doesn't need it. edited to this rather than deleted,
// since a later version that needs it again would have to send a new one, which could land after other people's messages
const EMPTY_MESSAGE = '-# ⠀';

interface ReplyState {
  serverID: Snowflake,
  channel: GuildTextBasedChannel,
  userMessageID: Snowflake, // the message being replied to
  authorID: Snowflake, // its author, the only one who can use the buttons
  messageIDs: Snowflake[], // the reply's messages, in order. the buttons are on the last one
  versions: string[][], // each version's message contents
  current: number, // index of the version on screen
  busy: boolean, // a retry is generating
  rendering: Promise<void>, // the version changes still being edited in, so quick presses take turns instead of mixing versions
}

// only each channel's latest reply, since older ones have no buttons left to press
const replies = new Map<Snowflake, ReplyState>(); // by every one of a reply's message ids
const latestReplies = new Map<Snowflake, ReplyState>(); // by channel id

function isLatest(state: ReplyState): boolean {
  return latestReplies.get(state.channel.id) === state;
}

// the buttons under a reply. none once it's no longer the channel's latest, so the version on screen stays
function buttonRows(state: ReplyState): ActionRowBuilder<ButtonBuilder>[] {
  if (!isLatest(state)) return [];

  const page = new ButtonBuilder().setCustomId('reply:page').setLabel(`${state.current + 1}/${state.versions.length}`).setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  const row = new ActionRowBuilder<ButtonBuilder>();
  // the arrows only once there's another version to switch to. the page is always shown, so 1/1 makes it clear there's just the one
  if (state.versions.length > 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId('reply:prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
        .setDisabled(state.busy || state.current === 0),
      page,
      new ButtonBuilder().setCustomId('reply:next').setEmoji('▶️').setStyle(ButtonStyle.Secondary)
        .setDisabled(state.busy || state.current === state.versions.length - 1),
    );
  } else {
    row.addComponents(page);
  }
  row.addComponents(new ButtonBuilder().setCustomId('reply:retry').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
    .setDisabled(state.busy || state.versions.length >= MAX_VERSIONS));

  return [row];
}

// shows the current version, by editing the reply's messages in place
async function showVersion(state: ReplyState): Promise<void> {
  const chunks = state.versions[state.current];

  // a longer version than any before needs more messages. only then is one sent, and the buttons move down to it
  while (state.messageIDs.length < chunks.length) {
    const previousLast = state.messageIDs[state.messageIDs.length - 1];
    const sent = await state.channel.send({ content: EMPTY_MESSAGE });
    state.messageIDs.push(sent.id);
    if (isLatest(state)) replies.set(sent.id, state); // a retry can finish after a newer reply replaced it
    await state.channel.messages.edit(previousLast, { components: [] });
  }

  for (const [i, id] of state.messageIDs.entries()) {
    const content = chunks[i] ?? EMPTY_MESSAGE;
    await state.channel.messages.edit(id, { content, components: i === state.messageIDs.length - 1 ? buttonRows(state) : [] });
    // so the bot remembers the version on screen, if the message was already saved into its conversation
    updateConversationMessageContent(id, content, estimateTokens(content));
  }
}

// queued behind any change still being edited in. each shows whichever version is current when its turn comes
function queueShowVersion(state: ReplyState): Promise<void> {
  state.rendering = state.rendering.then(() => showVersion(state)).catch((error) => console.error(error));
  return state.rendering;
}

async function refreshButtons(state: ReplyState): Promise<void> {
  await state.channel.messages.edit(state.messageIDs[state.messageIDs.length - 1], { components: buttonRows(state) });
}

/**
 * Sends a reply to a message, with its buttons. Only a channel's latest reply has them,
 * so the previous one loses its buttons, and keeps whichever version was on screen
 */
async function sendReply(message: Message<true>, chunks: string[]): Promise<void> {
  if (chunks.length === 0 || !message.channel.isSendable()) return;

  const state: ReplyState = {
    serverID: message.guildId,
    channel: message.channel,
    userMessageID: message.id,
    authorID: message.author.id,
    messageIDs: [],
    versions: [chunks],
    current: 0,
    busy: false,
    rendering: Promise.resolve(),
  };
  const previous = latestReplies.get(message.channel.id);
  latestReplies.set(message.channel.id, state); // set first, so its buttons are made

  for (const [i, chunk] of chunks.entries()) {
    const options = { content: chunk, components: i === chunks.length - 1 ? buttonRows(state) : [] };
    const sent = i === 0 ? await message.reply(options) : await message.channel.send(options); // one at a time, so they arrive in order
    state.messageIDs.push(sent.id);
  }

  if (previous) {
    previous.messageIDs.forEach((id) => replies.delete(id));
    await refreshButtons(previous).catch((error) => console.error(error)); // removes them, now it's not the latest
  }

  // another reply in this channel can finish while this one is still sending, and its cleanup ran before these messages existed
  if (!isLatest(state)) {
    await refreshButtons(state).catch((error) => console.error(error)); // removes the buttons this one was sent with
    return;
  }
  state.messageIDs.forEach((id) => replies.set(id, state));
}

async function retry(state: ReplyState, interaction: ButtonInteraction): Promise<void> {
  state.busy = true;
  await interaction.update({ components: buttonRows(state) }); // shows the buttons disabled while it generates

  state.channel.sendTyping();
  const typingIndicator = setInterval(() => state.channel.sendTyping(), 5000);
  try {
    // the same input as the first time: the message, what it replied to, and the 5 messages before it
    const message = await state.channel.messages.fetch(state.userMessageID);
    const reference = message.reference ? await safeFetch(() => message.fetchReference()) : undefined;
    const context = [...(await state.channel.messages.fetch({ limit: 5, before: message.id })).values()];

    const { chunks } = await generateReply(state.serverID, { channel: state.channel, context, message, reference });
    if (chunks.length > 0) {
      state.versions.push(chunks);
      state.current = state.versions.length - 1;
    }
  } catch (error: any) {
    console.error(error);
    interaction.followUp({ content: `Couldn't retry: ${error?.message ?? 'unknown error'}`, flags: MessageFlags.Ephemeral }).catch((err) => console.error(err));
  } finally {
    clearInterval(typingIndicator);
    state.busy = false;
  }

  await queueShowVersion(state);
}

async function handleReplyButton(interaction: ButtonInteraction): Promise<void> {
  const state = replies.get(interaction.message.id);
  if (!state) {
    await interaction.update({ components: [] });
    // a newer reply replaced it (and the buttons were already removed), or the bot restarted
    await interaction.followUp({ content: 'These buttons no longer work. Only the latest reply can be changed.', flags: MessageFlags.Ephemeral });
    return;
  }

  const ephemeral = (content: string) => interaction.reply({ content, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
  if (interaction.user.id !== state.authorID) {
    await ephemeral(`Only <@${state.authorID}> can use these buttons, since it's their message being replied to.`);
    return;
  }
  if (state.busy) {
    await ephemeral('A new version is still being written.');
    return;
  }

  // the buttons are already gone from older replies, but someone could press them before that edit lands
  if (!isLatest(state)) {
    await ephemeral('Only the latest reply can be changed.');
    return;
  }

  const action = interaction.customId.split(':')[1];
  if (action === 'prev' || action === 'next') {
    state.current = Math.min(Math.max(state.current + (action === 'next' ? 1 : -1), 0), state.versions.length - 1);
    await interaction.deferUpdate();
    await queueShowVersion(state);
    return;
  }
  if (action === 'retry') {
    if (state.versions.length >= MAX_VERSIONS) {
      await ephemeral(`A reply can have at most ${MAX_VERSIONS} versions.`);
      return;
    }
    await retry(state, interaction);
  }
}

export { sendReply, handleReplyButton };
