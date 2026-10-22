import { dsnDestination, ERROR_REPORTING_LEVELS } from '@shared/deploy/errorReportingValidation';
import type { DeployErrorReportingStatus } from '@shared/deployErrorReportingTypes';
import type { ChipTone } from '@/components/pageKit';

/** The words of the error reporting card, and what its state is called. */

export type ReportingStateKey = 'off' | 'paused' | 'waiting' | 'sending' | 'failing';

export interface ReportingState {
  key: ReportingStateKey;
  label: string;
  tone: ChipTone;
}

/** How reporting stands, as one word for a chip. A failure the core still holds beats a delivery. */
export function reportingState(status: DeployErrorReportingStatus): ReportingState {
  if (!status.configured) return { key: 'off', label: 'Not set up', tone: 'neutral' };
  if (!status.enabled) return { key: 'paused', label: 'Paused', tone: 'neutral' };
  if (status.lastError && (status.lastFailedAtUnixMs ?? 0) >= (status.lastSentAtUnixMs ?? 0)) {
    return { key: 'failing', label: 'Last send failed', tone: 'destructive' };
  }
  if (status.lastSentAtUnixMs !== undefined || status.sentCount > 0) {
    return { key: 'sending', label: 'Sending', tone: 'success' };
  }
  return { key: 'waiting', label: 'On, nothing sent yet', tone: 'primary' };
}

/** "o1.ingest.sentry.io, project 42", or nothing when there is no destination. Never the key. */
export function destinationOf(status: DeployErrorReportingStatus): string | null {
  return status.host && status.projectId
    ? dsnDestination({ authority: status.host, projectId: status.projectId })
    : null;
}

export function levelLabel(level: string): string {
  return (ERROR_REPORTING_LEVELS.find((item) => item.value === level) ?? ERROR_REPORTING_LEVELS[0])
    .label;
}

/** What to do in Sentry to get a DSN, for a server that has none yet. */
export const GET_A_DSN_STEPS: readonly string[] = [
  'In Sentry, open the project you want these logs in.',
  'Go to Project settings, then Client Keys (DSN), and copy the DSN.',
  'Paste it below and turn error reporting on.',
];

/** Said wherever the card promises what leaves the server, so the promise reads the same everywhere. */
export const PRIVACY_NOTE =
  'Passwords, tokens and keys are removed from every message before it leaves the server. Logs appear in your Sentry project under Logs. Sentry’s log intake is in beta, and a self-hosted Sentry needs a recent version.';
