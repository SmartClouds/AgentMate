import type { BackupPlanPreview } from './protocol/generated/Runova.ServerCore.Contracts';

/**
 * A backup plan's schedule (E28) as the plan editor offers it, and the five-field cron line the
 * core's scheduler runs. The core checks the cron line and the time zone again and says what is
 * wrong in its preview; this only keeps the presets honest and reads a saved plan back into one.
 */

export type BackupSchedule =
  | { kind: 'hours'; every: number }
  | { kind: 'daily'; time: string }
  | { kind: 'weekly'; day: number; time: string }
  | { kind: 'cron'; cron: string };

export const WEEKDAYS = [
  'Sunday',
  'Monday',
  'Tuesday',
  'Wednesday',
  'Thursday',
  'Friday',
  'Saturday',
] as const;

const TIME = /^([01]\d|2[0-3]):([0-5]\d)$/;
const NUMBER = /^\d{1,2}$/;

function parts(time: string): [number, number] {
  const match = TIME.exec(time);
  return match ? [Number(match[1]), Number(match[2])] : [0, 0];
}

function pad(value: number): string {
  return String(value).padStart(2, '0');
}

export function cronOf(schedule: BackupSchedule): string {
  switch (schedule.kind) {
    case 'hours':
      return schedule.every === 1 ? '0 * * * *' : `0 */${schedule.every} * * *`;
    case 'daily': {
      const [hour, minute] = parts(schedule.time);
      return `${minute} ${hour} * * *`;
    }
    case 'weekly': {
      const [hour, minute] = parts(schedule.time);
      return `${minute} ${hour} * * ${schedule.day}`;
    }
    case 'cron':
      return schedule.cron.trim().replace(/\s+/g, ' ');
  }
}

export function scheduleOf(cron: string): BackupSchedule {
  const line = cron.trim().replace(/\s+/g, ' ');
  const fields = line.split(' ');
  if (fields.length === 5) {
    const [minute, hour, dayOfMonth, month, dayOfWeek] = fields as [
      string,
      string,
      string,
      string,
      string,
    ];
    const rest = dayOfMonth === '*' && month === '*';
    if (rest && minute === '0' && dayOfWeek === '*') {
      if (hour === '*') return { kind: 'hours', every: 1 };
      const every = /^\*\/(\d{1,2})$/.exec(hour);
      if (every && Number(every[1]) >= 1 && Number(every[1]) <= 23) {
        return { kind: 'hours', every: Number(every[1]) };
      }
    }
    if (rest && NUMBER.test(minute) && NUMBER.test(hour)) {
      const m = Number(minute);
      const h = Number(hour);
      if (m < 60 && h < 24) {
        const time = `${pad(h)}:${pad(m)}`;
        if (dayOfWeek === '*') return { kind: 'daily', time };
        if (/^[0-6]$/.test(dayOfWeek)) return { kind: 'weekly', day: Number(dayOfWeek), time };
      }
    }
  }
  return { kind: 'cron', cron: line };
}

export function scheduleProblem(schedule: BackupSchedule): string | null {
  switch (schedule.kind) {
    case 'hours':
      return Number.isInteger(schedule.every) && schedule.every >= 1 && schedule.every <= 23
        ? null
        : 'Pick every 1 to 23 hours, or daily.';
    case 'weekly':
      if (!Number.isInteger(schedule.day) || schedule.day < 0 || schedule.day > 6) {
        return 'Pick a day of the week.';
      }
      return TIME.test(schedule.time) ? null : 'Write the time as HH:MM, like 03:30.';
    case 'daily':
      return TIME.test(schedule.time) ? null : 'Write the time as HH:MM, like 03:30.';
    case 'cron':
      return schedule.cron.trim().split(/\s+/).length === 5
        ? null
        : 'A cron line has five fields: minute, hour, day of month, month, day of week.';
  }
}

/** A size the way a person says it: 14 GB, 1.5 GB, 300 MB. */
export function backupSize(bytes: number): string {
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let unit = 0;
  while (value >= 1024 && unit < units.length - 1) {
    value /= 1024;
    unit += 1;
  }
  const shown = value >= 10 || Number.isInteger(value) ? Math.round(value) : value.toFixed(1);
  return `${shown} ${units[unit]}`;
}

/** What the preview says a plan keeps: "Keeps 7 backups on each destination, about 14 GB each, ...". */
export function keepSentence(
  preview: Pick<BackupPlanPreview, 'kept' | 'bytesPerDestination' | 'firstDeletionAtUnixMs'> &
    Partial<BackupPlanPreview>,
  formatDate: (unixMs: number) => string,
): string {
  const parts = [
    `Keeps ${preview.kept} ${preview.kept === 1 ? 'backup' : 'backups'} on each destination`,
  ];
  if (preview.bytesPerDestination)
    parts.push(`about ${backupSize(preview.bytesPerDestination)} each`);
  if (preview.firstDeletionAtUnixMs) {
    parts.push(`the oldest goes on ${formatDate(preview.firstDeletionAtUnixMs)}`);
  }
  return `${parts.join(', ')}.`;
}

export function telegramPartNote(premium: boolean): string {
  return premium
    ? 'Big backups are sent in parts of 4000 MB, since this account has Premium.'
    : 'Big backups are sent in parts of 2000 MB (4000 MB with Telegram Premium).';
}
