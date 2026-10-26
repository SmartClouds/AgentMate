import {
  applyJobEvent,
  buildChecklist,
  buildInstallPlan,
  buildUpdatePlan,
  collectConsents,
  compareVersions,
  type DevDetection,
  type DevItem,
  type DevItemId,
  type DevJobEvent,
  type DevJobState,
  type DevSetupEnvironment,
  type DevUpdateCheck,
  dependencyIds,
  displayName,
  EMPTY_JOB_STATE,
  getDevItem,
  type InstallIntent,
  type InstallMode,
  isDevItemId,
  itemsForStacks,
  meetsMinimum,
  normalizeDevSetupStacks,
  selectRecipe,
} from '@runova/core';
import type { CancelToken } from '../process/spawnStreaming';
import type { RunHooks, RunResult } from './runners/packageManagerRunner';

/**
 * Runs the installs the checklist asks for, one at a time, and reports what happens. The things it
 * is careful about are the ones that go wrong quietly: success is decided by looking again at the
 * machine rather than by an exit code, one failing step skips only what depends on it, and a
 * cancel really does stop the rest. The machine (processes, detection) is injected.
 */

/** What `install` throws when an agreement has not been accepted yet. */
export const CONSENT_REQUIRED = 'consent-required';

/** What `install` throws while a cancel is still stopping the run. Written for the page to show. */
export const CANCEL_IN_PROGRESS = 'The install is still stopping. Try again in a moment.';

export interface InstallStep {
  item: DevItem;
  mode: Extract<InstallMode, { mode: 'in-app' }>;
  /** Where the tool was found, for an update that has to run the copy the person already has. */
  path: string | null;
}

export interface InstallerDeps {
  environment: () => Promise<DevSetupEnvironment>;
  /** The stacks the person switched on. */
  stacks: () => Promise<string[]>;
  detect: (id: DevItemId, options?: { force?: boolean }) => Promise<DevDetection>;
  /** Whether newer versions exist. What is remembered is used unless `force` asks again. */
  checkUpdates: (
    ids: readonly DevItemId[],
    options?: { force?: boolean },
  ) => Promise<Record<DevItemId, DevUpdateCheck>>;
  /** Runs one in-app install and says how it went. */
  run: (step: InstallStep, hooks: RunHooks) => Promise<RunResult>;
  /** Picks up what the install changed: PATH, JAVA_HOME and the like. */
  afterInstall: () => Promise<void>;
  /** Marks the token cancelled and stops the process it belongs to. */
  cancelRun: (token: CancelToken) => void;
  emit: (event: DevJobEvent) => void;
  newJobId: () => string;
}

export interface InstallRequest {
  ids: readonly string[];
  /** The person accepted the agreements shown for the steps that carry one. */
  consented?: boolean;
  /** Absent means install. An update brings tools that are already there up to date. */
  intent?: InstallIntent;
}

export interface DevSetupInstaller {
  /** Plans the steps and starts them. Resolves once planned, not once finished. */
  install: (request: InstallRequest) => Promise<DevJobState>;
  /** With an id: take that waiting step out of the queue. Without: stop everything. */
  cancel: (id?: DevItemId) => void;
  jobState: () => DevJobState;
  /** Resolves when nothing is running. */
  whenIdle: () => Promise<void>;
  dispose: () => void;
}

function isInstalled(item: DevItem, detection: DevDetection): boolean {
  return detection.state === 'found' && meetsMinimum(detection.version, item.minVersion);
}

