import { DEFAULT_REASONING_EFFORT } from './models';
import { ConversationMessageTable, ConversationToolResultTable, MemoryTable } from '../types/schema';

const AUTO_EFFORT = 'auto'; // the /chatbot reasoning-effort setting that has Jev judge each message
const JEV_URL = 'https://api.typesafe.ai/v1/systemone';
const JEV_TIMEOUT = 3_000; // millis. this runs before every reply, so it can't be slow
const YES_ABOVE = 0.7;
const NO_BELOW = 0.3;
const MAX_MEMORY_CHARS = 2_000; // per memory
const MAX_MEMORIES_CHARS = 40_000; // keeps the request well under the 64k token limit
const MAX_TOOL_CALLS = 5;
const MAX_TOOL_OUTPUT_CHARS = 500;

type Judgment = 'casual' | 'several_steps' | 'careful_reasoning' | 'costly_mistake';
type Answers = Record<Judgment, number>;
interface EffortInput {
  message: ConversationMessageTable,
  reference?: ConversationMessageTable,
  toolResults: ConversationToolResultTable[],
  memories: MemoryTable[],
}

const noul = (instructions: string, yes: string, no: string) => ({ type: 'noul', instructions, criteria: { true: yes, false: no } });

const QUESTIONS: Record<Judgment, ReturnType<typeof noul>> = {
  casual: noul(
    'Is `current_message` only casual conversation?',
    'The sender is greeting, joking, reacting, or chatting, and is not asking for anything to be worked out',
    'The sender is asking a question or asking for something to be done',
  ),
  several_steps: noul(
    'Does `current_message` ask for work that takes several separate steps?',
    'The request has several parts to do in order, such as find something, change it, then check it',
    'The request can be answered or done in one go',
  ),
  careful_reasoning: noul(
    'Does answering `current_message` require reasoning through a hard problem?',
    'A knowledgeable person would have to stop and work it out, as with debugging, a proof, or weighing several constraints',
    'A knowledgeable person could answer straight away from what they know',
  ),
  costly_mistake: noul(
    'Would a wrong answer to `current_message` cause real harm to the sender?',
    'A mistake could lose data, money, or health, or break something in use',
    'A mistake would be harmless and easy to correct',
  ),
};

/**
 * Jev only answers the questions above. The effort is decided here:
 *
 *   careful_reasoning  several_steps or costly_mistake  ->  xhigh
 *   careful_reasoning or costly_mistake                 ->  high
 *   several_steps                                       ->  medium
 *   any of those three unsettled                        ->  medium
 *   casual                                              ->  minimal
 *   anything else, a simple question or small task      ->  low
 */
function chooseEffort(answers: Answers): string {
  const yes = (judgment: Judgment) => answers[judgment] > YES_ABOVE;
  const unsettled = (judgment: Judgment) => answers[judgment] >= NO_BELOW && !yes(judgment);

  if (yes('careful_reasoning') && (yes('several_steps') || yes('costly_mistake'))) return 'xhigh';
  if (yes('careful_reasoning') || yes('costly_mistake')) return 'high';
  if (yes('several_steps')) return 'medium';
  if (unsettled('careful_reasoning') || unsettled('several_steps') || unsettled('costly_mistake')) return 'medium';
  return yes('casual') ? 'minimal' : 'low';
}

const formatMessage = (message: ConversationMessageTable) => ({ author: message.author_name, text: message.message_content });

// empty fields are left out, since Jev can read an empty list as a signal
function buildState({ message, reference, toolResults, memories }: EffortInput): Record<string, unknown> {
  const toolCalls = toolResults.slice(-MAX_TOOL_CALLS)
    .map((result) => ({ name: result.tool_name, output: result.output.substring(0, MAX_TOOL_OUTPUT_CHARS) }));

  let memoryChars = 0;
  const memoryState: Record<string, string> = {};
  for (const memory of memories) {
    const content = memory.content.substring(0, MAX_MEMORY_CHARS);
    memoryChars += content.length;
    if (memoryChars > MAX_MEMORIES_CHARS) break;
    memoryState[memory.name] = content;
  }

  return {
    current_message: formatMessage(message),
    ...(reference ? { referenced_message: formatMessage(reference) } : {}),
    ...(toolCalls.length ? { assistant_recent_tool_calls: toolCalls } : {}),
    ...(memories.length ? { assistant_memories: memoryState } : {}),
  };
}

// the effort to use for a whole reply. a failed call is logged and gets the default, so an outage can't pass as an easy message
async function judgeEffort(input: EffortInput, signal?: AbortSignal): Promise<string> {
  const body = JSON.stringify({ model: 'jev-latest', state: buildState(input), questions: QUESTIONS });
  const timeout = AbortSignal.timeout(JEV_TIMEOUT);

  try {
    const response = await fetch(JEV_URL, {
      method: 'POST',
      headers: { Authorization: `Bearer ${process.env.JEV_KEY}`, 'Content-Type': 'application/json' },
      body,
      signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
    });
    if (!response.ok) throw new Error(`Jev responded ${response.status}: ${await response.text()}`);

    const { answers } = await response.json() as { answers: Record<Judgment, { noul: number }> };
    const judgments = Object.fromEntries((Object.keys(QUESTIONS) as Judgment[]).map((judgment) => [judgment, answers[judgment].noul])) as Answers;
    const effort = chooseEffort(judgments);
    return effort;
  } catch (error) {
    if (!signal?.aborted) console.error('Jev failed, so this reply uses the default effort:', error, body);
    return DEFAULT_REASONING_EFFORT;
  }
}

export { AUTO_EFFORT, chooseEffort, buildState, judgeEffort };
