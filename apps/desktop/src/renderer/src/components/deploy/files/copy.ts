import type {
  FileSiteLastDeploy,
  FilesLeftOutReason,
  FilesPendingFile,
  FilesPlanChange,
  FilesProgressEvent,
  FilesRunPhase,
  FilesRunResult,
  FilesRunTrigger,
} from '@shared/deployFilesTypes';
import { formatBytes } from '@/lib/format';
import type { FilesRunSample } from '@/stores/deployFilesRunStore';
import { RUN_STATE_LABEL } from './messages';

/**
 * The sentences the FTP and SFTP screens build from numbers (E23): counts, sizes, times, what
 * happened to a file on the server, and how fast a running deploy goes.
 */

export function plural(count: number, word: string): string {
  return `${count} ${count === 1 ? word : `${word}s`}`;
}

export function changeCountText(count: number): string {
  return plural(count, 'change');
}

/** "12 changes, 3.40 MB since the last deploy". */
export function changesSummaryText(count: number, bytes: number): string {
  const size = bytes > 0 ? `, ${formatBytes(bytes)}` : '';
  return `${changeCountText(count)}${size} since the last deploy`;
}

/** "Deploy 12 changes (3.40 MB)". */
export function deployButtonText(count: number, bytes: number): string {
  const size = bytes > 0 ? ` (${formatBytes(bytes)})` : '';
  return `Deploy ${changeCountText(count)}${size}`;
}

/** What a run did, zeros left out: "3 uploaded, 1 deleted, 2 skipped". */
export function runCountsText(result: FilesRunResult): string {
  const parts = [
    result.uploaded > 0 ? `${result.uploaded} uploaded` : null,
    result.deleted > 0 ? `${result.deleted} deleted` : null,
    result.adopted > 0 ? `${result.adopted} already there` : null,
    result.skipped > 0 ? `${result.skipped} skipped` : null,
    result.failed.length > 0 ? `${result.failed.length} failed` : null,
  ].filter(Boolean);
  return parts.length > 0 ? parts.join(', ') : 'Nothing to send';
}

export function durationText(ms: number): string {
  if (ms < 1000) return 'under a second';
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) {
    const rest = seconds % 60;
    return rest > 0 ? `${minutes} min ${rest} s` : `${minutes} min`;
  }
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
}

export function relativeTimeText(at: number, now = Date.now()): string {
  const seconds = Math.floor((now - at) / 1000);
  if (seconds < 60) return 'just now';
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} h ago`;
  const days = Math.floor(hours / 24);
  return days === 1 ? 'yesterday' : `${days} days ago`;
}

export const TRIGGER_LABEL: Record<FilesRunTrigger, string> = {
  user: 'You',
  deployOnSave: 'Deploy on save',
};

/** "Deployed 5 min ago", or how the last deploy ended when it did not go through. */
export function lastDeployText(last: FileSiteLastDeploy | null, now = Date.now()): string {
  if (!last) return 'Never deployed';
  const when = relativeTimeText(last.at, now);
  const by = last.trigger === 'deployOnSave' ? ' (Deploy on save)' : '';
  if (last.state === 'done') return `Deployed ${when}${by}`;
  return `Last deploy ${RUN_STATE_LABEL[last.state].toLowerCase()} ${when}${by}`;
}

export const CHANGE_LABEL: Record<FilesPendingFile['change'], string> = {
  added: 'Added',
  modified: 'Modified',
  deleted: 'Deleted',
};

export const LEFT_OUT_REASON: Record<FilesLeftOutReason, { label: string; detail: string }> = {
  hardDenied: {
    label: 'Never sent',
    detail:
      'Secrets, keys and version control folders never leave this computer, whatever the ignore lines say.',
  },
  agentFiles: {
    label: 'Agent files',
    detail: 'Agent settings, skills and Runova files stay on this computer.',
  },
  ignored: {
    label: 'Ignored',
    detail:
      "Left out by an ignore line: the defaults, the folder's .runovaignore or this site's own.",
  },
  symlink: {
    label: 'Link',
    detail: 'Links are not followed, so a link cannot send files from outside the deploy folder.',
  },
  tooLarge: { label: 'Too large', detail: 'Files this large are not sent.' },
  notUtf8: {
    label: 'Odd name',
    detail: 'The name is not valid text, so it would arrive broken on the server.',
  },
  caseCollision: {
    label: 'Same name',
    detail:
      'Another file has the same name in a different case. Many servers would treat them as one, so neither is sent.',
  },
  invalidPath: {
    label: 'Bad name',
    detail: 'The name has characters or parts a server path cannot hold.',
  },
};

export const PHASE_LABEL: Record<FilesRunPhase, string> = {
  connecting: 'Connecting',
  checking: 'Checking the server',
  folders: 'Making folders',
  uploading: 'Uploading',
  deleting: 'Deleting',
  cleaning: 'Cleaning up',
  done: 'Finishing',
};

export const NOTICE_TEXT = {
  sizeOnly:
    "This server doesn't give file times that can be compared, so changes made there are judged by size alone.",
  mdtmCapped:
    'There were too many files to ask the server for each time, so this check compared sizes only.',
  notAtomic:
    "This server can't replace a file in one step. For a moment during each upload, the old file is gone.",
  clockShift: (hours: number | null) =>
    hours === null
      ? "Every file time on the server moved by the same whole number of hours. That's the server's clock or a daylight saving change, not edits, so those files count as unchanged."
      : `Every file time on the server moved by ${plural(hours, 'hour')}. That's the server's clock or a daylight saving change, not edits, so those files count as unchanged.`,
} as const;

/** What happened to a file in conflict, in a sentence. */
export function conflictStory(change: FilesPlanChange): string {
  switch (change.conflict) {
    case 'changedOnServer':
      return change.local === 'deleted'
        ? 'Deleted here, but changed on the server since your last deploy.'
        : 'Changed on the server since your last deploy.';
    case 'existsOnServer':
      return 'Already on the server, and not from a deploy of yours.';
    case 'deletedOnServer':
      return 'Changed here, but deleted on the server.';
    default:
      return '';
  }
}

/** Bytes a second over the readings, once they span a second; null before that. */
export function transferRate(samples: readonly FilesRunSample[]): number | null {
  if (samples.length < 2) return null;
  const first = samples[0];
  const last = samples[samples.length - 1];
  const elapsed = last.at - first.at;
  if (elapsed < 1000) return null;
  return Math.max(0, ((last.bytes - first.bytes) / elapsed) * 1000);
}

export function timeLeftMs(progress: FilesProgressEvent, rate: number | null): number | null {
  if (!rate || rate <= 0) return null;
  const left = Math.max(0, progress.bytesTotal - progress.bytesDone);
  return (left / rate) * 1000;
}
