import path from 'node:path';
import { Snowflake } from 'discord.js';
import Database from 'better-sqlite3';
import { readFileSync } from 'fs';

import { AutomaticResponseTable, ChatbotLongTermMemoryTable, ChatbotShortTermMemoryTable, ChatbotTable, HeartBoardEmojiTable, HeartBoardMessageTable, HeartBoardTable, ServerTable, VoicePingInputTable, VoicePingTable } from './types/schema';

const schemaPath = path.join(__dirname, '../data/seed/schema.sql');
const schema = readFileSync(schemaPath, 'utf-8');

// const dataPath = path.join(__dirname, '../data/data.json');
// const configPath = path.join(__dirname, '../data/config.json');

const db = new Database('cok.db');
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

db.exec(schema);

// function getUser(user_id: Snowflake): UserTable | undefined {
//   return db.prepare('SELECT * FROM User WHERE user_id = ?').get(user_id) as UserTable | undefined;
// }
// function insertUser(user: UserTable): void {
//   db.prepare('INSERT OR IGNORE INTO User (user_id, user_name, user_display) VALUES (?, ?, ?)')
//     .run(user.user_id, user.user_name, user.user_display);
// }
// function updateUser(user: UserTable): void {
//   db.prepare('UPDATE User SET user_name = ?, user_display = ? WHERE user_id = ?')
//     .run(user.user_name, user.user_display, user.user_id);
// }
// function deleteUser(user_id: Snowflake): void {
//   db.prepare('DELETE FROM User WHERE user_id = ?').run(user_id);
// }

// ==================== Server ====================

