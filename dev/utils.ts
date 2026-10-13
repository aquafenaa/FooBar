import { Channel } from 'discord.js';
import cron from 'node-cron';
import { deleteReminder, getReminder } from './data';

function discordToDate(date: number): Date {
  return new Date(date * 1000);
}
function dateToCron(date: Date): string {
  return `${date.getSeconds()} ${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`;
}

function inputToSchedule(scheduleStr: string): string | undefined {
  if (!cron.validate(scheduleStr) && !scheduleStr.match(/<t:(\d+):\w>/)) {
    return;
  }

  // create cron schedule either from the cron string, or the discord date tag
  return cron.validate(scheduleStr) ? scheduleStr
    : dateToCron(discordToDate(Number(scheduleStr.match(/<t:(\d+):\w>/)?.[1])));
}

function sendReminder(outputChannel: Channel, serverID: string, reminderName: string) {
  const reminder = getReminder(serverID, reminderName);
  if (!reminder) return;

  try {
    if (outputChannel.isSendable()) {
      outputChannel.send(reminder.message_content);
    }
  } catch (error) {
    console.error(error);
  }

  if (!reminder.repeats) {
    deleteReminder(reminder);
  }
}

function dotProduct(vecA: number[], vecB: number[]) {
  let sum = 0;
  for (let i = 0; i < vecA.length; i++) {
    sum += vecA[i] * vecB[i];
  }

  return sum;
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

const safeFetch = async <T>(fetcher: () => Promise<T>): Promise<T | undefined> => {
  try {
    return await fetcher();
  } catch {
    return undefined; // e.g. DiscordAPIError "Unknown Member"
  }
};

function trackFence(piece: string, open: string | null): string | null {
  for (const m of piece.matchAll(/^(`{3,})(.*)$/gm)) {
    if (open) {
      const openTicks = /^`+/.exec(open)![0].length;
      // A closing fence: only backticks, at least as long as the opener
      if (m[2].trim() === '' && m[1].length >= openTicks) open = null;
    } else {
      const [match] = m;
      open = match;
    }
  }
  return open;
}

/** Best index to cut `window` at. Inside code, only cut on line boundaries. */
function splitPoint(window: string, inCode: boolean): number {
  const seps = inCode ? ['\n'] : ['\n\n', '\n', ' '];
  for (const sep of seps) {
    const idx = window.lastIndexOf(sep);
    if (idx > window.length * 0.4) return idx; // avoid uselessly tiny chunks
  }
  return window.length; // hard cut as a last resort
}

export { discordToDate, dateToCron, inputToSchedule, sendReminder, dotProduct, toBlob, fromBlob, safeFetch, trackFence, splitPoint };
