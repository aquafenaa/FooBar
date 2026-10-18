import { Snowflake } from 'discord.js';

import { getChatbot, getCrossServerSubscribers, getMemoriesBySource, getMemory } from '../data';
import { MemoryTable } from '../types/schema';

// source_id of the context shared between every attached server, making up the bot's "one personality"
const MAIN_SOURCE = 'main';

// whether the server's chatbot shares the main context. servers without a chatbot (e.g. bluesky posts) keep to themselves
function isAttached(server_id: Snowflake): boolean {
  const chatbot = getChatbot(server_id);
  return !!chatbot && !chatbot.detached;
}

// whether everyone in the conversation is fine with it reaching other servers: the server is attached, and every user opted in
function isShareable(server_id: Snowflake, user_ids: string[]): boolean {
  if (!isAttached(server_id)) return false;

  const uniqueIDs = [...new Set(user_ids)];
  const optedIn = getCrossServerSubscribers(server_id, uniqueIDs);
  return uniqueIDs.every((id) => optedIn.has(id));
}

// the server's own memories, plus the main ones if it's attached. own memories win when names clash
function getVisibleMemories(server_id: Snowflake): MemoryTable[] {
  const ownMemories = getMemoriesBySource(server_id);
  if (!isAttached(server_id)) return ownMemories;

  const ownNames = new Set(ownMemories.map((memory) => memory.name.toLowerCase())); // names aren't case-sensitive
  const mainMemories = getMemoriesBySource(MAIN_SOURCE).filter((memory) => !ownNames.has(memory.name.toLowerCase()));
  return [...ownMemories, ...mainMemories];
}
function findMemory(server_id: Snowflake, name: string): MemoryTable | undefined {
  return getMemory(server_id, name) ?? (isAttached(server_id) ? getMemory(MAIN_SOURCE, name) : undefined);
}

export { MAIN_SOURCE, isAttached, isShareable, getVisibleMemories, findMemory };
