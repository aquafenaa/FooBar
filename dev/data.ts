import path from 'node:path';
import { Snowflake } from 'discord.js';
import Database from 'better-sqlite3';
import cron from 'node-cron';
import { readFileSync } from 'fs';

import { AutomaticResponseTable, ReminderTable, HeartbeatTable, CounterTable, ChatbotSubscriberTable, ChatbotTable, HeartBoardEmojiTable, HeartBoardMessageTable, HeartBoardTable, SavedAnonymizedChat, ServerTable, VoicePingInputTable, VoicePingTable, MemoryTable, ConversationTable, ConversationMessageTable, ConversationSummaryTable, ConversationToolResultTable, ToolResultDiscard, IndexUserTable, IndexMessageTable, IndexChannelTable, IndexRoleTable } from './types/schema';
import { ConfigData, ServerConfig, ServerData } from './types/bot';
import { getBaseSystemPrompt, getDefaultSystemPrompt } from './chatbot/chatbot';
import { fromBlob, SOURCE_SEPARATOR, toBlob } from './chatbot/conversation';

const schemaPath = path.join(__dirname, '../data/seed/schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');

const dataPath = path.join(__dirname, '../data/data.json');
const configPath = path.join(__dirname, '../data/config.json');

const dbPath = path.join(__dirname, '../data/foobar.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

db.exec(schema);

// ==================== Server ====================
function getAllServers(): Snowflake[] {
  const servers = db.prepare('SELECT server_id FROM Server').all() as { server_id: Snowflake }[];
  return servers.map((srv) => srv.server_id);
}

// ==================== Chatbot ====================
function getChatbot(server_id: Snowflake): ChatbotTable | null {
  const chatbot = db.prepare('SELECT * FROM Chatbot WHERE server_id = ?').get(server_id ?? '') as ChatbotTable | null;
  if (!chatbot) return null;

  chatbot.chatbot_enabled = Boolean(chatbot.chatbot_enabled);
  chatbot.tools_enabled = Boolean(chatbot.tools_enabled);
  chatbot.detached = Boolean(chatbot.detached);
  chatbot.model = chatbot.model ?? undefined;
  chatbot.reasoning_effort = chatbot.reasoning_effort ?? undefined;
  chatbot.temperature = chatbot.temperature ?? undefined;
  chatbot.system_prompt_override = chatbot.system_prompt_override ?? undefined;
  return chatbot;
}
// servers whose chatbot shares the 'main' context
function getAttachedServers(): Snowflake[] {
  return (db.prepare('SELECT server_id FROM Chatbot WHERE detached IS NOT 1').all() as { server_id: Snowflake }[]).map((row) => row.server_id);
}
function upsertChatbot(chatbot: ChatbotTable): void {
  db.prepare(`
    INSERT INTO Chatbot (server_id, chatbot_enabled, tools_enabled, detached, model, reasoning_effort, temperature, system_prompt_override, chatbot_prompt)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      chatbot_enabled = excluded.chatbot_enabled,
      tools_enabled = excluded.tools_enabled,
      detached = excluded.detached,
      model = excluded.model,
      reasoning_effort = excluded.reasoning_effort,
      temperature = excluded.temperature,
      system_prompt_override = excluded.system_prompt_override,
      chatbot_prompt = excluded.chatbot_prompt
  `).run(
    chatbot.server_id,
    chatbot.chatbot_enabled ? 1 : 0,
    chatbot.tools_enabled ? 1 : 0,
    chatbot.detached ? 1 : 0,
    chatbot.model ?? null,
    chatbot.reasoning_effort ?? null,
    chatbot.temperature ?? null,
    chatbot.system_prompt_override ?? null,
    chatbot.chatbot_prompt,
  );
}
function deleteChatbot(server_id: Snowflake) {
  db.prepare('DELETE FROM Chatbot WHERE server_id = ?').run(server_id);
}
function setChatbotPrompt(server_id: Snowflake, new_prompt: string): void {
  db.prepare('UPDATE Chatbot SET chatbot_prompt = ? WHERE server_id = ?').run(new_prompt, server_id);
}
function isChatbotSubscriber(server_id: Snowflake, user_id: Snowflake): boolean {
  return db.prepare('SELECT 1 FROM ChatbotSubscriber WHERE server_id = ? AND user_id = ?').get(server_id, user_id) !== undefined;
}
function addChatbotSubscriber(server_id: Snowflake, user_id: Snowflake, cross_server = false): void {
  db.prepare('INSERT INTO ChatbotSubscriber (server_id, user_id, cross_server) VALUES (?, ?, ?)').run(server_id, user_id, cross_server ? 1 : 0);
}
function getChatbotSubscriber(server_id: Snowflake, user_id: Snowflake): ChatbotSubscriberTable | undefined {
  const subscriber = db.prepare('SELECT * FROM ChatbotSubscriber WHERE server_id = ? AND user_id = ?').get(server_id, user_id) as ChatbotSubscriberTable | undefined;
  if (!subscriber) return undefined;

  return { ...subscriber, cross_server: Boolean(subscriber.cross_server) };
}
function setChatbotSubscriberCrossServer(server_id: Snowflake, user_id: Snowflake, cross_server: boolean): void {
  db.prepare('UPDATE ChatbotSubscriber SET cross_server = ? WHERE server_id = ? AND user_id = ?').run(cross_server ? 1 : 0, server_id, user_id);
}
// which of the given users have opted in to sharing their messages from this server with other servers
function getCrossServerSubscribers(server_id: Snowflake, user_ids: string[]): Set<string> {
  if (user_ids.length === 0) return new Set();

  const rows = db.prepare(`SELECT user_id FROM ChatbotSubscriber WHERE server_id = ? AND cross_server = 1 AND user_id IN (${user_ids.map(() => '?').join(', ')})`)
    .all(server_id, ...user_ids) as { user_id: string }[];
  return new Set(rows.map((row) => row.user_id));
}
// which of the given users have subscribed to the chatbot in this server
function getSubscribersAmong(server_id: Snowflake, user_ids: string[]): Set<string> {
  if (user_ids.length === 0) return new Set();

  const rows = db.prepare(`SELECT user_id FROM ChatbotSubscriber WHERE server_id = ? AND user_id IN (${user_ids.map(() => '?').join(', ')})`)
    .all(server_id, ...user_ids) as { user_id: string }[];
  return new Set(rows.map((row) => row.user_id));
}
function removeChatbotSubscriber(server_id: Snowflake, user_id: Snowflake): void {
  db.prepare('DELETE FROM ChatbotSubscriber WHERE server_id = ? AND user_id = ?').run(server_id, user_id);
}

// ==================== SavedAnonymizedChats ====================
function saveAnonymizedMessage(anonymizedChat: SavedAnonymizedChat) {
  db.prepare('INSERT OR IGNORE INTO SavedAnonymizedChats (server_id, message_id, reference_content, message_content) VALUES (?, ?, ?, ?)')
    .run(anonymizedChat.server_id, anonymizedChat.message_id, anonymizedChat.reference_content, anonymizedChat.message_content);
}

// ==================== Memory ====================
// NOTE: names are case-insensitive, and only unique within a source
function getMemory(source_id: string, name: string): MemoryTable | undefined {
  return db.prepare('SELECT * FROM Memory WHERE source_id = ? AND name = ?').get(source_id, name) as MemoryTable | undefined;
}
function getMemoriesBySource(source_id: string): MemoryTable[] {
  return db.prepare('SELECT * FROM Memory WHERE source_id = ?').all(source_id) as MemoryTable[];
}
function upsertMemory(memory: MemoryTable): void {
  db.prepare(`
    INSERT INTO Memory (source_id, name, content)
    VALUES (?, ?, ?)
    ON CONFLICT(source_id, name) DO UPDATE SET
      content = excluded.content
  `).run(memory.source_id, memory.name, memory.content);
}
function deleteMemory(source_id: string, name: string): void {
  db.prepare('DELETE FROM Memory WHERE source_id = ? AND name = ?').run(source_id, name);
}

// ==================== Conversation ====================
function getConversation(conversation_id: string): ConversationTable | undefined {
  return db.prepare('SELECT * FROM Conversation WHERE conversation_id = ?').get(conversation_id) as ConversationTable | undefined;
}
function getConversationByChannel(channel_id: Snowflake): ConversationTable | undefined {
  // NOTE: Only returns an active conversation. Expired ones are waiting to be summarized
  return db.prepare('SELECT * FROM Conversation WHERE channel_id = ? AND expires_at > ? ORDER BY expires_at DESC LIMIT 1')
    .get(channel_id, Date.now()) as ConversationTable | undefined;
}
function getAllConversations(): ConversationTable[] {
  return db.prepare('SELECT * FROM Conversation').all() as ConversationTable[];
}
function getConversationsBySource(source_id: string): ConversationTable[] {
  return db.prepare('SELECT * FROM Conversation WHERE source_id = ?').all(source_id) as ConversationTable[];
}
function getExpiredConversations(now: number = Date.now()): ConversationTable[] {
  return db.prepare('SELECT * FROM Conversation WHERE expires_at <= ?').all(now) as ConversationTable[];
}
function upsertConversation(conversation: ConversationTable): void {
  db.prepare(`
    INSERT INTO Conversation (conversation_id, platform, channel_id, source_id, expires_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id) DO UPDATE SET
      platform = excluded.platform,
      channel_id = excluded.channel_id,
      source_id = excluded.source_id,
      expires_at = excluded.expires_at
  `).run(conversation.conversation_id, conversation.platform, conversation.channel_id ?? null, conversation.source_id ?? null, conversation.expires_at);
}
function deleteConversation(conversation_id: string): void {
  db.prepare('DELETE FROM Conversation WHERE conversation_id = ?').run(conversation_id);
}
// NOTE: cascades, so this also deletes every conversation's messages, summaries, tool results, and index
function deleteAllConversations(): void {
  db.prepare('DELETE FROM Conversation').run();
}

// ==================== ConversationMessage ====================
function getConversationMessages(conversation_id: string): ConversationMessageTable[] {
  // NOTE: Ordered by timestamp for prompt feeding
  return db.prepare('SELECT * FROM ConversationMessage WHERE conversation_id = ? ORDER BY timestamp ASC')
    .all(conversation_id) as ConversationMessageTable[];
}
function insertConversationMessage(message: ConversationMessageTable): void {
  db.prepare(`INSERT OR IGNORE INTO ConversationMessage
    (conversation_id, message_id, reference_id, token_count, author_name, author_id, role, message_content, timestamp)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
    .run(
      message.conversation_id,
      message.message_id,
      message.reference_id ?? null,
      message.token_count ?? null,
      message.author_name,
      message.author_id,
      message.role,
      message.message_content,
      message.timestamp,
    );
}
// NOTE: message ids are unique across a platform, so these two don't need the conversation
function isConversationMessage(message_id: string): boolean {
  return db.prepare('SELECT 1 FROM ConversationMessage WHERE message_id = ?').get(message_id) !== undefined;
}
// e.g. when a reply is switched to another version. does nothing if the message isn't saved
function updateConversationMessageContent(message_id: string, message_content: string, token_count: number): void {
  db.prepare('UPDATE ConversationMessage SET message_content = ?, token_count = ? WHERE message_id = ?').run(message_content, token_count, message_id);
}
function deleteConversationMessageByID(message_id: string): void {
  db.prepare('DELETE FROM ConversationMessage WHERE message_id = ?').run(message_id);
}
function deleteConversationMessage(conversation_id: string, message_id: string): void {
  db.prepare('DELETE FROM ConversationMessage WHERE conversation_id = ? AND message_id = ?').run(conversation_id, message_id);
}
function clearConversationMessages(conversation_id: string): void {
  db.prepare('DELETE FROM ConversationMessage WHERE conversation_id = ?').run(conversation_id);
}
// total size of the conversation's saved messages, as estimated when each was saved
function getConversationTokenCount(conversation_id: string): number {
  return (db.prepare('SELECT COALESCE(SUM(token_count), 0) AS total FROM ConversationMessage WHERE conversation_id = ?')
    .get(conversation_id) as { total: number }).total;
}

// ==================== ConversationSummary ====================
function toConversationSummary(row: any): ConversationSummaryTable {
  return {
    conversation_id: row.conversation_id,
    source_id: row.source_id,
    summary: row.summary,
    timestamp: row.timestamp,
    embedding: fromBlob(row.embedding),
  };
}
// NOTE: a conversation can have two summaries: its local one (`{server}#{channel}`), and the copy shared between servers (`main#{server}#{channel}`)
function getConversationSummary(conversation_id: string, source_id: string): ConversationSummaryTable | undefined {
  const summary = db.prepare('SELECT * FROM ConversationSummary WHERE conversation_id = ? AND source_id = ?').get(conversation_id, source_id);
  return summary ? toConversationSummary(summary) : undefined;
}
function getConversationSummaries(): ConversationSummaryTable[] {
  return db.prepare('SELECT * FROM ConversationSummary ORDER BY timestamp ASC').all().map(toConversationSummary);
}
/**
 * Every summary whose source_id is, or starts with, the given source. e.g.
 * `{server}` gets the server's local summaries, `main#{server}` its shared ones, and `main` every shared one
 */
function getConversationSummariesBySource(source_id: string): ConversationSummaryTable[] {
  // matches `{source_id}` exactly, or `{source_id}#...`. substr instead of LIKE, so '_' and '%' in post paths aren't wildcards
  return db.prepare(`
    SELECT * FROM ConversationSummary
    WHERE source_id = ? OR substr(source_id, 1, length(?) + 1) = ? || ?
    ORDER BY timestamp ASC
  `).all(source_id, source_id, source_id, SOURCE_SEPARATOR).map(toConversationSummary);
}
// the n most recent summaries from one summary source (`{server_id}#{channel_id}` on discord), in chronological order
function getLatestConversationSummaries(summarySource: string, n: number): ConversationSummaryTable[] {
  return db.prepare('SELECT * FROM ConversationSummary WHERE source_id = ? ORDER BY timestamp DESC LIMIT ?')
    .all(summarySource, n).map(toConversationSummary).reverse();
}
function upsertConversationSummary(summary: ConversationSummaryTable): void {
  db.prepare(`
    INSERT INTO ConversationSummary (conversation_id, source_id, summary, timestamp, embedding)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(conversation_id, source_id) DO UPDATE SET
      summary = excluded.summary,
      timestamp = excluded.timestamp,
      embedding = excluded.embedding
  `).run(summary.conversation_id, summary.source_id, summary.summary, summary.timestamp, toBlob(summary.embedding) ?? null);
}
function deleteConversationSummary(conversation_id: string, source_id: string): void {
  db.prepare('DELETE FROM ConversationSummary WHERE conversation_id = ? AND source_id = ?').run(conversation_id, source_id);
}

// ==================== ConversationToolResult ====================
function getConversationToolResults(conversation_id: string): ConversationToolResultTable[] {
  // NOTE: Ordered by timestamp for prompt feeding
  // NOTE: every result, including discarded ones. what the model and summaries see goes through getVisibleToolResults
  return (db.prepare('SELECT * FROM ConversationToolResult WHERE conversation_id = ? ORDER BY timestamp ASC, rowid ASC')
    .all(conversation_id) as ConversationToolResultTable[])
    .map((result) => ({ ...result, dirty: Boolean(result.dirty), discarded: result.discarded ?? undefined }));
}
function insertConversationToolResult(toolResult: ConversationToolResultTable): void {
  db.prepare('INSERT OR IGNORE INTO ConversationToolResult (conversation_id, tool_name, tool_call_id, timestamp, output, dirty, discarded) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(toolResult.conversation_id, toolResult.tool_name, toolResult.tool_call_id, toolResult.timestamp, toolResult.output, toolResult.dirty ? 1 : 0, toolResult.discarded ?? null);
}
// marks results as no longer part of the reply on screen, or (with undefined) as part of it again
function setToolResultsDiscarded(tool_call_ids: string[], discarded: ToolResultDiscard | undefined): void {
  const update = db.prepare('UPDATE ConversationToolResult SET discarded = ? WHERE tool_call_id = ?');
  db.transaction(() => tool_call_ids.forEach((id) => update.run(discarded ?? null, id)))();
}
function clearConversationToolResults(conversation_id: string): void {
  db.prepare('DELETE FROM ConversationToolResult WHERE conversation_id = ?').run(conversation_id);
}

// ==================== Index ====================
// next unused reference number in a conversation's index. Reads the number out of each shorthand, so '[@3]', '@3', and '3' all count as 3
function getNextRef(table: 'IndexUser' | 'IndexMessage' | 'IndexChannel' | 'IndexRole', conversation_id: string): number {
  const refs = db.prepare(`SELECT shorthand FROM ${table} WHERE conversation_id = ?`).all(conversation_id) as { shorthand: string }[];

  // highest + 1, rather than the row count, so a deleted row's number never gets handed out twice
  return refs.reduce((next, ref) => {
    const refNumber = Number(ref.shorthand.match(/\d+/)?.[0] ?? -1);
    return refNumber >= next ? refNumber + 1 : next;
  }, 1); // starts from 1. 0 is reserved for referenced messages
}

// ==================== IndexUser ====================
function getNextUserRef(conversation_id: string): number {
  return getNextRef('IndexUser', conversation_id);
}
function getIndexUser(conversation_id: string, user_id: string): IndexUserTable | undefined {
  return db.prepare('SELECT * FROM IndexUser WHERE conversation_id = ? AND user_id = ?')
    .get(conversation_id, user_id) as IndexUserTable | undefined;
}
function getIndexUsers(conversation_id: string): IndexUserTable[] {
  return db.prepare('SELECT * FROM IndexUser WHERE conversation_id = ?').all(conversation_id) as IndexUserTable[];
}
function insertIndexUser(indexUser: IndexUserTable): void {
  db.prepare('INSERT OR IGNORE INTO IndexUser (conversation_id, user_id, shorthand) VALUES (?, ?, ?)')
    .run(indexUser.conversation_id, indexUser.user_id, indexUser.shorthand);
}
// resolves a user's shorthand (as given to the chatbot) back to its user id
function resolveUserRef(conversation_id: string, user_ref: string): string | undefined {
  const indexUser = db.prepare('SELECT user_id FROM IndexUser WHERE conversation_id = ? AND shorthand = ?')
    .get(conversation_id, user_ref) as { user_id: string } | undefined;
  return indexUser?.user_id;
}
function deleteIndexUser(conversation_id: string, user_id: string): void {
  db.prepare('DELETE FROM IndexUser WHERE conversation_id = ? AND user_id = ?').run(conversation_id, user_id);
}

// ==================== IndexMessage ====================
function getNextMessageRef(conversation_id: string): number {
  return getNextRef('IndexMessage', conversation_id);
}
function getIndexMessage(conversation_id: string, message_id: string): IndexMessageTable | undefined {
  return db.prepare('SELECT * FROM IndexMessage WHERE conversation_id = ? AND message_id = ?')
    .get(conversation_id, message_id) as IndexMessageTable | undefined;
}
function getIndexMessages(conversation_id: string): IndexMessageTable[] {
  return db.prepare('SELECT * FROM IndexMessage WHERE conversation_id = ?').all(conversation_id) as IndexMessageTable[];
}
function insertIndexMessage(indexMessage: IndexMessageTable): void {
  db.prepare('INSERT OR IGNORE INTO IndexMessage (conversation_id, message_id, shorthand) VALUES (?, ?, ?)')
    .run(indexMessage.conversation_id, indexMessage.message_id, indexMessage.shorthand);
}
// resolves a message's shorthand (as given to the chatbot) back to its message id
function resolveMessageRef(conversation_id: string, message_ref: string): string | undefined {
  const indexMessage = db.prepare('SELECT message_id FROM IndexMessage WHERE conversation_id = ? AND shorthand = ?')
    .get(conversation_id, message_ref) as { message_id: string } | undefined;
  return indexMessage?.message_id;
}
function deleteIndexMessage(conversation_id: string, message_id: string): void {
  db.prepare('DELETE FROM IndexMessage WHERE conversation_id = ? AND message_id = ?').run(conversation_id, message_id);
}

// ==================== IndexChannel ====================
function getNextChannelRef(conversation_id: string): number {
  return getNextRef('IndexChannel', conversation_id);
}
function getIndexChannel(conversation_id: string, channel_id: string): IndexChannelTable | undefined {
  return db.prepare('SELECT * FROM IndexChannel WHERE conversation_id = ? AND channel_id = ?')
    .get(conversation_id, channel_id) as IndexChannelTable | undefined;
}
function getIndexChannels(conversation_id: string): IndexChannelTable[] {
  return db.prepare('SELECT * FROM IndexChannel WHERE conversation_id = ?').all(conversation_id) as IndexChannelTable[];
}
function insertIndexChannel(indexChannel: IndexChannelTable): void {
  db.prepare('INSERT OR IGNORE INTO IndexChannel (conversation_id, channel_id, shorthand) VALUES (?, ?, ?)')
    .run(indexChannel.conversation_id, indexChannel.channel_id, indexChannel.shorthand);
}
// resolves a channel's shorthand (as given to the chatbot) back to its channel id
function resolveChannelRef(conversation_id: string, channel_ref: string): string | undefined {
  // [#0] is reserved for the channel the conversation takes place in, which isn't stored in the index
  if (channel_ref === '[#0]') return getConversation(conversation_id)?.channel_id ?? undefined;

  const indexChannel = db.prepare('SELECT channel_id FROM IndexChannel WHERE conversation_id = ? AND shorthand = ?')
    .get(conversation_id, channel_ref) as { channel_id: string } | undefined;
  return indexChannel?.channel_id;
}
function deleteIndexChannel(conversation_id: string, channel_id: string): void {
  db.prepare('DELETE FROM IndexChannel WHERE conversation_id = ? AND channel_id = ?').run(conversation_id, channel_id);
}

// ==================== IndexRole ====================
function getNextRoleRef(conversation_id: string): number {
  return getNextRef('IndexRole', conversation_id);
}
function getIndexRole(conversation_id: string, role_id: string): IndexRoleTable | undefined {
  return db.prepare('SELECT * FROM IndexRole WHERE conversation_id = ? AND role_id = ?')
    .get(conversation_id, role_id) as IndexRoleTable | undefined;
}
function getIndexRoles(conversation_id: string): IndexRoleTable[] {
  return db.prepare('SELECT * FROM IndexRole WHERE conversation_id = ?').all(conversation_id) as IndexRoleTable[];
}
function insertIndexRole(indexRole: IndexRoleTable): void {
  db.prepare('INSERT OR IGNORE INTO IndexRole (conversation_id, role_id, shorthand) VALUES (?, ?, ?)')
    .run(indexRole.conversation_id, indexRole.role_id, indexRole.shorthand);
}
// resolves a role's shorthand (as given to the chatbot) back to its role id
function resolveRoleRef(conversation_id: string, role_ref: string): string | undefined {
  const indexRole = db.prepare('SELECT role_id FROM IndexRole WHERE conversation_id = ? AND shorthand = ?')
    .get(conversation_id, role_ref) as { role_id: string } | undefined;
  return indexRole?.role_id;
}
function deleteIndexRole(conversation_id: string, role_id: string): void {
  db.prepare('DELETE FROM IndexRole WHERE conversation_id = ? AND role_id = ?').run(conversation_id, role_id);
}

// ==================== HeartBoard ====================
function getHeartBoard(server_id: Snowflake, board_name: string): HeartBoardTable | undefined {
  return db.prepare('SELECT * FROM HeartBoard WHERE server_id = ? AND board_name = ?')
    .get(server_id, board_name) as HeartBoardTable | undefined;
}
function getHeartBoardsByServer(server_id: Snowflake): HeartBoardTable[] {
  return db.prepare('SELECT * FROM HeartBoard WHERE server_id = ?').all(server_id) as HeartBoardTable[];
}
function getHeartBoardsByEmoji(server_id: Snowflake, emoji: string): HeartBoardTable[] {
  return db.prepare(`
    SELECT HeartBoard.* FROM HeartBoard
    JOIN HeartBoardEmoji ON HeartBoard.server_id = HeartBoardEmoji.server_id
                        AND HeartBoard.board_name = HeartBoardEmoji.board_name
    WHERE HeartBoard.server_id = ? AND HeartBoardEmoji.emoji = ?
  `).all(server_id, emoji) as HeartBoardTable[];
}
function insertHeartBoard(board: HeartBoardTable): void {
  db.prepare('INSERT INTO HeartBoard (server_id, board_name, enabled, deny_author, threshold, output_channel) VALUES (?, ?, ?, ?, ?, ?)')
    .run(board.server_id, board.board_name, board.enabled ? 1 : 0, board.deny_author ? 1 : 0, board.threshold, board.output_channel);
}
function updateHeartBoard(board: HeartBoardTable): void {
  db.prepare(`UPDATE HeartBoard SET enabled = ?, deny_author = ?, threshold = ?, output_channel = ?
    WHERE server_id = ? AND board_name = ?`)
    .run(board.enabled ? 1 : 0, board.deny_author ? 1 : 0, board.threshold, board.output_channel, board.server_id, board.board_name);
}
function deleteHeartBoard(server_id: Snowflake, board_name: string): void {
  db.prepare('DELETE FROM HeartBoard WHERE server_id = ? AND board_name = ?').run(server_id, board_name);
}

// ==================== HeartBoardEmoji ====================
function getHeartBoardEmojis(server_id: Snowflake, board_name: string): HeartBoardEmojiTable[] {
  return db.prepare('SELECT * FROM HeartBoardEmoji WHERE server_id = ? AND board_name = ?')
    .all(server_id, board_name) as HeartBoardEmojiTable[];
}
function insertHeartBoardEmoji(emoji: HeartBoardEmojiTable): void {
  db.prepare('INSERT OR IGNORE INTO HeartBoardEmoji (server_id, board_name, emoji) VALUES (?, ?, ?)')
    .run(emoji.server_id, emoji.board_name, emoji.emoji);
}
function deleteHeartBoardEmoji(server_id: Snowflake, board_name: string, emoji: string): void {
  db.prepare('DELETE FROM HeartBoardEmoji WHERE server_id = ? AND board_name = ? AND emoji = ?')
    .run(server_id, board_name, emoji);
}
function deleteAllHeartBoardEmojis(server_id: Snowflake, board_name: string): void {
  db.prepare('DELETE FROM HeartBoardEmoji WHERE server_id = ? AND board_name = ?').run(server_id, board_name);
}

// ==================== HeartBoardMessage ====================
function getHeartBoardMessage(server_id: Snowflake, board_name: string, message_id: Snowflake): HeartBoardMessageTable | undefined {
  return db.prepare('SELECT * FROM HeartBoardMessage WHERE server_id = ? AND board_name = ? AND message_id = ?')
    .get(server_id, board_name, message_id) as HeartBoardMessageTable | undefined;
}
function getHeartBoardMessagesByServer(server_id: Snowflake): HeartBoardMessageTable[] {
  return db.prepare('SELECT * FROM HeartBoardMessage WHERE server_id = ?').all(server_id) as HeartBoardMessageTable[];
}
function getEmbedMessagesByBoard(server_id: Snowflake, board_name: string): string[] {
  return db.prepare('SELECT embed_id FROM HeartBoardMessage WHERE server_id = ? AND board_name = ?')
    .all(server_id, board_name) as string[];
}
function insertHeartBoardMessage(msg: HeartBoardMessageTable): void {
  db.prepare('INSERT OR IGNORE INTO HeartBoardMessage (server_id, board_name, message_id, total_emojis, channel_id, embed_id) VALUES (?, ?, ?, ?, ?, ?)')
    .run(msg.server_id, msg.board_name, msg.message_id, msg.total_emojis, msg.channel_id, msg.embed_id);
}
function updateHeartBoardMessage(msg: HeartBoardMessageTable): void {
  db.prepare('UPDATE HeartBoardMessage SET total_emojis = ? WHERE server_id = ? AND board_name = ? AND message_id = ?')
    .run(msg.total_emojis, msg.server_id, msg.board_name, msg.message_id);
}
function deleteHeartBoardMessage(server_id: Snowflake, board_name: string, message_id: Snowflake): void {
  db.prepare('DELETE FROM HeartBoardMessage WHERE server_id = ? AND board_name = ? AND message_id = ?')
    .run(server_id, board_name, message_id);
}
function isEmbedMessage(message_id: Snowflake): boolean {
  const row = db.prepare('SELECT 1 FROM HeartBoardMessage WHERE embed_id = ?')
    .get(message_id);
  return row !== undefined;
}

// ==================== VoicePing ====================
function getVoicePing(server_id: Snowflake, voiceping_name: string): VoicePingTable | undefined {
  return db.prepare('SELECT * FROM VoicePing WHERE server_id = ? AND voiceping_name = ?')
    .get(server_id, voiceping_name) as VoicePingTable | undefined;
}
function getVoicePingsByServer(server_id: Snowflake): VoicePingTable[] {
  return db.prepare('SELECT * FROM VoicePing WHERE server_id = ?').all(server_id) as VoicePingTable[];
}
function insertVoicePing(ping: VoicePingTable): void {
  db.prepare('INSERT INTO VoicePing (server_id, voiceping_name, enabled, message_template, output_channel) VALUES (?, ?, ?, ?, ?)')
    .run(ping.server_id, ping.voiceping_name, ping.enabled ? 1 : 0, ping.message_template, ping.output_channel);
}
function updateVoicePing(ping: VoicePingTable): void {
  db.prepare('UPDATE VoicePing SET message_template = ?, enabled = ?, output_channel = ? WHERE server_id = ? AND voiceping_name = ?')
    .run(ping.message_template, ping.enabled ? 1 : 0, ping.output_channel, ping.server_id, ping.voiceping_name);
}
function deleteVoicePing(server_id: Snowflake, voiceping_name: string): void {
  db.prepare('DELETE FROM VoicePing WHERE server_id = ? AND voiceping_name = ?').run(server_id, voiceping_name);
}

// ==================== VoicePingInput ====================
function getVoicePingInputs(server_id: Snowflake, voiceping_name: string): VoicePingInputTable[] {
  return db.prepare('SELECT * FROM VoicePingInput WHERE server_id = ? AND voiceping_name = ?')
    .all(server_id, voiceping_name) as VoicePingInputTable[];
}
function insertVoicePingInput(input: VoicePingInputTable): void {
  db.prepare('INSERT OR IGNORE INTO VoicePingInput (server_id, voiceping_name, channel_id) VALUES (?, ?, ?)')
    .run(input.server_id, input.voiceping_name, input.channel_id);
}
function deleteAllVoicePingInputs(server_id: Snowflake, voiceping_name: string): void {
  db.prepare('DELETE FROM VoicePingInput WHERE server_id = ? AND voiceping_name = ?')
    .run(server_id, voiceping_name);
}
function deleteVoicePingInput(server_id: Snowflake, voiceping_name: string, channel_id: Snowflake): void {
  db.prepare('DELETE FROM VoicePingInput WHERE server_id = ? AND voiceping_name = ? AND channel_id = ?')
    .run(server_id, voiceping_name, channel_id);
}

// ==================== AutomaticResponse ====================
function getAutomaticResponse(server_id: Snowflake, name: string): AutomaticResponseTable | undefined {
  return db.prepare('SELECT * FROM AutomaticResponse WHERE server_id = ? AND name = ?')
    .get(server_id, name) as AutomaticResponseTable | undefined;
}
function getAutomaticResponsesByServer(server_id: Snowflake): AutomaticResponseTable[] {
  return db.prepare('SELECT * FROM AutomaticResponse WHERE server_id = ?').all(server_id) as AutomaticResponseTable[];
}
function insertAutomaticResponse(response: AutomaticResponseTable): void {
  db.prepare('INSERT OR IGNORE INTO AutomaticResponse (server_id, name, enabled, activation_regex, capture_regex, output_template) VALUES (?, ?, ?, ?, ?, ?)')
    .run(response.server_id, response.name, response.enabled ? 1 : 0, response.activation_regex, response.capture_regex, response.output_template);
}
function updateAutomaticResponse(response: AutomaticResponseTable): void {
  db.prepare('UPDATE AutomaticResponse SET enabled = ?, activation_regex = ?, capture_regex = ?, output_template = ? WHERE server_id = ? AND name = ?')
    .run(response.enabled ? 1 : 0, response.activation_regex, response.capture_regex, response.output_template, response.server_id, response.name);
}
function deleteAutomaticResponse(server_id: Snowflake, name: string): void {
  db.prepare('DELETE FROM AutomaticResponse WHERE server_id = ? AND name = ?').run(server_id, name);
}
function addResponseMessage(server_id: Snowflake, message_id: Snowflake): void {
  db.prepare('INSERT INTO ResponseMessage (server_id, message_id) VALUES (?, ?)').run(server_id, message_id);
}
function isResponseMessage(server_id: Snowflake, message_id: Snowflake): boolean {
  return db.prepare('SELECT 1 FROM ResponseMessage WHERE server_id = ? AND message_id = ?').get(server_id, message_id) !== undefined;
}
function deleteResponseMessage(server_id: Snowflake, message_id: Snowflake): void {
  db.prepare('DELETE FROM ResponseMessage WHERE server_id = ? AND message_id = ?').run(server_id, message_id);
}

// ==================== Counter ====================
// NOTE: counter names are case-insensitive
function getCounter(server_id: Snowflake, counter_name: string): CounterTable | undefined {
  return db.prepare('SELECT * FROM Counter WHERE server_id = ? AND counter_name = ?').get(server_id, counter_name) as CounterTable | undefined;
}
function getCountersByServer(server_id: Snowflake): CounterTable[] {
  return db.prepare('SELECT * FROM Counter WHERE server_id = ? ORDER BY counter_name ASC').all(server_id) as CounterTable[];
}
function insertCounter(counter: CounterTable): void {
  db.prepare('INSERT INTO Counter (server_id, counter_name, value) VALUES (?, ?, ?)').run(counter.server_id, counter.counter_name, counter.value);
}
function setCounterValue(server_id: Snowflake, counter_name: string, value: number): void {
  db.prepare('UPDATE Counter SET value = ? WHERE server_id = ? AND counter_name = ?').run(value, server_id, counter_name);
}
// adds in a single statement, so simultaneous uses can't overwrite each other. Returns the new value, or undefined if there's no counter
function incrementCounter(server_id: Snowflake, counter_name: string, amount: number): number | undefined {
  const row = db.prepare('UPDATE Counter SET value = value + ? WHERE server_id = ? AND counter_name = ? RETURNING value')
    .get(amount, server_id, counter_name) as { value: number } | undefined;
  return row?.value;
}
function deleteCounter(server_id: Snowflake, counter_name: string): void {
  db.prepare('DELETE FROM Counter WHERE server_id = ? AND counter_name = ?').run(server_id, counter_name);
}

// ==================== Reminder ====================
function getReminder(server_id: Snowflake, reminder_name: string): ReminderTable {
  return db.prepare('SELECT * FROM Reminder WHERE server_id = ? AND reminder_name = ?').get(server_id, reminder_name) as ReminderTable;
}
function getRemindersByServer(server_id: Snowflake): ReminderTable[] {
  return db.prepare('SELECT * FROM Reminder WHERE server_id = ?').all(server_id) as ReminderTable[];
}
function addReminder(reminder: ReminderTable): void {
  db.prepare('INSERT INTO Reminder (server_id, channel_id, reminder_name, repeats, cron_schedule, message_content) VALUES (?, ?, ?, ?, ?, ?)')
    .run(reminder.server_id, reminder.channel_id, reminder.reminder_name, reminder.repeats ? 1 : 0, reminder.cron_schedule, reminder.message_content);
}
function updateReminder(reminder: ReminderTable): void {
  db.prepare('UPDATE Reminder SET channel_id = ?, repeats = ?, cron_schedule = ?, message_content = ? WHERE server_id = ? AND reminder_name = ?')
    .run(reminder.channel_id, reminder.repeats ? 1 : 0, reminder.cron_schedule, reminder.message_content, reminder.server_id, reminder.reminder_name);
}
function deleteReminder(reminder: ReminderTable) {
  // find task with name and delete it
  const tasks = cron.getTasks();
  tasks.forEach((task) => {
    if (task.name === `${reminder.server_id}${reminder.reminder_name}`) {
      task.destroy();
    }
  });

  db.prepare('DELETE FROM Reminder WHERE server_id = ? AND reminder_name = ?').run(reminder.server_id, reminder.reminder_name);
}

// ==================== Heartbeat ====================
function getHeartbeat(server_id: Snowflake, heartbeat_name: string): HeartbeatTable | undefined {
  return db.prepare('SELECT * FROM Heartbeat WHERE server_id = ? AND heartbeat_name = ?').get(server_id, heartbeat_name) as HeartbeatTable | undefined;
}
function getHeartbeatsByServer(server_id: Snowflake): HeartbeatTable[] {
  return db.prepare('SELECT * FROM Heartbeat WHERE server_id = ?').all(server_id) as HeartbeatTable[];
}
function insertHeartbeat(heartbeat: HeartbeatTable): void {
  db.prepare('INSERT INTO Heartbeat (server_id, heartbeat_name, channel_id, created_by, repeats, silent, cron_schedule, prompt, context) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
    .run(heartbeat.server_id, heartbeat.heartbeat_name, heartbeat.channel_id, heartbeat.created_by, heartbeat.repeats ? 1 : 0, heartbeat.silent ? 1 : 0, heartbeat.cron_schedule, heartbeat.prompt, heartbeat.context ?? null);
}
function updateHeartbeat(heartbeat: HeartbeatTable): void {
  db.prepare('UPDATE Heartbeat SET channel_id = ?, repeats = ?, silent = ?, cron_schedule = ?, prompt = ?, context = ? WHERE server_id = ? AND heartbeat_name = ?')
    .run(heartbeat.channel_id, heartbeat.repeats ? 1 : 0, heartbeat.silent ? 1 : 0, heartbeat.cron_schedule, heartbeat.prompt, heartbeat.context ?? null, heartbeat.server_id, heartbeat.heartbeat_name);
}
// only the row. removeHeartbeat in chatbot/heartbeat.ts also stops its cron task
function deleteHeartbeat(server_id: Snowflake, heartbeat_name: string): void {
  db.prepare('DELETE FROM Heartbeat WHERE server_id = ? AND heartbeat_name = ?').run(server_id, heartbeat_name);
}

// ==================== Server ====================
function getServer(server_id: Snowflake): ServerTable | undefined {
  return db.prepare('SELECT * FROM Server WHERE server_id = ?').get(server_id) as ServerTable | undefined;
}
function insertServer(server_id: Snowflake): void {
  db.prepare('INSERT OR IGNORE INTO Server (server_id) VALUES (?)').run(server_id);
}
// a DM with the bot, as a server of its own, keyed by its owner's user id
function insertDMServer(user_id: Snowflake): void {
  db.prepare('INSERT INTO Server (server_id, dm_user_id) VALUES (?, ?) ON CONFLICT(server_id) DO UPDATE SET dm_user_id = excluded.dm_user_id').run(user_id, user_id);
}
function getDMServers(): ServerTable[] {
  return db.prepare('SELECT * FROM Server WHERE dm_user_id IS NOT NULL').all() as ServerTable[];
}
function deleteServer(server_id: Snowflake): void {
  db.prepare('DELETE FROM Server WHERE server_id = ?').run(server_id);
}

// for migrations that add columns, since a fresh database already has them from schema.sql
function hasColumn(table: string, column: string): boolean {
  return (db.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[]).some((info) => info.name === column);
}
// for old migrations on tables that newer databases no longer have
function hasTable(table: string): boolean {
  return db.prepare('SELECT 1 FROM sqlite_master WHERE type = \'table\' AND name = ?').get(table) !== undefined;
}

const updateDatabase = db.transaction(() => {
  const currentVersion = (db.pragma('user_version', { simple: true }) as number);
  if (!currentVersion || currentVersion < 0) {
    const configData: ConfigData = JSON.parse(readFileSync(configPath, { encoding: 'utf-8' }));
    const data: ServerData[] = JSON.parse(readFileSync(dataPath, { encoding: 'utf-8' })).servers;
    configData.servers.forEach((server) => {
      const serverID = server.id;
      insertServer(serverID);

      const serverConfig: ServerConfig = configData.servers.filter((cd) => cd.id === serverID)[0];
      const serverData: ServerData = data.filter((d) => d.id === serverID)[0];

      if (!serverConfig || !serverData) return;

      serverConfig.serverResponses.forEach((response) => {
        const existingServerResponse = getAutomaticResponse(serverID, response.name);
        if (existingServerResponse) return;

        insertAutomaticResponse({
          server_id: serverID,
          name: response.name,
          enabled: response.enabled,
          activation_regex: response.activationRegex,
          capture_regex: response.captureRegex ?? '*',
          output_template: response.outputTemplateString,
        });
      });

      const existingDefaultHeartboard = getHeartBoard(serverID, 'legacy-heartboard');
      if (!existingDefaultHeartboard) {
        const board = serverConfig.heartBoard;

        insertHeartBoard({
          server_id: serverID,
          board_name: 'legacy-heartboard',
          enabled: board.enabled,
          deny_author: board.denyAuthor,
          threshold: board.thresholdNumber,
          output_channel: board.outputChannel,
        });

        board.emojis.forEach((emoji) => {
          insertHeartBoardEmoji({
            server_id: serverID,
            board_name: 'legacy-heartboard',
            emoji,
          });
        });

        serverData.heartBoardMessages.forEach((hbm) => insertHeartBoardMessage({
          server_id: serverID,
          board_name: 'legacy-heartboard',
          channel_id: hbm.channelID,
          embed_id: hbm.embedMessageID,
          message_id: hbm.messageID,
          total_emojis: -1,
        }));
      }

      const existingDefaultVoiceping = getVoicePing(serverID, 'legacy-voiceping');
      if (!existingDefaultVoiceping) {
        const ping = serverConfig.voicePing;

        insertVoicePing({
          server_id: serverID,
          voiceping_name: 'legacy-voiceping',
          enabled: ping.enabled,
          message_template: ping.voicePingMessage,
          output_channel: ping.outputChannel,
        });

        ping.inputChannels.forEach((inputChannel) => insertVoicePingInput({
          server_id: serverID,
          voiceping_name: 'legacy-voiceping',
          channel_id: inputChannel,
        }));
      }

      // chatbot's data can be deleted. it's not as important as other data
      db.pragma('user_version = 1');
    });
  }
  if (currentVersion < 2) {
    db.prepare('ALTER TABLE Chatbot ADD COLUMN chatbot_prompt TEXT').run();
    db.prepare('DROP TABLE IF EXISTS ChatbotShortTermMemory').run(); // IF EXISTS, since the old memory tables were later removed entirely
    db.exec(schema);

    const servers = getAllServers();

    // add default prompt for all server chatbots
    getDefaultSystemPrompt().then((defaultPrompt) => {
      if (!servers) return;

      servers.forEach((serverID) => {
        const chatbot = getChatbot(serverID);
        if (chatbot && (!chatbot.chatbot_prompt || chatbot.chatbot_prompt === '')) {
          setChatbotPrompt(serverID, defaultPrompt);
        }
      });
    });

    db.pragma('user_version = 2');
  }
  if (currentVersion < 3) {
    db.prepare('ALTER TABLE Chatbot ADD COLUMN tools_enabled BOOLEAN').run();
    db.prepare('UPDATE Chatbot SET tools_enabled = 0').run();

    db.pragma('user_version = 3');
  }
  if (currentVersion < 4) {
    if (hasTable('ChatbotShortTermMemory')) db.prepare('ALTER TABLE ChatbotShortTermMemory ADD COLUMN embedding BLOB').run(); // gone in newer databases
    db.pragma('user_version = 4');
  }
  if (currentVersion < 5) {
    // columns are checked first, since a fresh database already has them from schema.sql
    if (!hasColumn('Chatbot', 'detached')) {
      db.prepare('ALTER TABLE Chatbot ADD COLUMN detached BOOLEAN').run();
      db.prepare('UPDATE Chatbot SET detached = 0').run();
    }
    if (!hasColumn('Chatbot', 'system_prompt_override')) {
      db.prepare('ALTER TABLE Chatbot ADD COLUMN system_prompt_override TEXT').run();
    }
    if (!hasColumn('ChatbotSubscriber', 'cross_server')) {
      db.prepare('ALTER TABLE ChatbotSubscriber ADD COLUMN cross_server BOOLEAN').run();
      db.prepare('UPDATE ChatbotSubscriber SET cross_server = 0').run();
    }

    // summaries are now keyed by (conversation_id, source_id), so a conversation can have a local and a shared copy.
    // sqlite can't change a primary key, so rebuild the table. existing summaries become local ones
    const summaryKeyColumns = (db.prepare('PRAGMA table_info(ConversationSummary)').all() as { pk: number }[]).filter((info) => info.pk > 0).length;
    if (summaryKeyColumns < 2) {
      db.exec(`
        CREATE TABLE ConversationSummary_new(
          conversation_id VARCHAR(50) NOT NULL REFERENCES Conversation(conversation_id) ON DELETE CASCADE,
          source_id VARCHAR(100) NOT NULL,
          summary TEXT,
          timestamp INTEGER,
          embedding BLOB,

          PRIMARY KEY (conversation_id, source_id)
        );
        INSERT INTO ConversationSummary_new (conversation_id, source_id, summary, timestamp, embedding)
          SELECT cs.conversation_id, c.source_id || COALESCE('${SOURCE_SEPARATOR}' || c.channel_id, ''), cs.summary, cs.timestamp, cs.embedding
          FROM ConversationSummary cs JOIN Conversation c ON c.conversation_id = cs.conversation_id
          WHERE c.source_id IS NOT NULL;
        DROP TABLE ConversationSummary;
        ALTER TABLE ConversationSummary_new RENAME TO ConversationSummary;
      `);
    }

    // personas used to start as a copy of SYSTEM.md, which is now its own layer. clear those copies, so it isn't given twice
    const basePrompt = getBaseSystemPrompt().trim();
    if (basePrompt) {
      db.prepare('UPDATE Chatbot SET chatbot_prompt = \'\' WHERE trim(chatbot_prompt) = ?').run(basePrompt);
    }

    db.pragma('user_version = 5');
  }
  if (currentVersion < 6) {
    if (!hasColumn('Chatbot', 'model')) {
      db.prepare('ALTER TABLE Chatbot ADD COLUMN model TEXT').run(); // empty, so every server keeps the default model
    }
    if (!hasColumn('Chatbot', 'reasoning_effort')) {
      db.prepare('ALTER TABLE Chatbot ADD COLUMN reasoning_effort TEXT').run(); // same, for the default effort
    }
    db.pragma('user_version = 6');
  }
  if (currentVersion < 7) {
    // the old long-term, short-term, and core memory system, replaced by conversations, summaries, and memories
    db.prepare('DROP TABLE IF EXISTS ChatbotLongTermMemory').run();
    db.prepare('DROP TABLE IF EXISTS ChatbotShortTermMemory').run();
    if (hasColumn('Chatbot', 'chatbot_core_memory')) db.prepare('ALTER TABLE Chatbot DROP COLUMN chatbot_core_memory').run();
    db.pragma('user_version = 7');
  }
  if (currentVersion < 8) {
    // Heartbeat was briefly created without it
    if (!hasColumn('Heartbeat', 'context')) db.prepare('ALTER TABLE Heartbeat ADD COLUMN context TEXT').run();
    db.pragma('user_version = 8');
  }
  if (currentVersion < 9) {
    if (!hasColumn('Heartbeat', 'silent')) db.prepare('ALTER TABLE Heartbeat ADD COLUMN silent BOOLEAN').run(); // empty, so every existing heartbeat keeps posting
    db.pragma('user_version = 9');
  }
  if (currentVersion < 10) {
    if (!hasColumn('Chatbot', 'temperature')) db.prepare('ALTER TABLE Chatbot ADD COLUMN temperature REAL').run(); // empty, so every server keeps the default temperature
    db.pragma('user_version = 10');
  }
  if (currentVersion < 11) {
    // empty, so every existing result counts as it always has: not dirty, and not discarded
    if (!hasColumn('ConversationToolResult', 'dirty')) db.prepare('ALTER TABLE ConversationToolResult ADD COLUMN dirty BOOLEAN').run();
    if (!hasColumn('ConversationToolResult', 'discarded')) db.prepare('ALTER TABLE ConversationToolResult ADD COLUMN discarded TEXT').run();
    db.pragma('user_version = 11');
  }
  if (currentVersion < 12) {
    // the minimum quantization setting was taken out. which providers are used is left to the openrouter key's own settings
    if (hasColumn('Chatbot', 'min_quantization')) db.prepare('ALTER TABLE Chatbot DROP COLUMN min_quantization').run();
    db.pragma('user_version = 12');
  }
  if (currentVersion < 13) {
    if (!hasColumn('Server', 'dm_user_id')) db.prepare('ALTER TABLE Server ADD COLUMN dm_user_id VARCHAR(20)').run(); // empty, so every existing server stays a server
    db.pragma('user_version = 13');
  }
});

export {
  db, updateDatabase,
  getAllServers, getServer, insertServer, insertDMServer, getDMServers, deleteServer,
  getReminder, getRemindersByServer, addReminder, updateReminder, deleteReminder,
  getHeartbeat, getHeartbeatsByServer, insertHeartbeat, updateHeartbeat, deleteHeartbeat,
  getCounter, getCountersByServer, insertCounter, setCounterValue, incrementCounter, deleteCounter,
  getChatbot, getAttachedServers, upsertChatbot, deleteChatbot, setChatbotPrompt,
  isChatbotSubscriber, addChatbotSubscriber, getChatbotSubscriber, setChatbotSubscriberCrossServer, getCrossServerSubscribers, getSubscribersAmong, removeChatbotSubscriber,
  getHeartBoard, getHeartBoardsByServer, getHeartBoardsByEmoji, insertHeartBoard, updateHeartBoard, deleteHeartBoard,
  getHeartBoardEmojis, insertHeartBoardEmoji, deleteHeartBoardEmoji, deleteAllHeartBoardEmojis,
  getHeartBoardMessage, getHeartBoardMessagesByServer, getEmbedMessagesByBoard, insertHeartBoardMessage, updateHeartBoardMessage, deleteHeartBoardMessage, isEmbedMessage,
  getVoicePing, getVoicePingsByServer, insertVoicePing, updateVoicePing, deleteVoicePing,
  getVoicePingInputs, insertVoicePingInput, deleteAllVoicePingInputs, deleteVoicePingInput,
  saveAnonymizedMessage,
  getConversation, getAllConversations, getConversationsBySource, getConversationByChannel, getExpiredConversations, upsertConversation, deleteConversation, deleteAllConversations,
  getConversationMessages, insertConversationMessage, isConversationMessage, updateConversationMessageContent, deleteConversationMessageByID, deleteConversationMessage, clearConversationMessages, getConversationTokenCount,
  getMemory, getMemoriesBySource, upsertMemory, deleteMemory,
  getConversationSummary, getConversationSummaries, getConversationSummariesBySource, getLatestConversationSummaries, upsertConversationSummary, deleteConversationSummary,
  getNextUserRef, getIndexUser, getIndexUsers, insertIndexUser, resolveUserRef, deleteIndexUser,
  getConversationToolResults, insertConversationToolResult, setToolResultsDiscarded, clearConversationToolResults,
  getNextMessageRef, getIndexMessage, getIndexMessages, insertIndexMessage, resolveMessageRef, deleteIndexMessage,
  getNextChannelRef, getIndexChannel, getIndexChannels, insertIndexChannel, resolveChannelRef, deleteIndexChannel,
  getNextRoleRef, getIndexRole, getIndexRoles, insertIndexRole, resolveRoleRef, deleteIndexRole,
  getAutomaticResponse, getAutomaticResponsesByServer, insertAutomaticResponse, updateAutomaticResponse, deleteAutomaticResponse, addResponseMessage, isResponseMessage, deleteResponseMessage,
};
