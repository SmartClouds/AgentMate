import {
  type FilesErrorCode,
  filesErrorCode,
  filesErrorMessage,
} from '../../../shared/deployFilesErrors';
import type {
  FileSite,
  FilesChangesSnapshot,
  FilesDeployInput,
  FilesNeedsReview,
  FilesPlanView,
  FilesRunResult,
  FilesRunTrigger,
} from '../../../shared/deployFilesTypes';
import type { ChangesService } from './changes';

/**
 * Deploy on save for FTP and SFTP sites (E23). While it is on, a site's deploy folder stays
 * watched; once the pending changes have been quiet for the site's quiet seconds, it plans and
 * deploys everything the plan lists. One run per site at a time: a settle during a run marks the
 * site dirty and it waits for quiet again once the run ends.
 *
 * It never decides for a person. A plan with a conflict, a first deploy, or a mass delete (or an
 * empty deploy folder with deletes pending) stops with "Needs review" and one notification for
 * that set. A login, host key, certificate or locked-vault failure pauses the site until it is
 * updated or turned on again (a locked vault also resumes when it unlocks, with one try). Any
 * other failure asks for a review and tries again on the next settle.
 */

/** The parts of a site Deploy on save reads. */
export type AutoDeploySite = Pick<FileSite, 'id' | 'deployOnSave' | 'quietSeconds' | 'needsReview'>;

export interface AutoDeployDeps {
  changes: Pick<ChangesService, 'onSettled' | 'keepWatching' | 'snapshot'>;
  getSite: (siteId: string) => Promise<AutoDeploySite | null>;
  plan: (siteId: string) => Promise<FilesPlanView>;
  /** The service's deploy, locked per site: throws `[files:busy]` while another run holds it. */
  deploy: (input: FilesDeployInput, trigger: 'deployOnSave') => Promise<FilesRunResult>;
  /** Stores the review (null clears it) and tells the windows. */
  setNeedsReview: (siteId: string, review: FilesNeedsReview | null) => Promise<unknown>;
  /** The OS notification and the toast for a new review. */
  notify: (siteId: string, review: FilesNeedsReview) => void;
  onVaultUnlocked: (listener: () => void) => () => void;
  setTimeout: (fn: () => void, ms: number) => unknown;
  clearTimeout: (handle: unknown) => void;
  now: () => number;
}

export interface AutoDeploy {
  /** Turns Deploy on save on (or again, which also lifts a pause) and keeps the folder watched. */
  enable: (siteId: string, quietSeconds: number) => Promise<void>;
  /** Turns it off: no more waits or runs, the folder is let go, the review is cleared. */
  disable: (siteId: string) => Promise<void>;
  /**
   * The user changed the site (its settings, login, secret, trusted host key or certificate). Lifts
   * a pause. Not for the store writes Deploy on save makes itself, or a pause would never hold.
   */
  siteUpdated: (site: AutoDeploySite) => Promise<void>;
  /** A deploy is starting; a manual one holds the site, so Deploy on save waits for it. */
  runStarted: (siteId: string, trigger: FilesRunTrigger) => void;
  /** A deploy ended. A manual one that worked clears the review and lifts a pause. */
  runFinished: (siteId: string, trigger: FilesRunTrigger, result: FilesRunResult | null) => void;
  closeAll: () => void;
}

/** Matches the store's default quiet period. */
const QUIET_SECONDS_DEFAULT = 5;

/** Failures a retry cannot fix: someone has to fix the login, trust a key, or unlock the vault. */
const PAUSE_CODES: ReadonlySet<FilesErrorCode> = new Set<FilesErrorCode>([
  'auth',
  'hostKeyUnknown',
  'hostKeyChanged',
  'tlsUntrusted',
  'tlsNameMismatch',
  'tlsUnavailable',
  'vaultLocked',
]);

/** The deploy found the plan out of date: planning once more shows what changed. */
const REPLAN_CODES: ReadonlySet<FilesErrorCode> = new Set<FilesErrorCode>([
  'conflict',
  'planExpired',
]);

