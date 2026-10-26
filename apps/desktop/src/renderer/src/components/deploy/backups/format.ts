import { type BackupSchedule, scheduleOf, WEEKDAYS } from '@shared/deploy/backupSchedule';
import type {
  BackupDestinationKind,
  BackupRunInfo,
  BackupRunState,
  BackupTargetState,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ChipTone } from '@/components/pageKit';

/** Words for the Backups section (E28). */

export const KIND_LABEL: Record<BackupDestinationKind, string> = {
  folder: 'Folder on the server',
  ftp: 'FTP or FTPS',
  sftp: 'SFTP',
  googleDrive: 'Google Drive',
  oneDrive: 'OneDrive',
  telegram: 'Telegram',
};

export const RUN_STATE: Record<BackupRunState, { label: string; tone: ChipTone }> = {
  running: { label: 'Running', tone: 'primary' },
  succeeded: { label: 'Done', tone: 'success' },
  partlyFailed: { label: 'Partly failed', tone: 'warning' },
  failed: { label: 'Failed', tone: 'destructive' },
};

export const TARGET_STATE: Record<BackupTargetState, { label: string; tone: ChipTone }> = {
  pending: { label: 'Waiting', tone: 'neutral' },
  uploading: { label: 'Uploading', tone: 'primary' },
  succeeded: { label: 'Uploaded', tone: 'success' },
  failed: { label: 'Failed', tone: 'destructive' },
};

export function runLabel(run: BackupRunInfo): string {
  if (run.planName) return run.planName;
  if (run.trigger === 'beforeRestore') return 'Before a restore';
  if (run.trigger === 'schedule') return 'Scheduled';
  return 'Back up now';
}

/** "Every 6 hours", "Daily at 03:30", "Weekly on Sunday at 23:05", or the cron line. */
export function describeSchedule(schedule: BackupSchedule): string {
  switch (schedule.kind) {
    case 'hours':
      return schedule.every === 1 ? 'Every hour' : `Every ${schedule.every} hours`;
    case 'daily':
      return `Daily at ${schedule.time}`;
    case 'weekly':
      return `Weekly on ${WEEKDAYS[schedule.day] ?? 'Sunday'} at ${schedule.time}`;
    case 'cron':
      return `Cron: ${schedule.cron}`;
  }
}

export function describeCron(cron: string): string {
  return describeSchedule(scheduleOf(cron));
}

/** The local time zone, as Intl names it. */
export function localTimeZone(): string {
  try {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || 'UTC';
  } catch {
    return 'UTC';
  }
}

/** Every IANA time zone this runtime knows, with the local one and UTC always in. */
export function timeZones(): string[] {
  let zones: string[] = [];
  try {
    const supported = (Intl as { supportedValuesOf?: (key: string) => string[] }).supportedValuesOf;
    zones = supported ? supported('timeZone') : [];
  } catch {
    zones = [];
  }
  return [...new Set([localTimeZone(), 'UTC', ...zones])].sort((a, b) => a.localeCompare(b));
}

export function shortDate(unixMs: number): string {
  return new Date(unixMs).toLocaleDateString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

export function dateAndTime(unixMs: number): string {
  return new Date(unixMs).toLocaleString([], {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}
