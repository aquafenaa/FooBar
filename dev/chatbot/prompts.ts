import path from 'node:path';
import { Snowflake } from 'discord.js';
import { existsSync, readFileSync } from 'fs';

import { getPrompt, getPrompts, reorderPrompts, upsertPrompt } from '../data';
import { ChatbotPromptTable } from '../types/schema';

const promptPath = path.join(__dirname, '../../data/SYSTEM.md'); // two levels up: this file is in dev/chatbot/ (src/chatbot/ once built)
const { DISCORD_ID } = process.env;

// the module that falls back to SYSTEM.md while it's empty
const SYSTEM_PROMPT_NAME = 'system';
// made with every chatbot, in this order. they're ordinary modules otherwise, and can be changed or deleted
const DEFAULT_PROMPT_NAMES = [SYSTEM_PROMPT_NAME, 'persona'];
const MAX_PROMPTS = 10;
const MAX_PROMPT_NAME_LENGTH = 32;
// each module is wrapped in a tag of its own name, so names have to be valid tag names
const PROMPT_NAME_PATTERN = /^[a-z][a-z0-9-]*$/;

/**
 * The base system prompt, from SYSTEM.md. Read fresh each time, so edits apply without a restart.
 * SYSTEM.md is gitignored, so a fresh clone won't have one. That's fine, it just means no base prompt
 */
function getBaseSystemPrompt(): string {
  if (!existsSync(promptPath)) return '';
  return readFileSync(promptPath, 'utf-8').replace('<discord-id>', DISCORD_ID ?? 'undefined');
}

// why a name can't be used for a module, or undefined if it can
function invalidPromptName(name: string): string | undefined {
  if (name.length > MAX_PROMPT_NAME_LENGTH) return `Prompt names can be at most ${MAX_PROMPT_NAME_LENGTH} characters long.`;
  if (!PROMPT_NAME_PATTERN.test(name)) return 'Prompt names have to start with a letter, and only use lowercase letters, numbers, and hyphens.';
  return undefined;
}

// what a module says: its own content, or SYSTEM.md for an empty `system` module
function promptContent(prompt: ChatbotPromptTable): string {
  return prompt.content || (prompt.prompt_name === SYSTEM_PROMPT_NAME ? getBaseSystemPrompt() : '');
}

// the modules a new chatbot starts with. they start empty: SYSTEM.md for `system`, and no persona
function createDefaultPrompts(serverID: Snowflake): void {
  DEFAULT_PROMPT_NAMES.forEach((name) => upsertPrompt({ server_id: serverID, prompt_name: name, content: '' }));
}

/**
 * Empties a module, since a modal can't be sent empty: `system` goes back to SYSTEM.md, and any other is left out until it's set.
 * A deleted default module is made again, back in its place at the start. 'missing' if there's no such module to reset
 */
function resetPrompt(serverID: Snowflake, name: string): 'reset' | 'restored' | 'missing' {
  if (getPrompt(serverID, name)) {
    upsertPrompt({ server_id: serverID, prompt_name: name, content: '' });
    return 'reset';
  }

  const defaultIndex = DEFAULT_PROMPT_NAMES.indexOf(name);
  if (defaultIndex === -1) return 'missing';

  // it goes after the defaults that come before it, ahead of everything else
  const names = getPrompts(serverID).map((prompt) => prompt.prompt_name);
  const insertAt = names.filter((other) => DEFAULT_PROMPT_NAMES.indexOf(other) !== -1 && DEFAULT_PROMPT_NAMES.indexOf(other) < defaultIndex).length;
  names.splice(insertAt, 0, name);

  upsertPrompt({ server_id: serverID, prompt_name: name, content: '' });
  reorderPrompts(serverID, names);
  return 'restored';
}

// every module with something to say, in order, each wrapped in a tag of its own name
function buildPromptModules(serverID: Snowflake): string {
  return getPrompts(serverID)
    .map((prompt) => ({ name: prompt.prompt_name, content: promptContent(prompt).trim() }))
    .filter((prompt) => prompt.content)
    .map((prompt) => `<${prompt.name}>\n${prompt.content}\n</${prompt.name}>`)
    .join('\n');
}

export { SYSTEM_PROMPT_NAME, DEFAULT_PROMPT_NAMES, MAX_PROMPTS, getBaseSystemPrompt, invalidPromptName, promptContent, createDefaultPrompts, resetPrompt, buildPromptModules };
