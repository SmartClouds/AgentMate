import { applicableDependencies } from './catalog.js';
import type { InstallMode } from './recipes.js';
import type {
  DevDetection,
  DevItem,
  DevItemId,
  DevItemJob,
  DevItemState,
  DevItemUpdate,
  DevOs,
  DevUpdateCheck,
} from './types.js';
import { resolveItemUpdate } from './updates.js';
import { meetsMinimum } from './version.js';

/**
 * Working out which of a dozen states a checklist row is in. The answer comes from three places:
 * what the last probe found, what the installer is doing right now, and whether the things this
 * item needs are in place. Keeping that here, away from React, is what lets every row state be
 * tested without rendering anything.
 */

export interface DeriveItemStateInput {
  item: DevItem;
  os: DevOs;
  /** What the app would do to install it, from `selectRecipe`. */
  mode: InstallMode;
  /** Undefined while the probe has not answered. */
  detection: DevDetection | undefined;
  job?: DevItemJob;
  /** Whether another item is installed. Undefined means that item has not been checked yet. */
  readiness: (id: DevItemId) => boolean | undefined;
  /** What the update check found for this item. Undefined until it has answered, or when it never asks. */
  update?: DevUpdateCheck;
}

/**
 * An installed row, with the update the source offers when there is one. A newer version never
 * makes the row not ready: it is the same tool doing the same job, just not the latest build.
 */
function installedState(
  detection: Extract<DevDetection, { state: 'found' }>,
  check: DevUpdateCheck | undefined,
  job: DevItemJob | undefined,
): DevItemState {
  const state: DevItemState = {
    kind: 'installed',
    version: detection.version,
    onPath: detection.onPath,
  };
  const offer = resolveItemUpdate(detection.version, check);
  if (!offer) return state;
  const update: DevItemUpdate = { ...offer };
  if (job?.status === 'waiting-terminal') update.waiting = true;
  // Only an update that failed is the row's business. A failed install from before is cleared by
  // the tool being there now, as it always was.
  if (job?.status === 'failed' && job.intent === 'update') {
    update.failure = job.message ?? 'The update did not finish.';
  }
  return { ...state, update };
}

export function isReady(state: DevItemState): boolean {
  return state.kind === 'installed';
}

/**
 * Everything that has to be installed before this item can be: its declared dependencies on this
 * OS, whatever the chosen recipe runs through (Homebrew), and the parent it arrives with.
 */
export function dependencyIds(
  item: DevItem,
  os: DevOs,
  mode: InstallMode,
  lookup?: (id: DevItemId) => DevItem | undefined,
): DevItemId[] {
  const ids = [...applicableDependencies(item, os, lookup)];
  if (mode.mode === 'in-app' || mode.mode === 'terminal') ids.push(...mode.implies);
  if (mode.mode === 'bundled') ids.push(mode.with);
  return [...new Set(ids)];
}

export function deriveItemState(input: DeriveItemStateInput): DevItemState {
  const { item, os, mode, detection, job, readiness } = input;

  // An install that is running or queued is the truth about this row, whatever the last probe said.
  if (job?.status === 'installing') {
    return {
      kind: 'installing',
      phase: job.phase ?? 'installing',
      fraction: job.fraction ?? null,
      detail: job.detail ?? null,
      ...(job.intent ? { intent: job.intent } : {}),
    };
  }
  if (job?.status === 'queued')
    return { kind: 'queued', ...(job.intent ? { intent: job.intent } : {}) };

  if (!detection) return { kind: 'checking' };
  if (detection.state === 'error') return { kind: 'unknown', message: detection.message };

  if (detection.state === 'found' && meetsMinimum(detection.version, item.minVersion)) {
    // Found and good enough clears any earlier failure or wait: the tool is simply there now.
    return installedState(detection, input.update, job);
  }

  if (job?.status === 'failed') {
    return {
      kind: 'failed',
      message: job.message ?? 'The install did not finish.',
      exitCode: job.exitCode ?? null,
    };
  }
  if (job?.status === 'waiting-terminal') return { kind: 'waiting-terminal' };

  if (mode.mode === 'unavailable') return { kind: 'unavailable' };

  const waitingFor: DevItemId[] = [];
  for (const id of dependencyIds(item, os, mode)) {
    const ready = readiness(id);
    // Not knowing yet is not the same as not being installed. Wait for the answer rather than
    // flash "blocked" at a row that is about to turn out fine.
    if (ready === undefined) return { kind: 'checking' };
    if (!ready) waitingFor.push(id);
  }
  if (waitingFor.length > 0) {
    const via =
      mode.mode === 'bundled' && waitingFor.includes(mode.with) ? 'bundled' : 'dependency';
    return { kind: 'blocked', waitingFor, via };
  }

  if (detection.state === 'found') {
    return { kind: 'outdated', version: detection.version, minVersion: item.minVersion ?? '' };
  }
  return { kind: 'missing' };
}
