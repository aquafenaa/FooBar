import path from 'node:path';
import { Snowflake } from 'discord.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

import { AutomaticResponseTable, ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable, ChatbotTable, HeartBoardEmojiTable, HeartBoardMessageTable, HeartBoardTable, ServerTable, VoicePingInputTable, VoicePingTable } from './types/schema';
import { ConfigData, ServerConfig, ServerData } from './types/bot';

const schemaPath = path.join(__dirname, '../data/seed/schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');

const dataPath = path.join(__dirname, '../data/data.json');
const configPath = path.join(__dirname, '../data/config.json');

const dbPath = path.join(__dirname, '../data/foobar.db');
const db = new Database(dbPath);
// db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(schema);

// ==================== Chatbot ====================
function getChatbot(server_id: Snowflake): ChatbotTable | undefined {
  return db.prepare('SELECT * FROM Chatbot WHERE server_id = ?').get(server_id) as ChatbotTable | undefined;
}
function upsertChatbot(chatbot: ChatbotTable): void {
  db.prepare(`
    INSERT INTO Chatbot (server_id, chatbot_enabled, chatbot_core_memory)
    VALUES (?, ?, ?)
    ON CONFLICT(server_id) DO UPDATE SET
      chatbot_enabled = excluded.chatbot_enabled,
      chatbot_core_memory = excluded.chatbot_core_memory
  `).run(chatbot.server_id, chatbot.chatbot_enabled ? 1 : 0, chatbot.chatbot_core_memory);
}

// ==================== ChatbotLongTermMemory ====================
function getChatbotLongTermMemory(server_id: Snowflake, memory_id: number): ChatbotLongTermMemoryTable | undefined {
  return db.prepare('SELECT * FROM ChatbotLongTermMemory WHERE server_id = ? AND memory_id = ?')
    .get(server_id, memory_id) as ChatbotLongTermMemoryTable | undefined;
}
function getChatbotLongTermMemoriesByServer(server_id: Snowflake): ChatbotLongTermMemoryTable[] {
  return db.prepare('SELECT * FROM ChatbotLongTermMemory WHERE server_id = ?').all(server_id) as ChatbotLongTermMemoryTable[];
}
function insertChatbotLongTermMemory(memory: Omit<ChatbotLongTermMemoryTable, 'memory_id'>): number {
  const { nextID } = db.prepare('SELECT COALESCE(MAX(memory_id), 0) + 1 AS next_id FROM ChatbotLongTermMemory WHERE server_id = ?')
    .get(memory.server_id) as { nextID: number };
  db.prepare('INSERT INTO ChatbotLongTermMemory (server_id, memory_id, message_content, timestamp) VALUES (?, ?, ?, ?)')
    .run(memory.server_id, nextID, memory.message_content, memory.timestamp);
  return nextID;
}
function deleteChatbotLongTermMemory(server_id: Snowflake, memory_id: number): void {
  db.prepare('DELETE FROM ChatbotLongTermMemory WHERE server_id = ? AND memory_id = ?').run(server_id, memory_id);
}
function deleteNOldestLongTermMemories(server_id: Snowflake, n: number): void {
  db.prepare('DELETE FROM ChatbotLongTermMemory WHERE server_id = ? AND memory_id IN (SELECT memory_id FROM ChatbotLongTermMemory WHERE server_id = ? ORDER BY timestamp ASC LIMIT ?)')
    .run(server_id, server_id, n);
}

