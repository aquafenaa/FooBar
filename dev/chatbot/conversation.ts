import { generateText } from 'ai';
import { xai } from '@ai-sdk/xai';
import cron from 'node-cron';

import { clearConversationMessages, clearConversationToolResults, getAttachedServers, getConversation, getConversationMessages, getConversationToolResults, getConversationSummariesBySource, getConversationSummary, getCrossServerSubscribers, getLatestConversationSummaries, upsertConversation, upsertConversationSummary } from '../data';
import { getEmbedding } from './chatbot';
import { ConversationMessageTable, ConversationSummaryTable, ConversationTable, ConversationToolResultTable } from '../types/schema';
import { dotProduct, millisToCronSchedule } from '../utils';
import { MAIN_SOURCE, isAttached } from './context';

const MAX_SUMMARY_LENGTH = 4000;
const EXPIRY_LEEWAY = 60_000; // 1 minute

// prompt for summarizing an expired conversation
const conversationSummaryPrompt = `You're foo, a chatbot. The following is a conversation you took part in, which has now ended. Summarize it, so you can recall it if the conversation is ever picked back up.
Only include the summarization, no preamble. Be as concise as possible, while still keeping important information. Use bullet points to keep information concise.
Keep who was involved, what was discussed, anything decided or promised, and anything left unresolved. Drop small talk with no lasting consequence.
If a PREVIOUS SUMMARY is given, merge it with the new messages into one updated summary. If new info contradicts it, keep only the new info.
<tool_result> entries are results from tools you used (web searches, fetched pages, etc.). Keep what you learned from them that's worth remembering, not the raw results.
Do not restate any information. Keep it to 200 words or less.`;

// characters of each tool result given to the summarizer, same as the chatbot's own limit
const MAX_SUMMARY_TOOL_RESULT_LENGTH = 4000;

// '#' separates the parts, since bluesky post paths (at://did:plc:.../...) already contain ':' and '/'
const SOURCE_SEPARATOR = '#';

/**
 * Builds a summary's source_id from its conversation: `{server_id}#{channel_id}` on discord,
 * or just the conversation's source (the post path) on platforms without channels.
 * The copy shared between servers is prefixed with `main#`
 */
function toSummarySource(conversation: ConversationTable, shared = false): string | undefined {
  if (!conversation.source_id) return undefined;

  const source = conversation.channel_id ? `${conversation.source_id}${SOURCE_SEPARATOR}${conversation.channel_id}` : conversation.source_id;
  return shared ? `${MAIN_SOURCE}${SOURCE_SEPARATOR}${source}` : source;
}
function fromSummarySource(summarySource: string): { shared: boolean, source_id: string, channel_id?: string } {
  const mainPrefix = `${MAIN_SOURCE}${SOURCE_SEPARATOR}`;
  const shared = summarySource.startsWith(mainPrefix);
  const source = shared ? summarySource.substring(mainPrefix.length) : summarySource;

  const separatorIndex = source.lastIndexOf(SOURCE_SEPARATOR);
  if (separatorIndex === -1) return { shared, source_id: source };

  return { shared, source_id: source.substring(0, separatorIndex), channel_id: source.substring(separatorIndex + 1) };
}

// a conversation can have both a local and a shared summary. keep one per conversation, preferring local, since it has every message
function preferLocal(summaries: ConversationSummaryTable[]): ConversationSummaryTable[] {
  const byConversation = new Map<string, ConversationSummaryTable>();
  summaries.forEach((summary) => {
    const existing = byConversation.get(summary.conversation_id);
    if (!existing || (fromSummarySource(existing.source_id).shared && !fromSummarySource(summary.source_id).shared)) {
      byConversation.set(summary.conversation_id, summary);
    }
  });

  return [...byConversation.values()];
}

