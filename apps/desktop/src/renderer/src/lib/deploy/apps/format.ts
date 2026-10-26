import type { ComposePortBinding, ComposeRisk, ComposeRiskSeverity } from '@runova/core';
import type {
  JobLogLine,
  StackDeployStep,
  StackPortBinding,
  StackRevisionState,
  StackStatus,
  StackStepKind,
  StackStepState,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';

/** Words and small calculations for a server's Apps: statuses, steps, ports and durations. */

export type Tone = 'success' | 'warning' | 'danger' | 'muted' | 'busy';

export const STATUS_TEXT: Record<StackStatus, string> = {
  new: 'Not deployed',
  busy: 'Working',
  running: 'Running',
  degraded: 'Degraded',
  stopped: 'Stopped',
  down: 'Taken down',
  failed: 'Failed',
};

export const STATUS_TONE: Record<StackStatus, Tone> = {
  new: 'muted',
  busy: 'busy',
  running: 'success',
  degraded: 'warning',
  stopped: 'muted',
  down: 'muted',
  failed: 'danger',
};

export const REVISION_TEXT: Record<StackRevisionState, string> = {
  awaitingContext: 'Waiting for files',
  ready: 'Ready',
  invalid: 'Invalid',
  deploying: 'Deploying',
  live: 'Live',
  failed: 'Failed',
  superseded: 'Replaced',
};

export const REVISION_TONE: Record<StackRevisionState, Tone> = {
  awaitingContext: 'muted',
  ready: 'muted',
  invalid: 'danger',
  deploying: 'busy',
  live: 'success',
  failed: 'danger',
  superseded: 'muted',
};

export const STEP_ORDER: readonly StackStepKind[] = ['validate', 'pull', 'build', 'up', 'health'];

export const STEP_TEXT: Record<StackStepKind, string> = {
  validate: 'Validate',
  pull: 'Pull images',
  build: 'Build',
  up: 'Start containers',
  health: 'Health check',
};

export const STEP_HINT: Record<StackStepKind, string> = {
  validate: 'docker compose config, the risk check and the loopback override',
  pull: 'Images the services run',
  build: 'Services built from the project',
  up: 'docker compose up --wait',
  health: 'Every container running and none unhealthy',
};

export const STEP_STATE_TEXT: Record<StackStepState, string> = {
  pending: 'Waiting',
  running: 'Running',
  succeeded: 'Done',
  failed: 'Failed',
  skipped: 'Skipped',
  cancelled: 'Cancelled',
};

export const SEVERITY_TEXT: Record<ComposeRiskSeverity, string> = {
  critical: 'Critical',
  high: 'High',
  medium: 'Medium',
  low: 'Low',
};

const SEVERITY_RANK: Record<ComposeRiskSeverity, number> = {
  critical: 0,
  high: 1,
  medium: 2,
  low: 3,
};

/** Worst first; the order the linter found them in otherwise. */
export function sortRisks<T extends { severity: ComposeRiskSeverity }>(risks: readonly T[]): T[] {
  return risks
    .map((risk, index) => ({ risk, index }))
    .sort(
      (a, b) =>
        SEVERITY_RANK[a.risk.severity] - SEVERITY_RANK[b.risk.severity] || a.index - b.index,
    )
    .map(({ risk }) => risk);
}

/** A risk the app needs a person to accept before it deploys (everything but low ones). */
export function needsAcknowledgment(risk: Pick<ComposeRisk, 'severity'>): boolean {
  return risk.severity !== 'low';
}

/** Every step in deploy order, with a pending entry for the ones the core has not reached yet. */
export function orderedSteps(steps: readonly StackDeployStep[]): StackDeployStep[] {
  return STEP_ORDER.map(
    (kind) => steps.find((step) => step.kind === kind) ?? { kind, state: 'pending' },
  );
}

/** The log lines a step wrote, by the sequence numbers the core recorded for it. */
export function linesOfStep(lines: readonly JobLogLine[], step: StackDeployStep): JobLogLine[] {
  if (step.firstLogSeq === undefined) return [];
  const first = step.firstLogSeq;
  const last = step.lastLogSeq ?? Number.POSITIVE_INFINITY;
  return lines.filter((line) => line.seq >= first && line.seq <= last);
}

/** "0.4 s", "12 s", "3 min 05 s", "1 h 02 min". */
export function formatDuration(ms: number): string {
  const safe = Math.max(0, ms);
  if (safe < 10_000) return `${(safe / 1000).toFixed(1)} s`;
  const seconds = Math.floor(safe / 1000);
  if (seconds < 60) return `${seconds} s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes} min ${String(seconds % 60).padStart(2, '0')} s`;
  return `${Math.floor(minutes / 60)} h ${String(minutes % 60).padStart(2, '0')} min`;
}

/** How long a step took, or has taken so far while it runs. Null before it starts. */
export function stepDuration(step: StackDeployStep, now: number): number | null {
  if (step.startedAtUnixMs === undefined) return null;
  return (step.finishedAtUnixMs ?? now) - step.startedAtUnixMs;
}

type AnyBinding =
  | Pick<ComposePortBinding, 'hostIp' | 'published' | 'target' | 'protocol'>
  | Pick<StackPortBinding, 'hostIp' | 'published' | 'target' | 'protocol'>;

/** Where a port is reachable from: the address it is published on, in words. */
export function bindingAddress(binding: AnyBinding): string {
  const host = binding.hostIp ?? null;
  if (host === null || host === '' || host === '0.0.0.0' || host === '::') return 'Every address';
  if (host === '127.0.0.1' || host === '::1') return 'This server only';
  return host;
}

/** Whether anyone outside the server can reach the port. */
export function isPublicBinding(binding: AnyBinding): boolean {
  return bindingAddress(binding) !== 'This server only';
}

/** "0.0.0.0:8080 -> 80/tcp" in a compact form: host side, then the container side. */
export function describeBinding(binding: AnyBinding): string {
  const host = binding.hostIp
    ? binding.hostIp.includes(':')
      ? `[${binding.hostIp}]`
      : binding.hostIp
    : '*';
  return `${host}:${binding.published ?? 'any'} → ${binding.target}/${binding.protocol}`;
}

/** An app name the server accepts, from a compose `name:` or a folder name. */
export function suggestAppName(source: string | null | undefined): string {
  const cleaned = (source ?? '')
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '-')
    .replace(/^[^a-z0-9]+/, '')
    .replace(/-+$/, '')
    .slice(0, 63);
  return cleaned;
}

/** The last folder of a path, either slash. */
export function folderName(path: string): string {
  const parts = path.split(/[\\/]+/).filter(Boolean);
  return parts.at(-1) ?? '';
}
