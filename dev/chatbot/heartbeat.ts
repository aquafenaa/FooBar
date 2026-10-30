// heartbeats: prompts the chatbot is given on a schedule, so it can post on its own (e.g. a morning check-in), with no message to answer
import cron from 'node-cron';
import { Snowflake, SnowflakeUtil } from 'discord.js';

import { discordClient } from '..';
import { deleteConversation, deleteHeartbeat, getChatbot, getConversationMessages, getHeartbeat, getHeartbeatsByServer, insertConversationMessage } from '../data';
import { HeartbeatTable } from '../types/schema';
import { estimateTokens } from '../utils';
import { chatbotMentions, generateReply, isAllowedServer } from './chatbot';
import { getVisibleToolResults, summarizeConversation } from './conversation';
import { fetchServerChannel } from './dm';

const MAX_BOT_HEARTBEATS = 10; // per server, for ones the bot scheduled itself, since each beat is a model call

// prefixed, so it can't clash with a reminder's task, which is named `${server_id}${reminder_name}`
function taskName(serverID: Snowflake, heartbeatName: string): string {
  return `heartbeat${serverID}${heartbeatName.toLowerCase()}`;
}

function unscheduleHeartbeat(serverID: Snowflake, heartbeatName: string): void {
  const name = taskName(serverID, heartbeatName);
  cron.getTasks().forEach((task) => {
    if (task.name === name) task.destroy();
  });
}

// (re)schedules a heartbeat, replacing any task it already had
function scheduleHeartbeat(heartbeat: HeartbeatTable): void {
  unscheduleHeartbeat(heartbeat.server_id, heartbeat.heartbeat_name);
  cron.schedule(heartbeat.cron_schedule, () => runHeartbeat(heartbeat.server_id, heartbeat.heartbeat_name), {
    name: taskName(heartbeat.server_id, heartbeat.heartbeat_name),
  });
}

function removeHeartbeat(heartbeat: HeartbeatTable): void {
  unscheduleHeartbeat(heartbeat.server_id, heartbeat.heartbeat_name);
  deleteHeartbeat(heartbeat.server_id, heartbeat.heartbeat_name);
}

function loadHeartbeats(serverID: Snowflake): void {
  getHeartbeatsByServer(serverID).forEach((heartbeat) => {
    if (!cron.validate(heartbeat.cron_schedule)) {
      console.error(`Heartbeat "${heartbeat.heartbeat_name}" (server ${serverID}): invalid schedule "${heartbeat.cron_schedule}"`);
      return;
    }
    scheduleHeartbeat(heartbeat);
  });
}

// a beat's conversation, once it's done or has failed: summarized right away if the bot did anything, or thrown away if it didn't
async function settleConversation(conversationID: string): Promise<void> {
  const didSomething = getVisibleToolResults(conversationID).length > 0
    || getConversationMessages(conversationID).some((message) => message.role === 'assistant');

  if (didSomething) await summarizeConversation(conversationID);
  else deleteConversation(conversationID);
}

// heartbeats still generating, so a slow beat is skipped rather than overlapping with the next one
const running = new Set<string>();

async function runHeartbeat(serverID: Snowflake, heartbeatName: string): Promise<void> {
  const heartbeat = getHeartbeat(serverID, heartbeatName); // read fresh, so edits since it was scheduled apply
  if (!heartbeat) return;
  // removed before running, so a one-time heartbeat never fires twice, even if its reply fails
  if (!heartbeat.repeats) removeHeartbeat(heartbeat);

  const key = taskName(serverID, heartbeatName);
  if (running.has(key)) return;
  running.add(key);

  let conversationID: string | undefined;
  try {
    const chatbot = getChatbot(serverID);
    if (!chatbot?.chatbot_enabled || !chatbot.tools_enabled || !isAllowedServer(serverID)) return;

    // a channel in its server, or for a DM with the bot's owner, the DM itself
    const channel = await fetchServerChannel(serverID, heartbeat.channel_id);
    if (!channel || !channel.isTextBased() || !channel.isSendable()) {
      console.error(`Heartbeat "${heartbeat.heartbeat_name}" (server ${serverID}): channel ${heartbeat.channel_id} not found or not sendable`);
      return;
    }

    // its own conversation, rather than the channel's. picked here, so it can be settled even if generating fails partway
    conversationID = `${channel.id}${SnowflakeUtil.generate().toString()}`;
    const { chunks } = await generateReply(serverID, { channel, heartbeat, conversation_id: conversationID });

    // a silent beat's reply isn't posted, but it's still saved as the bot's turn, so the summary has what it said it did
    if (heartbeat.silent) {
      const reply = chunks.join('\n');
      if (reply) {
        insertConversationMessage({
          conversation_id: conversationID,
          message_id: `heartbeat-reply${Date.now()}`,
          role: 'assistant',
          author_id: discordClient.user!.id,
          author_name: discordClient.user!.displayName,
          timestamp: Date.now(),
          message_content: reply,
          token_count: estimateTokens(reply),
        });
      }
      return;
    }

    for (const chunk of chunks) {
      const sent = await channel.send({ content: chunk, allowedMentions: chatbotMentions(serverID, chunk) }); // one at a time, so they arrive in order
      // saved as the bot's turns, so the summary has what was actually posted
      insertConversationMessage({
        conversation_id: conversationID,
        message_id: sent.id,
        role: 'assistant',
        author_id: sent.author.id,
        author_name: sent.author.displayName,
        timestamp: sent.createdTimestamp,
        message_content: chunk,
        token_count: estimateTokens(chunk),
      });
    }
  } catch (error) {
    console.error(`Heartbeat "${heartbeat.heartbeat_name}" (server ${serverID}) failed:`, error);
  } finally {
    running.delete(key);
  }

  // on success or failure, so anything it sent or did before failing is still remembered
  if (conversationID) await settleConversation(conversationID).catch((error) => console.error(error));
}

export { MAX_BOT_HEARTBEATS, scheduleHeartbeat, removeHeartbeat, loadHeartbeats };
