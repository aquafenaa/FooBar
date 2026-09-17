import { Channel } from 'discord.js';
import cron from 'node-cron';
import { deleteReminder, getReminder } from './data';

function discordToDate(date: number): Date {
  return new Date(date * 1000);
}
function dateToCron(date: Date): string {
  console.log(date);
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
  console.log('tried to send');
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

export { discordToDate, dateToCron, inputToSchedule, sendReminder };