/** An update is proved by a higher version than the tool had before it ran. */
function versionRose(before: DevDetection, after: DevDetection): boolean {
  return (
    before.state === 'found' &&
    after.state === 'found' &&
    before.version !== null &&
    after.version !== null &&
    compareVersions(after.version, before.version) > 0
  );
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** Runs a stop that may already have nothing left to stop. */
function quietly(stop: () => void): void {
  try {
    stop();
  } catch {
    // Already stopped or closed, which is the state a cancel is after anyway.
  }
}

export function createDevSetupInstaller(deps: InstallerDeps): DevSetupInstaller {
  let state = EMPTY_JOB_STATE;
  const queue: DevItemId[] = [];
  let loop: Promise<void> | null = null;
  let cancelRequested = false;
  let currentToken: CancelToken | null = null;
  /** How the step that is running stops itself, when it is not just a process. */
  let currentAbort: (() => void) | null = null;

  function dispatch(event: DevJobEvent): void {
    state = applyJobEvent(state, event);
    deps.emit(event);
  }

  /**
   * Ends a step that was cancelled. It still gets a fresh look first: an install that was already
   * under way may have finished, and then the row should say so instead of staying as it was.
   */
  async function finishCancelled(
    jobId: string,
    item: DevItem,
    ran: RunResult | null,
    /** For an update: what the tool was before, since it is "installed" either way. */
    before?: DevDetection,
  ): Promise<void> {
    let installed = false;
    try {
      if (ran) await deps.afterInstall();
      const after = await deps.detect(item.id, { force: true });
      installed = before ? versionRose(before, after) : isInstalled(item, after);
    } catch {
      // The look is a courtesy, and failing to take it must not turn a cancel into an error.
    }
    if (installed) {
      dispatch({
        type: 'finished',
        jobId,
        itemId: item.id,
        result: 'installed',
        restartAdvised: ran?.restartAdvised === true,
      });
    } else {
      dispatch({ type: 'finished', jobId, itemId: item.id, result: 'cancelled' });
    }
  }

  async function runStep(jobId: string, id: DevItemId, failed: Set<DevItemId>): Promise<void> {
    const item = getDevItem(id);
    if (!item) return;
    // Running it again is a retry, so an earlier failure must not hold back what needs it.
    failed.delete(id);
    // What the step was planned as. An update must not take the "already installed" shortcut below,
    // since a tool that is being updated is always installed.
    const updating = state.items[id]?.intent === 'update';
    const environment = await deps.environment();
    const name = displayName(item, environment.os);

    const before = await deps.detect(id, { force: true });
    if (updating) {
      if (before.state !== 'found') {
        failed.add(id);
        dispatch({ type: 'started', jobId, itemId: id });
        dispatch({
          type: 'finished',
          jobId,
          itemId: id,
          result: 'failed',
          message: `${name} was not found, so there is nothing to update.`,
        });
        return;
      }
      // The list the person pressed Update on can be a while old. If it has been updated since,
      // there is nothing to do, and running the manager again would only say so.
      const fresh = (await deps.checkUpdates([id], { force: true }))[id];
      if (fresh?.state === 'current') {
        dispatch({ type: 'finished', jobId, itemId: id, result: 'installed' });
        return;
      }
    } else if (isInstalled(item, before)) {
      dispatch({ type: 'finished', jobId, itemId: id, result: 'installed' });
      return;
    }

    // A cancel during the two looks above found no token to stop. Nothing below waits before the
    // run starts, so after this check the token exists by the time anything can cancel.
    if (cancelRequested) {
      await finishCancelled(jobId, item, null);
      return;
    }

    const mode = selectRecipe(item, {
      ...environment,
      intent: updating || before.state === 'found' ? 'update' : 'install',
    });
    // Something this step needs did not install, so running it would only fail in a confusing way.
    if (dependencyIds(item, environment.os, mode).some((dependency) => failed.has(dependency))) {
      failed.add(id);
      dispatch({ type: 'finished', jobId, itemId: id, result: 'cancelled' });
      return;
    }

    dispatch({ type: 'started', jobId, itemId: id });

    if (mode.mode !== 'in-app') {
      failed.add(id);
      dispatch({
        type: 'finished',
        jobId,
        itemId: id,
        result: 'failed',
        message: 'This one needs a terminal or a download. Use the buttons on its row.',
      });
      return;
    }

    const token: CancelToken = { cancelled: false, child: null };
    currentToken = token;
    let result: RunResult;
    try {
      result = await deps.run(
        { item, mode, path: before.state === 'found' ? before.path : null },
        {
          token,
          onCancel: (abort) => {
            currentAbort = abort;
            // A cancel that came before the step could say how to stop it must still stop it.
            if (token.cancelled || cancelRequested) quietly(abort);
          },
          onProgress: (update) => dispatch({ type: 'progress', jobId, itemId: id, ...update }),
          onLine: (line) => dispatch({ type: 'log', jobId, itemId: id, line }),
        },
      );
    } catch (error) {
      result = { ok: false, code: null, cancelled: false, message: messageOf(error) };
    }
    currentToken = null;
    currentAbort = null;

    if (result.cancelled || cancelRequested) {
      await finishCancelled(jobId, item, result, updating ? before : undefined);
      return;
    }

    // The exit code is a hint. What counts is whether the tool can now be found.
    dispatch({ type: 'progress', jobId, itemId: id, phase: 'checking', fraction: null });
    await deps.afterInstall();
    const after = await deps.detect(id, { force: true });
    let worked = isInstalled(item, after);
    if (updating) {
      // Docker Desktop can move from 4.96.0 to 4.96.2 without its engine's version changing, so a
      // higher version is one proof and winget saying there is nothing newer is the other. If the
      // source cannot be asked, the exit code is all there is.
      const check = (await deps.checkUpdates([id], { force: true }))[id];
      worked =
        check?.state === 'unknown' || check === undefined
          ? result.ok && after.state === 'found'
          : check.state === 'current' || versionRose(before, after);
    }
    if (worked) {
      dispatch({
        type: 'finished',
        jobId,
        itemId: id,
        result: 'installed',
        restartAdvised: result.restartAdvised === true,
      });
      return;
    }

    failed.add(id);
    let message = result.message ?? 'The install did not finish.';
    if (result.ok) {
      if (updating) {
        const shown = after.state === 'found' ? (after.version ?? 'unknown') : 'unknown';
        message = `The update ran, but ${name} is still version ${shown}. Close anything that is using it, then check again.`;
      } else {
        message =
          after.state === 'found'
            ? `${name} is still version ${after.version ?? 'unknown'}. It needs ${item.minVersion ?? 'a newer version'} or newer.`
            : `The installer finished but ${name} was not found. Open a new terminal or restart Runova.`;
      }
    }
    dispatch({
      type: 'finished',
      jobId,
      itemId: id,
      result: 'failed',
      message,
      exitCode: result.code,
    });
  }

  async function processQueue(jobId: string): Promise<void> {
    const failed = new Set<DevItemId>();
    try {
      while (queue.length > 0) {
        const id = queue.shift();
        if (id === undefined) break;
        if (cancelRequested) {
          dispatch({ type: 'finished', jobId, itemId: id, result: 'cancelled' });
          continue;
        }
        try {
          await runStep(jobId, id, failed);
        } catch (error) {
          // A failed install is handled in runStep. This is something around it throwing, such as
          // a look at the machine, and it fails that step without stopping the rest.
          failed.add(id);
          dispatch({
            type: 'finished',
            jobId,
            itemId: id,
            result: 'failed',
            message: messageOf(error),
          });
        }
      }
      dispatch({ type: 'done', jobId, cancelled: cancelRequested });
    } finally {
      // Whatever ended the loop, the next request must find an installer that is free and not
      // still cancelling.
      cancelRequested = false;
      currentToken = null;
      currentAbort = null;
      queue.length = 0;
      loop = null;
    }
  }

  function cancelAll(): void {
    if (!loop) return;
    cancelRequested = true;
    if (currentToken) deps.cancelRun(currentToken);
    if (currentAbort) quietly(currentAbort);
  }

  /** A request made now would be added to the queue and then dropped by the cancel in progress. */
  function refuseWhileStopping(): void {
    if (cancelRequested) throw new Error(CANCEL_IN_PROGRESS);
  }

  return {
    async install({ ids, consented, intent }) {
      // Everything below is chosen from the catalog entry an id names, so an id that is not in it
      // stops here, whoever sent it.
      if (!Array.isArray(ids) || !ids.every(isDevItemId))
        throw new Error('Unknown dev setup item.');
      refuseWhileStopping();

      const [environment, savedStacks] = await Promise.all([deps.environment(), deps.stacks()]);
      // The request may name a tool from a stack that is switched off, so its stack is included.
      const stacks = normalizeDevSetupStacks([
        ...savedStacks,
        ...ids.map((id) => getDevItem(id)?.stack),
      ]);
      const items = itemsForStacks(stacks, environment.os);
      const detections = Object.fromEntries(
        await Promise.all(
          items.map(async (item) => [item.id, await deps.detect(item.id)] as const),
        ),
      );

      const updating = intent === 'update';
      // What is remembered about updates is enough to plan with: the page showed the person that
      // same list, and each step looks again before it runs.
      const updates = updating ? await deps.checkUpdates(ids) : undefined;
      const checklist = buildChecklist({
        stacks,
        environment,
        detections,
        jobs: state.items,
        updates,
      });
      // Steps already queued or running count as not needing work, so they are never planned twice.
      const steps = updating
        ? buildUpdatePlan(ids, checklist.entries).steps
        : buildInstallPlan(ids, checklist.entries, environment.os).steps;
      if (steps.length === 0) return state;
      // The cancel may have come while the checks above ran.
      refuseWhileStopping();

      // The agreements were accepted when the tool was installed, so an update does not ask again.
      if (!updating && collectConsents(steps).length > 0 && consented !== true) {
        throw new Error(CONSENT_REQUIRED);
      }

      // Decided here, after the awaits, so a run that ended in the meantime is not appended to.
      const appending = loop !== null && state.running;
      const jobId = appending && state.jobId ? state.jobId : deps.newJobId();
      queue.push(...steps);
      dispatch({ type: 'plan', jobId, steps, ...(updating ? { intent: 'update' as const } : {}) });
      if (!appending) loop = processQueue(jobId);
      return state;
    },
    cancel(id) {
      if (id !== undefined) {
        const index = queue.indexOf(id);
        if (index >= 0) {
          queue.splice(index, 1);
          dispatch({ type: 'finished', jobId: state.jobId ?? '', itemId: id, result: 'cancelled' });
          return;
        }
        if (state.current !== id) return;
      }
      cancelAll();
    },
    jobState: () => state,
    whenIdle: async () => {
      while (loop) await loop;
    },
    dispose: cancelAll,
  };
}