async function generateSummary(conversation_id: string, messages: ConversationMessageTable[], toolResults: ConversationToolResultTable[], previousSummary: string | undefined): Promise<string | undefined> {
  // messages and tool results, interleaved in the order they happened
  const transcript = [
    ...messages.map((msg) => ({
      timestamp: msg.timestamp,
      text: `<msg user_id="${msg.author_id}" nick="${msg.author_name}" id="${msg.message_id}"${msg.reference_id ? ` references="${msg.reference_id}"` : ''} time="${new Date(msg.timestamp).toLocaleString()}">${msg.message_content}</msg>`,
    })),
    ...toolResults.map((tool) => ({
      timestamp: tool.timestamp,
      text: `<tool_result name="${tool.tool_name}" time="${new Date(tool.timestamp).toLocaleString()}">${tool.output.substring(0, MAX_SUMMARY_TOOL_RESULT_LENGTH)}</tool_result>`,
    })),
  ].sort((a, b) => a.timestamp - b.timestamp).map((entry) => entry.text).join('\n');

  const { text } = await generateText({
    model: xai.responses('grok-4.7'),
    system: conversationSummaryPrompt,
    reasoning: 'medium',
    temperature: 0.3,
    prompt: `${previousSummary ? `PREVIOUS SUMMARY:\n${previousSummary}\n\n` : ''}MESSAGES:\n${transcript}`,
    headers: {
      'x-grok-conv-id': conversation_id,
    },
  });

  return text ? text.substring(0, MAX_SUMMARY_LENGTH) : undefined;
}

/**
 * Summarizes an expired conversation, replacing its messages with the summary.
 * Called by the conversation's cron task once it expires.
 *
 * In an attached server, a shared (`main#`) summary is made from the messages of users who opted in, plus all of the bot's.
 * If anyone didn't opt in, a local summary of every message is made too, which is preferred over the shared one in this server.
 * Returns the local summary if one was made, otherwise the shared one, or undefined if there was nothing to summarize.
*/
async function summarizeConversation(conversation_id: string): Promise<string | undefined> {
  const conversation = getConversation(conversation_id);
  if (!conversation?.source_id) return;

  // conversation was extended after this task was scheduled, so it isn't ours to summarize yet
  // leeway, since cron fires on the second while expires_at has millis, so the task can run slightly before expiry
  if (conversation.expires_at - Date.now() > EXPIRY_LEEWAY) return;

  const messages = getConversationMessages(conversation_id);
  if (messages.length === 0) return;

  const localSource = toSummarySource(conversation)!;
  const sharedSource = toSummarySource(conversation, true)!;
  const previousLocal = getConversationSummary(conversation_id, localSource);
  const previousShared = getConversationSummary(conversation_id, sharedSource);

  const attached = isAttached(conversation.source_id);
  const userIDs = [...new Set(messages.filter((msg) => msg.role === 'user').map((msg) => msg.author_id))];
  const optedIn = attached ? getCrossServerSubscribers(conversation.source_id, userIDs) : new Set<string>();
  const sharedMessages = messages.filter((msg) => msg.role !== 'user' || optedIn.has(msg.author_id));

  const makeShared = attached && sharedMessages.some((msg) => msg.role === 'user');
  // a local one is only needed if someone was left out of the shared one. but keep updating an existing local one, so it never goes stale
  const makeLocal = !makeShared || sharedMessages.length < messages.length || !!previousLocal;

  // tool results can hold things from people who didn't opt in (e.g. a search they asked for, or this server's memories),
  // so the shared summary only gets them when everyone opted in
  const toolResults = getConversationToolResults(conversation_id);
  const sharedToolResults = sharedMessages.length === messages.length ? toolResults : [];

  const targets: { source_id: string, messages: ConversationMessageTable[], toolResults: ConversationToolResultTable[], previous?: string }[] = [];
  if (makeLocal) targets.push({ source_id: localSource, messages, toolResults, previous: (previousLocal ?? previousShared)?.summary });
  if (makeShared) targets.push({ source_id: sharedSource, messages: sharedMessages, toolResults: sharedToolResults, previous: previousShared?.summary });

  const summaries = await Promise.all(targets.map((target) => generateSummary(conversation_id, target.messages, target.toolResults, target.previous)));

  // keep the messages if we got nothing back, so they can be summarized on a later attempt
  if (summaries.some((summary) => !summary)) return;

  await Promise.all(targets.map(async (target, i) => upsertConversationSummary({
    conversation_id,
    source_id: target.source_id,
    summary: summaries[i]!,
    timestamp: Date.now(),
    embedding: await getEmbedding(summaries[i]!),
  })));
  // the summaries now stand in for the messages and tool results
  clearConversationMessages(conversation_id);
  clearConversationToolResults(conversation_id);

  return summaries[0];
}

/**
 * Returns the n most recent summaries from the same channel, plus up to k other summaries most similar to the prompt.
 * The channel's summaries are always included, and don't count towards k. Older summaries from the channel can still be picked by similarity.
 *
 * Draws from the server's own summaries, plus every attached server's shared ones if this server is attached.
 * When a conversation has both a local and a shared summary, the local one is used.
 * Results are in chronological order, and never include the conversation's own summary.
 */