// ==================== ChatbotShortTermMemory ====================
function getChatbotShortTermMemoriesByServer(server_id: Snowflake): ChatbotShortTermMemoryTable[] {
  // NOTE: Ordered by timestamp for prompt feeding
  return db.prepare('SELECT * FROM ChatbotShortTermMemory WHERE server_id = ? ORDER BY timestamp ASC')
    .all(server_id) as ChatbotShortTermMemoryTable[];
}
function insertChatbotShortTermMemory(memory: Omit<ChatbotShortTermMemoryTable, 'message_id'>): number {
  const { nextID } = db.prepare('SELECT COALESCE(MAX(message_id), 0) + 1 AS next_id FROM ChatbotShortTermMemory WHERE server_id = ?')
    .get(memory.server_id) as { nextID: number };
  db.prepare('INSERT INTO ChatbotShortTermMemory (server_id, message_id, author_id, role, message_content, timestamp) VALUES (?, ?, ?, ?, ?, ?)')
    .run(memory.server_id, nextID, memory.author_id, memory.role, memory.message_content, memory.timestamp);
  return nextID;
}
function deleteChatbotShortTermMemory(server_id: Snowflake, message_id: number): void {
  db.prepare('DELETE FROM ChatbotShortTermMemory WHERE server_id = ? AND message_id = ?').run(server_id, message_id);
}
function clearChatbotShortTermMemory(server_id: Snowflake): void {
  db.prepare('DELETE FROM ChatbotShortTermMemory WHERE server_id = ?').run(server_id);
}
function deleteNOldestShortTermMemory(server_id: Snowflake, n: number): void {
  db.prepare('DELETE FROM ChatbotShortTermMemory WHERE server_id = ? AND memory_id IN (SELECT memory_id FROM ChatbotShortTermMemory WHERE server_id = ? ORDER BY timestamp ASC LIMIT ?)')
    .run(server_id, server_id, n);
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
  // NOTE: Cascades to HeartBoardEmoji and HeartBoardMessage
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
  // NOTE: Cascades to VoicePingInput
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
  // NOTE: Regex matching is done in JS after fetching all rows, not in SQL
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

// ==================== Server ====================
function getServer(server_id: Snowflake): ServerTable | undefined {
  return db.prepare('SELECT * FROM Server WHERE server_id = ?').get(server_id) as ServerTable | undefined;
}
function insertServer(server_id: Snowflake): void {
  db.prepare('INSERT OR IGNORE INTO Server (server_id) VALUES (?)').run(server_id);
  upsertChatbot({
    server_id,
    chatbot_core_memory: '',
    chatbot_enabled: false,
  });
}
function deleteServer(server_id: Snowflake): void {
  db.prepare('DELETE FROM Server WHERE server_id = ?').run(server_id);
}

const syncDatabase = db.transaction(() => {
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

      console.log(serverConfig);

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

      upsertChatbot({ server_id: serverID, chatbot_enabled: false, chatbot_core_memory: '' });

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
  // if (currentVersion < 1) {
  // }
});

export {
  db,
  getServer, insertServer, deleteServer, syncDatabase,
  getChatbot, upsertChatbot,
  getHeartBoard, getHeartBoardsByServer, getHeartBoardsByEmoji, insertHeartBoard, updateHeartBoard, deleteHeartBoard,
  getHeartBoardEmojis, insertHeartBoardEmoji, deleteHeartBoardEmoji, deleteAllHeartBoardEmojis,
  getHeartBoardMessage, getHeartBoardMessagesByServer, getEmbedMessagesByBoard, insertHeartBoardMessage, updateHeartBoardMessage, deleteHeartBoardMessage, isEmbedMessage,
  getVoicePing, getVoicePingsByServer, insertVoicePing, updateVoicePing, deleteVoicePing,
  getVoicePingInputs, insertVoicePingInput, deleteAllVoicePingInputs, deleteVoicePingInput,
  getChatbotLongTermMemory, getChatbotLongTermMemoriesByServer, insertChatbotLongTermMemory, deleteChatbotLongTermMemory, deleteNOldestLongTermMemories,
  getChatbotShortTermMemoriesByServer, insertChatbotShortTermMemory, deleteChatbotShortTermMemory, clearChatbotShortTermMemory, deleteNOldestShortTermMemory,
  getAutomaticResponse, getAutomaticResponsesByServer, insertAutomaticResponse, updateAutomaticResponse, deleteAutomaticResponse,
};
