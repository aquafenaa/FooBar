// the chatbot's replies to messages: sending them, and the buttons under them to retry the reply (🔄) or switch between its versions (◀️ ▶️).
// only a channel's latest reply has buttons. once another replaces it, it keeps whichever version was on screen.
// versions are kept in memory, so the buttons on replies from before a restart stop working.
// while a reply is being written, its status message has Stop (no more tools, answer now) and Cancel (throw it all away) buttons, and so does a retry
import { ActionRowBuilder, ButtonBuilder, ButtonInteraction, ButtonStyle, Message, MessageFlags, PermissionFlagsBits, SendableChannels, Snowflake } from 'discord.js';

import { setToolResultsDiscarded, updateConversationMessageContent } from '../data';
import { ToolResultDiscard } from '../types/schema';
import { estimateTokens, safeFetch } from '../utils';
import { ReplyControl, THINKING_STATUS, chatbotMentions, generateReply, setWriting } from './chatbot';

// a reply still being written, which its Stop and Cancel buttons can cut short, and its author can add to
interface PendingReply {
  authorID: Snowflake, // whose message it's replying to. they can press the buttons, and so can moderators
  stop: AbortController,
  cancel: AbortController,
  restart: AbortController, // replaced with a new one each time the reply starts over
  restartWith?: Message, // the author's new message it's starting over for
  sending?: boolean, // it's being sent, so it's too late to start over
  control: ReplyControl, // what generateReply is given
}

function newPendingReply(authorID: Snowflake): PendingReply {
  const stop = new AbortController();
  const cancel = new AbortController();
  const restart = new AbortController();
  return { authorID, stop, cancel, restart, control: { stop: stop.signal, cancel: cancel.signal, restart: restart.signal, toolCallIDs: [], toolCalls: [] } };
}

// a reply that was cancelled or failed: what its tools only looked up is forgotten, and what they changed is kept with a note saying so
function discardToolResults(pending: PendingReply, reason: ToolResultDiscard): void {
  setToolResultsDiscarded(pending.control.toolCallIDs, reason);
}

// whoever it's replying to, or a moderator, so a reply that's going wrong can always be stopped
function canInterrupt(interaction: ButtonInteraction, authorID: Snowflake): boolean {
  return interaction.user.id === authorID || !!interaction.memberPermissions?.has(PermissionFlagsBits.ManageMessages);
}

const pendingReplies = new Map<Snowflake, PendingReply>(); // by their status message's id

function statusButtons(pending: PendingReply): ActionRowBuilder<ButtonBuilder>[] {
  return [new ActionRowBuilder<ButtonBuilder>().addComponents(
    new ButtonBuilder().setCustomId('status:stop').setEmoji('⏹️').setLabel('Stop')
      .setStyle(ButtonStyle.Secondary)
      .setDisabled(pending.stop.signal.aborted),
    new ButtonBuilder().setCustomId('status:cancel').setEmoji('✖️').setLabel('Cancel')
      .setStyle(ButtonStyle.Danger),
  )];
}

/**
 * Starts tracking a reply being written, under its status message, which should be sent with statusButtons.
 * Call untrackReply once it's done, however it ends
 */
function trackReply(statusMessageID: Snowflake, authorID: Snowflake): PendingReply {
  const pending = newPendingReply(authorID);
  pendingReplies.set(statusMessageID, pending);
  setWriting(statusMessageID, true);
  return pending;
}
function untrackReply(statusMessageID: Snowflake): void {
  pendingReplies.delete(statusMessageID);
  setWriting(statusMessageID, false);
}

/**
 * A message replying to a status message, from the author of what's being replied to: the reply starts over with it added,
 * keeping what its tools already did. Returns whether it did, so the message isn't answered separately as well
 */
function restartReply(message: Message): boolean {
  const pending = message.reference?.messageId ? pendingReplies.get(message.reference.messageId) : undefined;
  if (!pending || message.author.id !== pending.authorID || pending.cancel.signal.aborted || pending.sending) return false;

  pending.restartWith = message;
  pending.restart.abort();
  return true;
}
// called by whatever's writing the reply, once it's noticed it was restarted, for the next attempt
function nextAttempt(pending: PendingReply): Message | undefined {
  const message = pending.restartWith;
  pending.restartWith = undefined;
  pending.restart = new AbortController();
  pending.control.restart = pending.restart.signal;
  return message;
}