function getServer(server_id: Snowflake): ServerTable | undefined {
  return db.prepare('SELECT * FROM Server WHERE server_id = ?').get(server_id) as ServerTable | undefined;
}
function insertServer(server_id: Snowflake): void {
  db.prepare('INSERT OR IGNORE INTO Server (server_id) VALUES (?)').run(server_id);
}
function deleteServer(server_id: Snowflake): void {
  db.prepare('DELETE FROM Server WHERE server_id = ?').run(server_id);
}

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
  `).run(chatbot.server_id, chatbot.chatbot_enabled, chatbot.chatbot_core_memory);
}

// ==================== Channel ====================
// function getChannel(channel_id: Snowflake): ChannelTable | undefined {
//   return db.prepare('SELECT * FROM Channel WHERE channel_id = ?').get(channel_id) as ChannelTable | undefined;
// }
// function getChannelsByServer(server_id: Snowflake): ChannelTable[] {
//   return db.prepare('SELECT * FROM Channel WHERE server_id = ?').all(server_id) as ChannelTable[];
// }
// function insertChannel(channel: ChannelTable): void {
//   db.prepare('INSERT OR IGNORE INTO Channel (server_id, channel_id) VALUES (?, ?)')
//     .run(channel.server_id, channel.channel_id);
// }
// function deleteChannel(channel_id: Snowflake): void {
//   // NOTE: Cascades to Message, HeartBoardMessage, VoicePingInput
//   db.prepare('DELETE FROM Channel WHERE channel_id = ?').run(channel_id);
// }

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

// ==================== Message ====================
// function getMessage(message_id: Snowflake): MessageTable | undefined {
//   return db.prepare('SELECT * FROM Message WHERE message_id = ?').get(message_id) as MessageTable | undefined;
// }
// function insertMessage(message: MessageTable): void {
//   db.prepare('INSERT OR IGNORE INTO Message (server_id, channel_id, message_id, author_id) VALUES (?, ?, ?, ?)')
//     .run(message.server_id, message.channel_id, message.message_id, message.author_id);
// }
// function deleteMessage(message_id: Snowflake): void {
//   // NOTE: Cascades to HeartBoardMessage
//   db.prepare('DELETE FROM Message WHERE message_id = ?').run(message_id);
// }

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
    .run(board.server_id, board.board_name, board.enabled, board.deny_author, board.threshold, board.output_channel);
}
function updateHeartBoard(board: HeartBoardTable): void {
  db.prepare(`UPDATE HeartBoard SET enabled = ?, deny_author = ?, threshold = ?, output_channel = ?
    WHERE server_id = ? AND board_name = ?`)
    .run(board.enabled, board.deny_author, board.threshold, board.output_channel, board.server_id, board.board_name);
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
    .run(ping.server_id, ping.voiceping_name, ping.enabled, ping.message_template, ping.output_channel);
}
function updateVoicePing(ping: VoicePingTable): void {
  db.prepare('UPDATE VoicePing SET message_template = ?, output_channel = ? WHERE server_id = ? AND voiceping_name = ?')
    .run(ping.message_template, ping.output_channel, ping.server_id, ping.voiceping_name);
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
  db.prepare('INSERT OR IGNORE INTO AutomaticResponse (server_id, name, enabled, ctivation_regex, capture_regex, output_template) VALUES (?, ?, ?, ?, ?)')
    .run(response.server_id, response.name, response.enabled, response.activation_regex, response.capture_regex, response.output_template);
}
function updateAutomaticResponse(response: AutomaticResponseTable): void {
  db.prepare('UPDATE AutomaticResponse SET enabled = ?, activation_regex = ?, capture_regex = ?, output_template = ? WHERE server_id = ? AND name = ?')
    .run(response.enabled, response.activation_regex, response.capture_regex, response.output_template, response.server_id, response.name);
}
function deleteAutomaticResponse(server_id: Snowflake, name: string): void {
  db.prepare('DELETE FROM AutomaticResponse WHERE server_id = ? AND name = ?').run(server_id, name);
}

const syncServer = db.transaction((server_id: Snowflake) => {
  insertServer(server_id);
  upsertChatbot({ server_id, chatbot_enabled: false, chatbot_core_memory: '' });

  // const currentVersion = (db.pragma('user_version', { simple: true }) as number);
  // if (currentVersion < 1) {
  // }
});

export {
  db,
  // getUser, insertUser, updateUser, deleteUser,
  getServer, insertServer, deleteServer, syncServer,
  getChatbot, upsertChatbot,
  // getChannel, getChannelsByServer, insertChannel, deleteChannel,
  // getMessage, insertMessage, deleteMessage,
  getHeartBoard, getHeartBoardsByServer, getHeartBoardsByEmoji, insertHeartBoard, updateHeartBoard, deleteHeartBoard,
  getHeartBoardEmojis, insertHeartBoardEmoji, deleteHeartBoardEmoji, deleteAllHeartBoardEmojis,
  getHeartBoardMessage, getHeartBoardMessagesByServer, getEmbedMessagesByBoard, insertHeartBoardMessage, updateHeartBoardMessage, deleteHeartBoardMessage, isEmbedMessage,
  getVoicePing, getVoicePingsByServer, insertVoicePing, updateVoicePing, deleteVoicePing,
  getVoicePingInputs, insertVoicePingInput, deleteVoicePingInput,
  getChatbotLongTermMemory, getChatbotLongTermMemoriesByServer, insertChatbotLongTermMemory, deleteChatbotLongTermMemory, deleteNOldestLongTermMemories,
  getChatbotShortTermMemoriesByServer, insertChatbotShortTermMemory, deleteChatbotShortTermMemory, clearChatbotShortTermMemory, deleteNOldestShortTermMemory,
  getAutomaticResponse, getAutomaticResponsesByServer, insertAutomaticResponse, updateAutomaticResponse, deleteAutomaticResponse,
};

// let configBeingUsed = false;
// let dataBeingUsed = false;

// // WRITES GIVEN DATA TO RELATIVE LOCATION
// async function writeData(saveData: SaveData) {
//   if (dataBeingUsed) {
//     return new Promise((resolve) => {
//       setTimeout(async () => {
//         resolve(await writeData(saveData));
//       }, 200);
//     });
//   }

//   dataBeingUsed = true;

//   const saveDataString = JSON.stringify(saveData, null, 2);
//   // console.log('String:');
//   // console.log(saveDataString);
//   await writeFile(dataPath, saveDataString);

//   dataBeingUsed = false;
// }

// async function writeConfig(saveData: ConfigData) {
//   if (configBeingUsed) {
//     return new Promise((resolve) => {
//       setTimeout(async () => {
//         resolve(await writeConfig(saveData));
//       }, 200);
//     });
//   }

//   configBeingUsed = true;

//   const saveDataString = JSON.stringify(saveData, null, 2);
//   await writeFile(configPath, saveDataString);

//   configBeingUsed = false;
// }

// // READS DATA FROM RELATIVE LOCATION
// async function readData(): Promise<SaveData> {
//   if (dataBeingUsed) {
//     return new Promise((resolve) => {
//       setTimeout(async () => {
//         resolve(await readData());
//       }, 200);
//     });
//   }

//   dataBeingUsed = true;

//   const result = JSON.parse(await readFile(dataPath, 'utf-8'));

//   dataBeingUsed = false;
//   return result;
// }

// async function readConfig(): Promise<ConfigData> {
//   if (configBeingUsed) {
//     return new Promise((resolve) => {
//       setTimeout(async () => {
//         resolve(await readConfig());
//       }, 200);
//     });
//   }

//   return JSON.parse(await readFile(configPath, 'utf-8'));
// }

// // ADDS A NEW SERVER IF GUILD ID DOESN'T EXIST
// async function addData(guildID: string): Promise<ServerData> {
//   const data = await readData();

//   const oldData = data.servers.find((s) => s.id === guildID);
//   if (oldData) return oldData;

//   const serverData: ServerData = {
//     id: guildID,
//     heartBoardMessages: [],

//     chatbotCoreMemory: '',
//     chatbotLongtermMemory: [],
//     chatbotShortTermMessages: [],
//   };

//   data.servers.push(serverData);
//   writeData(data);

//   return serverData;
// }

// async function addConfig(guildID: string): Promise<ServerConfig> {
//   const config = await readConfig();

//   const oldConfig = config.servers.find((s) => s.id === guildID);
//   if (oldConfig) return oldConfig;

//   const serverConfig: ServerConfig = {
//     id: guildID,

//     aiEnabled: false,
//     serverResponses: [],
//     heartBoard: defaultHeartboardConfig,
//     voicePing: defaultVoicepingConfig,
//   };

//   config.servers.push(serverConfig);
//   writeConfig(config);

//   return serverConfig;
// }

// // GETS DATA GIVEN A GUILD ID
// async function getServerData(guildID: Snowflake): Promise<ServerData | undefined> {
//   const data = await readData();

//   const serverData = data.servers.find((s) => s.id === guildID);

//   return serverData ?? await addData(guildID);
// }

// async function getServerConfig(guildID: Snowflake): Promise<ServerConfig | undefined> {
//   const config = await readConfig();

//   return config.servers.find((server) => server.id === guildID);
// }

// // EDITS AN EXISTING SERVER IF IT EXISTS, OR CREATES ONE
// async function editServerData(serverData: ServerData) {
//   const data = await readData();
//   const index = data.servers.findIndex((server) => server.id === serverData.id);

//   if (index === -1) {
//     data.servers.push(serverData);
//   } else {
//     data.servers[index] = serverData;
//   }

//   console.log('\n\n\nData:');
//   console.log(data);

//   await writeData(data);
// }

// async function editServerConfig(serverConfig: ServerConfig) {
//   const config = await readConfig();
//   const index = config.servers.findIndex((server) => server.id === serverConfig.id);

//   if (index === -1) {
//     config.servers.push(serverConfig);
//   } else {
//     config.servers[index] = serverConfig;
//   }

//   writeConfig(config);
// }

// // REPAIRS AN INCOMPLETE SERVER DATA WITH DEFAULT DATA
// async function repairServerData(serverData: any): Promise<ServerData> {
//   if (!serverData.id) return serverData;

//   const fixedData: ServerData = {
//     id: serverData.id,

//     heartBoardMessages: serverData.heartBoardMessages ?? [],
//     chatbotCoreMemory: serverData.chatbotCoreMemory ?? '',
//     chatbotLongtermMemory: serverData.chatbotLongtermMemory ?? [],
//     chatbotShortTermMessages: serverData.chatbotShortTermMessages ?? [],
//   };

//   // console.log(fixedData);

//   await editServerData(fixedData); // update if changed
//   return fixedData;
// }

// async function repairServerConfig(serverConfig: any): Promise<ServerConfig> {
//   const fixedConfig: ServerConfig = {
//     id: serverConfig.id,

//     aiEnabled: serverConfig.aiEnabled ?? false,
//     serverResponses: serverConfig.serverResponses ?? [],
//     heartBoard: serverConfig.heartBoard ?? defaultHeartboardConfig,
//     voicePing: serverConfig.voicePing ?? defaultVoicepingConfig,
//   };

//   await editServerConfig(fixedConfig); // update if changed
//   return fixedConfig;
// }

// export {
//   writeData, readData, writeConfig, readConfig, getServerConfig, getServerData, addData, addConfig,
//   editServerData, editServerConfig, repairServerData, repairServerConfig,
// };