const PAUSE_MESSAGES: Partial<Record<FilesErrorCode, string>> = {
  auth: 'Deploy on save is paused because the server turned down the login. Fix the login with Edit to start it again.',
  hostKeyUnknown:
    "Deploy on save is paused because the server's host key is not trusted yet. Run Test connection and trust the key to start it again.",
  hostKeyChanged:
    'Deploy on save is paused because the server presented a different host key from the one you trusted. Check it with Test connection before you trust it.',
  tlsUntrusted:
    "Deploy on save is paused because the server's certificate is not trusted. Run Test connection to look at it.",
  tlsNameMismatch:
    "Deploy on save is paused because the server's certificate is for another name. Run Test connection to look at it.",
  tlsUnavailable:
    "Deploy on save is paused because the server does not offer TLS. Check the site's protocol to start it again.",
  vaultLocked:
    'Deploy on save is paused because your saved servers are locked with a passkey. It starts again when you unlock them.',
};

const TRY_AGAIN = 'It tries again after the next change.';

interface Watch {
  siteId: string;
  quietMs: number;
  timer: unknown;
  running: boolean;
  /** Settled during a run: wait for quiet again once it ends. */
  dirty: boolean;
  /** A manual deploy holds the site. */
  manual: boolean;
  /** Wanted to run while a manual deploy held the site: try once it ends. */
  waiting: boolean;
  paused: FilesErrorCode | null;
  /** The site has a review in the store, as far as this knows. */
  hasReview: boolean;
  /** What the last review was about, so the same one is not stored and notified again. */
  reviewKey: string | null;
  latest: FilesChangesSnapshot | null;
}

interface Stop {
  reason: FilesNeedsReview['reason'];
  message: string;
  key: string;
}

function quietMsOf(seconds: number): number {
  const value = Number.isFinite(seconds) && seconds > 0 ? seconds : QUIET_SECONDS_DEFAULT;
  return value * 1000;
}

function files(count: number): string {
  return count === 1 ? '1 file' : `${count} files`;
}

/** A detail from an error, as a sentence that ends with a full stop, or nothing. */
function sentence(text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return '';
  return /[.!?]$/.test(trimmed) ? trimmed : `${trimmed}.`;
}

function failedMessage(detail: string): string {
  return ['Deploy on save could not finish.', sentence(detail), TRY_AGAIN]
    .filter(Boolean)
    .join(' ');
}

function pendingOf(snapshot: FilesChangesSnapshot | null): boolean {
  return snapshot?.state === 'ready' && snapshot.files.length > 0;
}

/** What in a plan a person has to look at before it is sent, or null when it can go. */
function stopFor(plan: FilesPlanView): Stop | null {
  if (plan.firstDeploy) {
    const { existing } = plan.firstDeploy;
    const already = existing > 0 ? ` and the server folder already has ${files(existing)}` : '';
    return {
      // A first deploy over files already there is a decision, like a conflict.
      reason: 'conflicts',
      message: `Deploy on save stopped because this is the site's first deploy${already}. Review the first deploy and send it by hand.`,
      key: `firstDeploy:${existing}:${plan.firstDeploy.sameSize}`,
    };
  }
  const conflicts = plan.changes
    .filter((change) => change.action === 'conflict')
    .map((change) => `${change.path}\n${change.conflict ?? ''}`)
    .sort();
  if (conflicts.length > 0) {
    const verb = conflicts.length === 1 ? 'conflicts' : 'conflict';
    return {
      reason: 'conflicts',
      message: `Deploy on save stopped because ${files(conflicts.length)} ${verb} with what is on the server. Review them and deploy by hand.`,
      key: `conflicts:${JSON.stringify(conflicts)}`,
    };
  }
  if (plan.massDelete) {
    const deletes = plan.changes
      .filter((change) => change.action === 'deleteRemote')
      .map((change) => change.path)
      .sort();
    return {
      reason: 'massDelete',
      message: `Deploy on save stopped because it would delete ${files(plan.deleteCount)} on the server. Review the deletes and deploy by hand.`,
      key: `massDelete:${plan.deleteCount}:${JSON.stringify(deletes)}`,
    };
  }
  return null;
}