async function handleStatusButton(interaction: ButtonInteraction): Promise<void> {
  const pending = pendingReplies.get(interaction.message.id);
  if (!pending) {
    await interaction.update({ components: [] }); // the reply already finished
    return;
  }
  if (!canInterrupt(interaction, pending.authorID)) {
    await interaction.reply({ content: `Only <@${pending.authorID}> or a moderator can stop this reply.`, flags: MessageFlags.Ephemeral, allowedMentions: { parse: [] } });
    return;
  }

  if (interaction.customId === 'status:stop') {
    pending.stop.abort(); // the reply changes its status to say so
    await interaction.update({ components: statusButtons(pending) });
    return;
  }

  // cancel: whatever started the reply sees it's cancelled, and cleans up the rest
  pending.cancel.abort();
  untrackReply(interaction.message.id);
  await interaction.deferUpdate();
  await interaction.message.delete().catch(() => undefined);
}

const MAX_VERSIONS = 5; // per reply, since each retry is a full model call

interface ReplyState {
  serverID: Snowflake,
  channel: SendableChannels, // a server's channel, or a DM
  userMessageID: Snowflake, // the message being replied to
  authorID: Snowflake, // its author, the only one who can use the buttons
  messageIDs: Snowflake[], // the reply's messages, in order. the buttons are on the last one
  shown: string[], // what each of them says now, so only the ones that change are edited
  versions: string[][], // each version's message contents
  versionToolCalls: string[][], // each version's tool results. only the version on screen's count in full, see syncToolResults
  current: number, // index of the version on screen
  busy: boolean, // a retry is generating
  pending?: PendingReply, // that retry, for its Stop and Cancel buttons
  status?: string, // what that retry is doing, shown in place of the reply until it's done, like a new reply's status message
  rendering: Promise<void>, // the version changes still being edited in, so quick presses take turns instead of mixing versions
}

// only each channel's latest reply, since older ones have no buttons left to press
const replies = new Map<Snowflake, ReplyState>(); // by every one of a reply's message ids
const latestReplies = new Map<Snowflake, ReplyState>(); // by channel id

// every reply's messages, older ones too, by each of their ids, so deleting one part of a reply can delete all of it.
// the reply's own list, so messages a longer version adds are included. in memory, and only the most recent are kept
const MAX_REPLY_GROUPS = 5_000;
const replyGroups = new Map<Snowflake, Snowflake[]>();
function rememberReplyMessage(messageID: Snowflake, messageIDs: Snowflake[]): void {
  replyGroups.set(messageID, messageIDs);
  while (replyGroups.size > MAX_REPLY_GROUPS) replyGroups.delete(replyGroups.keys().next().value!);
}

/**
 * The messages to delete when someone deletes one message of a reply: the whole reply, so half an answer isn't left behind.
 * Its buttons stop working too, since there's nothing left to edit. Just the message itself, for one that isn't part of a reply
 */
function forgetReply(messageID: Snowflake): Snowflake[] {
  const messageIDs = [...(replyGroups.get(messageID) ?? [messageID])];
  messageIDs.forEach((id) => {
    replyGroups.delete(id);
    const state = replies.get(id);
    replies.delete(id);
    if (state && isLatest(state)) latestReplies.delete(state.channel.id);
  });
  return messageIDs;
}

function isLatest(state: ReplyState): boolean {
  return latestReplies.get(state.channel.id) === state;
}

// the buttons under a reply. none once it's no longer the channel's latest, so the version on screen stays
function buttonRows(state: ReplyState): ActionRowBuilder<ButtonBuilder>[] {
  if (!isLatest(state)) return [];

  const total = state.versions.length;
  // while a retry is being written, the page is the version on its way, e.g. 3/2, until it's done and becomes 3/3
  const page = new ButtonBuilder().setCustomId('reply:page').setLabel(state.pending ? `${total + 1}/${total}` : `${state.current + 1}/${total}`)
    .setStyle(ButtonStyle.Secondary)
    .setDisabled(true);
  // 🔄 always sits between the page and ▶️. while a retry is being written, a … takes its place
  const retryButton = state.pending
    ? new ButtonBuilder().setCustomId('reply:writing').setLabel('…').setStyle(ButtonStyle.Secondary)
      .setDisabled(true)
    : new ButtonBuilder().setCustomId('reply:retry').setEmoji('🔄').setStyle(ButtonStyle.Secondary)
      .setDisabled(state.busy || total >= MAX_VERSIONS);

  const row = new ActionRowBuilder<ButtonBuilder>();
  // a retry being written can be stopped or cancelled like a new reply. the arrows are hidden meanwhile, since they can't be used
  if (state.pending) {
    return [row.addComponents(
      page,
      retryButton,
      new ButtonBuilder().setCustomId('reply:stop').setEmoji('⏹️').setLabel('Stop')
        .setStyle(ButtonStyle.Secondary)
        .setDisabled(state.pending.stop.signal.aborted),
      new ButtonBuilder().setCustomId('reply:cancel').setEmoji('✖️').setLabel('Cancel')
        .setStyle(ButtonStyle.Danger),
    )];
  }
  // the arrows only once there's another version to switch to. the page is always shown, so 1/1 makes it clear there's just the one
  if (total > 1) {
    row.addComponents(
      new ButtonBuilder().setCustomId('reply:prev').setEmoji('◀️').setStyle(ButtonStyle.Secondary)
        .setDisabled(state.busy || state.current === 0),
      page,
      retryButton,
      new ButtonBuilder().setCustomId('reply:next').setEmoji('▶️').setStyle(ButtonStyle.Secondary)
        .setDisabled(state.busy || state.current === total - 1),
    );
  } else {
    row.addComponents(page, retryButton);
  }
  return [row];
}

