import type { DeployPreflight, DeploySetupPhase, DeploySetupProgress } from '@shared/deployTypes';

/** How the wizard names each step, in the words of someone who never opened a terminal. */
export const SETUP_LABELS: Record<DeploySetupPhase, string> = {
  preflight: 'Check the server',
  fetch: 'Download the server core on the server',
  download: 'Get the server core',
  upload: 'Upload it to the server',
  verify: 'Verify the checksum on the server',
  group: 'Give your login access to the core',
  extract: 'Unpack the release',
  selinux: 'Label the files for SELinux',
  unit: 'Install the system service',
  switch: 'Switch to the new release',
  start: 'Start the core',
  cleanup: 'Tidy up old files',
  rollback: 'Go back to the previous release',
  health: 'Check that it answers',
  migrate: 'Move the core to its new name',
  owner: 'Set up your account on the core',
  enroll: 'Enroll this computer',
  'sign-in': 'Sign in',
  stop: 'Stop the core',
  remove: 'Remove its files',
};

export type TimelineStatus = 'pending' | DeploySetupProgress['status'];

export interface TimelineStep {
  phase: DeploySetupPhase;
  label: string;
  status: TimelineStatus;
  detail?: string;
  percent?: number;
}

/**
 * The steps an install goes through, in order, so the whole plan shows before it runs. A server
 * that can reach GitHub downloads the core itself; otherwise this app gets it and uploads it. If
 * the server's own download fails on the day, the install adds those two steps where they
 * happen. With an account, setting up this computer's access follows.
 */
export function installPhases(
  preflight: Pick<DeployPreflight, 'selinux' | 'serverDownload'>,
  withAccount = false,
): DeploySetupPhase[] {
  const selinux = preflight.selinux === 'enforcing' || preflight.selinux === 'permissive';
  return [
    'preflight',
    ...(preflight.serverDownload ? (['fetch'] as const) : (['download', 'upload'] as const)),
    'verify',
    'group',
    'extract',
    ...(selinux ? (['selinux'] as const) : []),
    'unit',
    'switch',
    'start',
    'cleanup',
    'health',
    ...(withAccount ? (['owner', 'enroll', 'sign-in'] as const) : []),
  ];
}

export const UNINSTALL_PHASES: DeploySetupPhase[] = ['stop', 'remove'];

/**
 * Folds progress into the planned steps: each step keeps its latest state, and a step that was
 * not planned (going back to the previous release) goes right after the step before it.
 */
export function timeline(
  planned: DeploySetupPhase[],
  events: DeploySetupProgress[],
): TimelineStep[] {
  const steps: TimelineStep[] = planned.map((phase) => ({
    phase,
    label: SETUP_LABELS[phase],
    status: 'pending',
  }));
  let last = -1;
  for (const event of events) {
    let index = steps.findIndex((step) => step.phase === event.phase);
    if (index < 0) {
      index = last + 1;
      steps.splice(index, 0, {
        phase: event.phase,
        label: SETUP_LABELS[event.phase],
        status: 'pending',
      });
    }
    const step = steps[index];
    steps[index] = {
      ...step,
      status: event.status,
      ...(event.detail === undefined ? {} : { detail: event.detail }),
      ...(event.percent === undefined ? {} : { percent: event.percent }),
    };
    last = index;
  }
  return steps;
}

/** How long a core has been up: "5 min", "2 h 5 min", "4 days 3 h". */
export function formatUptime(startedAtUnixMs: number, now = Date.now()): string {
  const minutes = Math.floor(Math.max(0, now - startedAtUnixMs) / 60_000);
  if (minutes < 1) return 'less than a minute';
  const days = Math.floor(minutes / 1_440);
  const hours = Math.floor((minutes % 1_440) / 60);
  const rest = minutes % 60;
  if (days > 0) {
    const dayText = `${days} ${days === 1 ? 'day' : 'days'}`;
    return hours > 0 ? `${dayText} ${hours} h` : dayText;
  }
  if (hours > 0) return rest > 0 ? `${hours} h ${rest} min` : `${hours} h`;
  return `${rest} min`;
}