export function createAutoDeploy(deps: AutoDeployDeps): AutoDeploy {
  const watches = new Map<string, Watch>();

  function live(watch: Watch): boolean {
    return watches.get(watch.siteId) === watch;
  }

  function cancelTimer(watch: Watch): void {
    if (watch.timer === null) return;
    deps.clearTimeout(watch.timer);
    watch.timer = null;
  }

  function startTimer(watch: Watch): void {
    cancelTimer(watch);
    watch.timer = deps.setTimeout(() => {
      watch.timer = null;
      void attempt(watch);
    }, watch.quietMs);
  }

  function latestOf(watch: Watch): FilesChangesSnapshot | null {
    return deps.changes.snapshot(watch.siteId) ?? watch.latest;
  }

  async function clearReview(watch: Watch): Promise<void> {
    watch.reviewKey = null;
    if (!watch.hasReview) return;
    watch.hasReview = false;
    try {
      await deps.setNeedsReview(watch.siteId, null);
    } catch {
      // The site may be gone; the next review writes again.
    }
  }

  async function review(watch: Watch, stop: Stop): Promise<void> {
    if (!live(watch) || watch.reviewKey === stop.key) return;
    watch.reviewKey = stop.key;
    watch.hasReview = true;
    const needsReview: FilesNeedsReview = {
      reason: stop.reason,
      message: stop.message,
      at: deps.now(),
    };
    try {
      await deps.setNeedsReview(watch.siteId, needsReview);
    } catch {
      // Still worth telling the user, even if the store could not keep it.
    }
    if (!live(watch)) return;
    try {
      deps.notify(watch.siteId, needsReview);
    } catch {
      // A notification that failed must not stop Deploy on save.
    }
  }

  /** Picks up again after a pause or a wait: a pending list waits for quiet, none clears. */
  function resume(watch: Watch): void {
    if (!live(watch) || watch.paused || watch.running) return;
    const latest = latestOf(watch);
    if (pendingOf(latest)) startTimer(watch);
    else if (latest?.state === 'ready') void clearReview(watch);
  }

  async function failed(watch: Watch, code: FilesErrorCode | null, detail: string): Promise<void> {
    if (code === 'busy') {
      watch.waiting = true;
      return;
    }
    if (code === 'cancelled') return;
    if (code && PAUSE_CODES.has(code)) {
      watch.paused = code;
      await review(watch, {
        reason: 'paused',
        message: PAUSE_MESSAGES[code] ?? failedMessage(detail),
        key: `paused:${code}`,
      });
      return;
    }
    await review(watch, {
      reason: 'failed',
      message: failedMessage(detail),
      key: `failed:${code ?? 'unknown'}`,
    });
  }

  /** What a finished run means for the site; true when the plan was out of date. */
  async function finished(watch: Watch, result: FilesRunResult, replan: boolean): Promise<boolean> {
    const code = result.error?.code ?? null;
    if (replan && code && REPLAN_CODES.has(code)) return true;
    // Files changed on the server since the plan were left alone; the next plan shows them as
    // conflicts, which stop for a person.
    if (
      replan &&
      !code &&
      result.failed.length > 0 &&
      result.failed.every((failure) => failure.code === 'conflict')
    ) {
      return true;
    }
    if (result.state === 'done') {
      await clearReview(watch);
      return false;
    }
    if (result.state === 'cancelled') return false;
    if (code) {
      await failed(watch, code, result.error?.message ?? '');
      return false;
    }
    const detail =
      result.failed.length > 0 ? `${files(result.failed.length)} could not be sent.` : '';
    await failed(watch, null, detail);
    return false;
  }

  async function cycle(watch: Watch): Promise<void> {
    const site = await deps.getSite(watch.siteId);
    if (!live(watch)) return;
    if (!site?.deployOnSave) {
      cancelTimer(watch);
      return;
    }
    if (site.needsReview) watch.hasReview = true;

    const latest = latestOf(watch);
    if (latest && !pendingOf(latest)) return;
    if (latest && latest.localFileCount === 0 && latest.totals.deleted > 0) {
      // An empty deploy folder is more likely unmounted or swapped than meant to wipe the server.
      await review(watch, {
        reason: 'massDelete',
        message: `Deploy on save stopped because the deploy folder is empty, and deploying would delete ${files(latest.totals.deleted)} on the server. Check the folder, then deploy by hand.`,
        key: `emptyFolder:${latest.totals.deleted}`,
      });
      return;
    }

    for (let round = 0; round < 2; round += 1) {
      const replan = round === 0;
      let plan: FilesPlanView;
      try {
        plan = await deps.plan(watch.siteId);
      } catch (error) {
        // Edited while it planned: the plan after the edit is the one to judge.
        const code = filesErrorCode(error);
        if (replan && code && REPLAN_CODES.has(code)) continue;
        throw error;
      }
      if (!live(watch)) return;
      const stop = stopFor(plan);
      if (stop) {
        await review(watch, stop);
        return;
      }
      const paths = plan.changes.map((change) => change.path);
      if (paths.length === 0) return;
      let result: FilesRunResult;
      try {
        result = await deps.deploy(
          {
            siteId: watch.siteId,
            planId: plan.planId,
            paths,
            conflicts: {},
            // Files the server lost and first-deploy choices are a person's call.
            firstDeploy: null,
            reupload: [],
          },
          'deployOnSave',
        );
      } catch (error) {
        const code = filesErrorCode(error);
        if (replan && code && REPLAN_CODES.has(code)) continue;
        throw error;
      }
      if (!live(watch)) return;
      if (!(await finished(watch, result, replan))) return;
    }
  }

  async function attempt(watch: Watch): Promise<void> {
    if (!live(watch) || watch.running || watch.paused) return;
    if (watch.manual) {
      watch.waiting = true;
      return;
    }
    watch.running = true;
    watch.dirty = false;
    watch.waiting = false;
    try {
      await cycle(watch);
    } catch (error) {
      if (live(watch)) await failed(watch, filesErrorCode(error), filesErrorMessage(error));
    } finally {
      watch.running = false;
    }
    if (live(watch) && watch.dirty) {
      watch.dirty = false;
      resume(watch);
    }
  }

  const stopSettled = deps.changes.onSettled((siteId, snapshot) => {
    const watch = watches.get(siteId);
    if (!watch) return;
    watch.latest = snapshot;
    if (watch.paused) return;
    if (watch.running) {
      watch.dirty = true;
      return;
    }
    if (pendingOf(snapshot)) {
      startTimer(watch);
      return;
    }
    // Nothing to send, or a folder that is missing or could not be read: never deploy that.
    cancelTimer(watch);
    if (snapshot.state === 'ready') void clearReview(watch);
  });

  const stopUnlocked = deps.onVaultUnlocked(() => {
    for (const watch of watches.values()) {
      if (watch.paused !== 'vaultLocked') continue;
      watch.paused = null;
      watch.reviewKey = null;
      resume(watch);
    }
  });

  async function enable(siteId: string, quietSeconds: number): Promise<void> {
    let watch = watches.get(siteId);
    if (!watch) {
      watch = {
        siteId,
        quietMs: quietMsOf(quietSeconds),
        timer: null,
        running: false,
        dirty: false,
        manual: false,
        waiting: false,
        paused: null,
        hasReview: false,
        reviewKey: null,
        latest: null,
      };
      watches.set(siteId, watch);
    }
    watch.quietMs = quietMsOf(quietSeconds);
    watch.paused = null;
    watch.reviewKey = null;
    const site = await deps.getSite(siteId);
    if (site?.needsReview) watch.hasReview = true;
    await deps.changes.keepWatching(siteId, true);
    resume(watch);
  }

  async function disable(siteId: string): Promise<void> {
    const watch = watches.get(siteId);
    if (watch) {
      cancelTimer(watch);
      watches.delete(siteId);
    }
    await deps.changes.keepWatching(siteId, false);
    try {
      await deps.setNeedsReview(siteId, null);
    } catch {
      // A site that is gone has no review to clear.
    }
  }

  return {
    enable,

    disable,

    async siteUpdated(site) {
      const watch = watches.get(site.id);
      if (!site.deployOnSave) {
        if (watch || site.needsReview) await disable(site.id);
        return;
      }
      if (!watch) {
        await enable(site.id, site.quietSeconds);
        return;
      }
      watch.quietMs = quietMsOf(site.quietSeconds);
      if (site.needsReview) watch.hasReview = true;
      if (watch.paused) {
        watch.paused = null;
        watch.reviewKey = null;
        resume(watch);
      }
    },

    runStarted(siteId, trigger) {
      if (trigger === 'deployOnSave') return;
      const watch = watches.get(siteId);
      if (watch) watch.manual = true;
    },

    runFinished(siteId, trigger, result) {
      if (trigger === 'deployOnSave') return;
      const watch = watches.get(siteId);
      if (!watch) return;
      watch.manual = false;
      if (result?.state === 'done') {
        // A deploy that worked by hand: the login works and what needed a look was seen to.
        watch.paused = null;
        void clearReview(watch);
      }
      if (watch.waiting) {
        watch.waiting = false;
        resume(watch);
      }
    },

    closeAll() {
      for (const watch of watches.values()) cancelTimer(watch);
      watches.clear();
      stopSettled();
      stopUnlocked();
    },
  };
}