// the version on screen's tool results count in full. every other version's are marked as replaced, so what they only looked up is
// forgotten, and what they changed is kept with a note. while a retry is being written, none are on screen, so it starts fresh
function syncToolResults(state: ReplyState): void {
  state.versionToolCalls.forEach((ids, i) => setToolResultsDiscarded(ids, i === state.current && !state.pending ? undefined : 'replaced'));
}

// shows the current version, by editing the reply's messages in place. while a retry is being written, its status instead
async function showVersion(state: ReplyState): Promise<void> {
  const showingStatus = state.status !== undefined;
  syncToolResults(state);
  const chunks = showingStatus ? [state.status!] : state.versions[state.current];

  // messages this version doesn't need are deleted, rather than left blank
  while (state.messageIDs.length > chunks.length) {
    const id = state.messageIDs.pop()!;
    state.shown.pop();
    replies.delete(id);
    setWriting(id, false);
    await state.channel.messages.delete(id).catch(() => undefined);
  }
  // and ones it needs are sent, with the buttons moving down to the new last one
  while (state.messageIDs.length < chunks.length) {
    const content = chunks[state.messageIDs.length];
    const previousLast = state.messageIDs[state.messageIDs.length - 1];
    const sent = await state.channel.send({ content, allowedMentions: chatbotMentions(state.serverID, content) });
    state.messageIDs.push(sent.id);
    state.shown.push(content);
    rememberReplyMessage(sent.id, state.messageIDs);
    if (isLatest(state)) replies.set(sent.id, state); // a retry can finish after a newer reply replaced it
    await state.channel.messages.edit(previousLast, { components: [] });
  }

  for (const [i, id] of state.messageIDs.entries()) {
    const content = chunks[i];
    const isLast = i === state.messageIDs.length - 1;
    // the last one is always edited, since its buttons change too
    if (content !== state.shown[i] || isLast) {
      await state.channel.messages.edit(id, { content, components: isLast ? buttonRows(state) : [], allowedMentions: chatbotMentions(state.serverID, content) });
      state.shown[i] = content;
    }
    // while it shows a status, the model sees a placeholder for it instead
    setWriting(id, showingStatus);
    // so the bot remembers the version on screen, if the message was already saved into its conversation. never a status, which is only for show
    if (!showingStatus) updateConversationMessageContent(id, content, estimateTokens(content));
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
 * so the previous one loses its buttons, and keeps whichever version was on screen.
 * If it's cancelled partway, what was already sent is deleted, and the previous reply stays the latest
 */
async function sendReply(serverID: Snowflake, message: Message, chunks: string[], pending?: PendingReply): Promise<boolean> {
  const cancel = pending?.cancel.signal;
  if (chunks.length === 0 || !message.channel.isSendable() || cancel?.aborted) return false;

  const state: ReplyState = {
    serverID, // a DM with the bot's owner is a server of its own, keyed by their user id

    channel: message.channel,
    userMessageID: message.id,
    authorID: message.author.id,
    messageIDs: [],
    shown: [],
    versions: [chunks],
    versionToolCalls: [pending?.control.toolCallIDs ?? []],
    current: 0,
    busy: false,
    rendering: Promise.resolve(),
  };
  const previous = latestReplies.get(message.channel.id);
  latestReplies.set(message.channel.id, state); // set first, so its buttons are made

  for (const [i, chunk] of chunks.entries()) {
    if (cancel?.aborted) break;
    const options = { content: chunk, components: i === chunks.length - 1 ? buttonRows(state) : [], allowedMentions: chatbotMentions(state.serverID, chunk) };
    const sent = i === 0 ? await message.reply(options) : await message.channel.send(options); // one at a time, so they arrive in order
    state.messageIDs.push(sent.id);
    state.shown.push(chunk);
    rememberReplyMessage(sent.id, state.messageIDs);
  }

  if (cancel?.aborted) {
    // deleting them also takes them back out of the conversation, through the message delete event
    await Promise.all(state.messageIDs.map((id) => message.channel.messages.delete(id).catch(() => undefined)));
    if (isLatest(state)) {
      if (previous) latestReplies.set(message.channel.id, previous);
      else latestReplies.delete(message.channel.id);
    } else if (previous) {
      // a newer reply took over meanwhile, and only cleaned up this one, so the one before still has its buttons
      previous.messageIDs.forEach((id) => replies.delete(id));
      await refreshButtons(previous).catch((error) => console.error(error));
    }
    return false;
  }

  if (previous) {
    previous.messageIDs.forEach((id) => replies.delete(id));
    await refreshButtons(previous).catch((error) => console.error(error)); // removes them, now it's not the latest
  }

  // another reply in this channel can finish while this one is still sending, and its cleanup ran before these messages existed
  if (!isLatest(state)) {
    await refreshButtons(state).catch((error) => console.error(error)); // removes the buttons this one was sent with
    return true;
  }
  state.messageIDs.forEach((id) => replies.set(id, state));
  return true;
}

async function retry(state: ReplyState, interaction: ButtonInteraction): Promise<void> {
  const pending = newPendingReply(state.authorID);
  state.busy = true;
  state.pending = pending;
  // the reply shows what the retry is doing until it's done, like a new reply's status message, with the buttons disabled, and Stop and Cancel
  state.status = THINKING_STATUS;
  await interaction.deferUpdate();
  queueShowVersion(state); // also marks every version's tool results as replaced, so the retry doesn't build on the one it's replacing
  const onStatus = (status: string) => {
    if (state.pending !== pending || status === state.status) return;
    state.status = status;
    queueShowVersion(state);
  };

  try {
    // the same input as the first time: the message, what it replied to, and the 5 messages before it
    const message = await state.channel.messages.fetch(state.userMessageID);
    const reference = message.reference ? await safeFetch(() => message.fetchReference()) : undefined;
    const context = [...(await state.channel.messages.fetch({ limit: 5, before: message.id })).values()];

    const { chunks } = await generateReply(state.serverID, { channel: state.channel, context, message, reference, onStatus, control: pending.control });
    if (chunks.length > 0 && !pending.cancel.signal.aborted) {
      state.versions.push(chunks);
      state.versionToolCalls.push(pending.control.toolCallIDs);
      state.current = state.versions.length - 1;
    } else {
      discardToolResults(pending, pending.cancel.signal.aborted ? 'cancelled' : 'failed'); // nothing to show for it
    }
  } catch (error: any) {
    discardToolResults(pending, pending.cancel.signal.aborted ? 'cancelled' : 'failed');
    // cancelled with its button, which already put the buttons back
    if (!pending.cancel.signal.aborted) {
      console.error(error);
      interaction.followUp({ content: `Couldn't retry: ${error?.message ?? 'unknown error'}`, flags: MessageFlags.Ephemeral }).catch((err) => console.error(err));
    }
  }

  // a cancelled retry already let go of the reply, and a newer retry may have started since
  if (state.pending !== pending) return;
  state.busy = false;
  state.pending = undefined;
  state.status = undefined; // shows the new version, or the one from before if it failed
  await queueShowVersion(state);
}

async function interruptRetry(state: ReplyState, interaction: ButtonInteraction, action: 'stop' | 'cancel'): Promise<void> {
  const { pending } = state;
  if (!pending) {
    await interaction.deferUpdate();
    return;
  }

  await interaction.deferUpdate();
  if (action === 'stop') {
    pending.stop.abort(); // the retry changes its status to say so, which greys out the Stop button too
    return;
  }

  // cancel: the reply goes straight back to the version it showed, without waiting for the retry to notice
  pending.cancel.abort();
  state.busy = false;
  state.pending = undefined;
  state.status = undefined;
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
  const action = interaction.customId.split(':')[1];

  // stopping a retry that's being written. moderators can too, unlike the other buttons
  if (action === 'stop' || action === 'cancel') {
    if (!canInterrupt(interaction, state.authorID)) {
      await ephemeral(`Only <@${state.authorID}> or a moderator can stop this.`);
      return;
    }
    await interruptRetry(state, interaction, action);
    return;
  }

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

export { PendingReply, sendReply, forgetReply, restartReply, nextAttempt, handleReplyButton, statusButtons, trackReply, untrackReply, discardToolResults, handleStatusButton };