async function getRelevantSummaries(conversation: ConversationTable, promptMessage: ConversationMessageTable, k = 8, p = 0.3, n = 3) {
  if (!conversation.source_id) return []; // without a source, there's no way to know which summaries are safe to share

  // always given, regardless of similarity, so the bot remembers what recently happened where it's talking
  // n + 1 of each, in case this conversation's own summary is among them
  const latestSummaries = preferLocal([
    ...getLatestConversationSummaries(toSummarySource(conversation)!, n + 1),
    ...getLatestConversationSummaries(toSummarySource(conversation, true)!, n + 1),
  ])
    .filter((summary) => summary.conversation_id !== conversation.conversation_id)
    .sort((a, b) => a.timestamp - b.timestamp)
    .slice(-n);

  // the server's own summaries, both local and shared. attached servers also get every attached server's shared ones
  const sharedSources = isAttached(conversation.source_id) ? getAttachedServers() : [conversation.source_id];
  const conversationSummaries = preferLocal([
    ...getConversationSummariesBySource(conversation.source_id),
    ...sharedSources.flatMap((serverID) => getConversationSummariesBySource(`${MAIN_SOURCE}${SOURCE_SEPARATOR}${serverID}`)),
  ]);
  if (conversationSummaries.length === 0) return latestSummaries;

  const promptEmbedding = await getEmbedding(promptMessage.message_content);

  const similarSummaries = conversationSummaries
    .filter((summary) => summary.conversation_id !== conversation.conversation_id && !latestSummaries.some((latest) => latest.conversation_id === summary.conversation_id))
    .map((summary) => ({
      ...summary,
      dot: dotProduct(promptEmbedding, summary.embedding ?? []),
    }))
    .filter((summary) => summary.dot >= p) // ensure summary has at least p similarity with prompt
    .sort((a, b) => b.dot - a.dot) // sort by relatedness for slice
    .slice(0, k) // get top k results. the channel's latest summaries don't count towards this
    .map((summary) => {
      const { dot, ...original } = summary;
      return original; // drop dot from object
    });

  return [...latestSummaries, ...similarSummaries].sort((a, b) => a.timestamp - b.timestamp); // chronological order for use
}

/**
 * Ends a conversation now and summarizes it, rather than waiting for it to expire.
 * The channel's next message starts a fresh conversation, which gets this summary as one of the channel's latest.
 * Returns the summary, or undefined if there was nothing to summarize.
 */
async function endConversation(conversation: ConversationTable): Promise<string | undefined> {
  // its expiry task would only find nothing left to summarize
  cron.getTasks().forEach((task) => {
    if (task.name === conversation.conversation_id) task.destroy();
  });

  // expired, so it's no longer the channel's active conversation
  upsertConversation({ ...conversation, expires_at: Date.now() });

  return summarizeConversation(conversation.conversation_id);
}

function scheduleExpireTask(conversationResolvable: string | ConversationTable) {
  const conversation = typeof conversationResolvable === 'string' ? getConversation(conversationResolvable) : conversationResolvable;
  if (!conversation) return;

  // already expired (e.g. while the bot was offline). a past cron date wouldn't fire until next year, so summarize now
  if (conversation.expires_at <= Date.now()) {
    summarizeConversation(conversation.conversation_id).catch((error) => console.error(error));
    return;
  }

  cron.schedule(millisToCronSchedule(conversation.expires_at)!, () => summarizeConversation(conversation.conversation_id), {
    name: conversation.conversation_id,
  });
}

function toBlob(vector: number[] | undefined) {
  if (!vector) return undefined;

  const f32 = Float32Array.from(vector);
  return Buffer.from(f32.buffer, f32.byteOffset, f32.byteLength);
}
function fromBlob(blob: Buffer | undefined) {
  if (!blob) return undefined;
  // slice() copies into a fresh ArrayBuffer, which guarantees 4-byte alignment
  const f32 = new Float32Array(blob.buffer.slice(blob.byteOffset, blob.byteOffset + blob.byteLength));
  return Array.from(f32);
}

export { summarizeConversation, endConversation, getRelevantSummaries, scheduleExpireTask, SOURCE_SEPARATOR, toSummarySource, fromSummarySource, toBlob, fromBlob };
