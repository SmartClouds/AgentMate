import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { type FilesErrorCode, filesError } from '../../../shared/deployFilesErrors';
import type {
  FilesChangesSnapshot,
  FilesDeployInput,
  FilesNeedsReview,
  FilesPlanChange,
  FilesPlanView,
  FilesRunResult,
} from '../../../shared/deployFilesTypes';
import { type AutoDeployDeps, type AutoDeploySite, createAutoDeploy } from './autoDeploy';
import type { ChangesSettledListener } from './changes';

/**
 * Deploy on save: waits for the folder to go quiet, runs one deploy per site at a time, and stops
 * for a person whenever the plan has a conflict, a mass delete or a first deploy, or the login,
 * host key, certificate or vault is in the way.
 */

const SITE = 'site1';

function site(overrides: Partial<AutoDeploySite> = {}): AutoDeploySite {
  return { id: SITE, deployOnSave: true, quietSeconds: 5, needsReview: null, ...overrides };
}

function snapshot(
  paths: string[],
  overrides: Partial<FilesChangesSnapshot> = {},
): FilesChangesSnapshot {
  return {
    siteId: SITE,
    computedAt: 1,
    state: 'ready',
    error: null,
    files: paths.map((path) => ({ path, change: 'modified', size: 10 })),
    totals: { added: 0, modified: paths.length, deleted: 0, bytes: paths.length * 10 },
    leftOut: [],
    leftOutTruncated: false,
    localFileCount: 10,
    baseFileCount: 10,
    firstDeploy: false,
    ...overrides,
  };
}

function change(path: string, overrides: Partial<FilesPlanChange> = {}): FilesPlanChange {
  return {
    path,
    local: 'modified',
    remote: 'unchanged',
    action: 'upload',
    conflict: null,
    size: 10,
    unverified: false,
    server: null,
    base: null,
    ...overrides,
  };
}

function plan(changes: FilesPlanChange[], overrides: Partial<FilesPlanView> = {}): FilesPlanView {
  return {
    planId: 'plan1',
    siteId: SITE,
    createdAt: 1,
    expiresAt: 600_001,
    changes,
    uploadBytes: 0,
    deleteCount: changes.filter((one) => one.action === 'deleteRemote').length,
    serverOnlyDrift: [],
    missingOnServer: [],
    firstDeploy: null,
    clockShiftHours: null,
    massDelete: false,
    notices: [],
    ...overrides,
  };
}

function result(overrides: Partial<FilesRunResult> = {}): FilesRunResult {
  return {
    runId: 'run1',
    siteId: SITE,
    trigger: 'deployOnSave',
    state: 'done',
    startedAt: 1,
    finishedAt: 2,
    uploaded: 1,
    deleted: 0,
    adopted: 0,
    skipped: 0,
    bytes: 10,
    failed: [],
    atomic: true,
    error: null,
    ...overrides,
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

function harness(initial: AutoDeploySite = site()) {
  const sites = new Map<string, AutoDeploySite>([[initial.id, initial]]);
  const snapshots = new Map<string, FilesChangesSnapshot>();
  const settled = new Set<ChangesSettledListener>();
  const unlocks = new Set<() => void>();
  const reviews: (FilesNeedsReview | null)[] = [];
  let nextPlan: () => Promise<FilesPlanView> = async () => plan([change('index.html')]);
  let nextDeploy: (input: FilesDeployInput) => Promise<FilesRunResult> = async () => result();

  const deps: AutoDeployDeps = {
    changes: {
      onSettled: vi.fn((listener: ChangesSettledListener) => {
        settled.add(listener);
        return () => {
          settled.delete(listener);
        };
      }),
      keepWatching: vi.fn(async () => undefined),
      snapshot: vi.fn((siteId: string) => snapshots.get(siteId) ?? null),
    },
    getSite: vi.fn(async (siteId: string) => sites.get(siteId) ?? null),
    plan: vi.fn(async () => nextPlan()),
    deploy: vi.fn(async (input: FilesDeployInput) => nextDeploy(input)),
    setNeedsReview: vi.fn(async (_siteId: string, review: FilesNeedsReview | null) => {
      reviews.push(review);
      return null;
    }),
    notify: vi.fn(),
    onVaultUnlocked: vi.fn((listener: () => void) => {
      unlocks.add(listener);
      return () => {
        unlocks.delete(listener);
      };
    }),
    setTimeout: (fn, ms) => setTimeout(fn, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
    now: () => 1000,
  };
  const auto = createAutoDeploy(deps);

  return {
    deps,
    auto,
    sites,
    reviews,
    settled,
    unlocks,
    /** The folder settled with these pending paths (or this whole snapshot). */
    settle(value: string[] | FilesChangesSnapshot) {
      const snap = Array.isArray(value) ? snapshot(value) : value;
      snapshots.set(snap.siteId, snap);
      for (const listener of settled) listener(snap.siteId, snap);
    },
    setSnapshot(snap: FilesChangesSnapshot) {
      snapshots.set(snap.siteId, snap);
    },
    planWith(fn: () => Promise<FilesPlanView>) {
      nextPlan = fn;
    },
    deployWith(fn: (input: FilesDeployInput) => Promise<FilesRunResult>) {
      nextDeploy = fn;
    },
    unlock() {
      for (const listener of unlocks) listener();
    },
    lastReview() {
      return reviews.at(-1);
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe('the quiet period', () => {
  it('waits for the quiet seconds, then plans and deploys every planned path', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    expect(h.deps.changes.keepWatching).toHaveBeenCalledWith(SITE, true);
    h.planWith(async () =>
      plan([change('a.html'), change('old.css', { local: 'deleted', action: 'deleteRemote' })]),
    );
    h.settle(['a.html', 'old.css']);

    await vi.advanceTimersByTimeAsync(4999);
    expect(h.deps.plan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.plan).toHaveBeenCalledWith(SITE);
    expect(h.deps.deploy).toHaveBeenCalledWith(
      {
        siteId: SITE,
        planId: 'plan1',
        paths: ['a.html', 'old.css'],
        conflicts: {},
        firstDeploy: null,
        reupload: [],
      },
      'deployOnSave',
    );
  });

  it('starts the quiet period over on every settle', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(4000);
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.deps.plan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('uses the quiet seconds given, and a changed value from siteUpdated', async () => {
    const h = harness(site({ quietSeconds: 10 }));
    await h.auto.enable(SITE, 10);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(9999);
    expect(h.deps.plan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);

    await h.auto.siteUpdated(site({ quietSeconds: 2 }));
    h.settle(['b.html']);
    await vi.advanceTimersByTimeAsync(2000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
  });

  it('falls back to five seconds for a quiet period that is not a number', async () => {
    const h = harness();
    await h.auto.enable(SITE, Number.NaN);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(4999);
    expect(h.deps.plan).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('ignores sites that are not enabled', async () => {
    const h = harness();
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
  });

  it('cancels the wait when nothing is pending any more', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(3000);
    h.settle([]);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
  });

  it('never deploys a folder that is missing, and cancels a wait already under way', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(3000);
    h.settle(snapshot([], { state: 'folderMissing' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
    expect(h.deps.deploy).not.toHaveBeenCalled();
  });

  it('does not act on a snapshot that failed or found too many files', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(snapshot(['a.html'], { state: 'error', error: 'Could not read the folder.' }));
    await vi.advanceTimersByTimeAsync(60_000);
    h.settle(snapshot(['a.html'], { state: 'tooManyFiles' }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
  });

  it('starts waiting on enable when changes are already pending', async () => {
    const h = harness();
    h.setSnapshot(snapshot(['a.html']));
    await h.auto.enable(SITE, 5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('hears the settle the first walk sends while keepWatching is still running', async () => {
    const h = harness();
    vi.mocked(h.deps.changes.keepWatching).mockImplementation(async () => {
      h.settle(['a.html']);
    });
    await h.auto.enable(SITE, 5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('does nothing when the plan has nothing to send', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => plan([]));
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
    expect(h.deps.deploy).not.toHaveBeenCalled();
  });

  it('stops quietly when the site is gone or Deploy on save was turned off in the store', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.sites.set(SITE, site({ deployOnSave: false }));
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).not.toHaveBeenCalled();
  });
});

describe('one run at a time', () => {
  it('marks the site dirty during a run and plans again after it', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    const run = deferred<FilesRunResult>();
    h.deployWith(() => run.promise);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);

    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);

    h.deployWith(async () => result());
    run.resolve(result());
    await vi.advanceTimersByTimeAsync(0);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.deploy).toHaveBeenCalledTimes(2);
  });

  it('does not plan again after a run when the changes it saw are all sent', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    const run = deferred<FilesRunResult>();
    h.deployWith(() => run.promise);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    h.settle(['a.html', 'b.html']);
    // The walk after the deploy finds nothing left.
    h.setSnapshot(snapshot([]));
    run.resolve(result());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('waits for a manual deploy that holds the site, then tries again after it', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.deployWith(async () => {
      throw filesError('busy', 'Another deploy of this site is running.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(10 * 60_000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.deps.setNeedsReview).not.toHaveBeenCalled();
    expect(h.deps.notify).not.toHaveBeenCalled();

    h.deployWith(async () => result());
    h.auto.runFinished(SITE, 'user', result({ trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(2);
  });

  it('does not plan while a manual deploy runs, and plans after it ends', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.auto.runStarted(SITE, 'user');
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
    h.auto.runFinished(SITE, 'user', result({ trigger: 'user', state: 'failed' }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('ignores the run hooks for its own runs', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.auto.runStarted(SITE, 'deployOnSave');
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('plans again once when the deploy finds the plan out of date', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    let calls = 0;
    h.deployWith(async () => {
      calls += 1;
      if (calls === 1) throw filesError('planExpired', 'The plan is too old.');
      return result();
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.deploy).toHaveBeenCalledTimes(2);
  });

  it('plans again once when the site was edited while it planned', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    let plans = 0;
    h.planWith(async () => {
      plans += 1;
      if (plans === 1) throw filesError('planExpired', 'The site was edited.');
      return plan([change('a.html')]);
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.reviews).toEqual([]);
  });

  it('plans again when the run found a file changed on the server, and stops on the conflict', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    let plans = 0;
    h.planWith(async () => {
      plans += 1;
      return plans === 1
        ? plan([change('a.html')])
        : plan([
            change('a.html', {
              action: 'conflict',
              conflict: 'changedOnServer',
              remote: 'changed',
            }),
          ]);
    });
    h.deployWith(async () =>
      result({
        state: 'failed',
        uploaded: 0,
        failed: [{ path: 'a.html', code: 'conflict', message: 'Changed on the server.' }],
      }),
    );
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.lastReview()).toMatchObject({ reason: 'conflicts' });
  });
});

describe('never on its own: conflicts, mass deletes and first deploys', () => {
  const conflicted = () =>
    plan([
      change('a.html'),
      change('b.html', { action: 'conflict', conflict: 'changedOnServer', remote: 'changed' }),
    ]);

  it('stops on a conflict, asks for a review and notifies once for the same set', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => conflicted());
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).not.toHaveBeenCalled();
    expect(h.lastReview()).toMatchObject({ reason: 'conflicts', at: 1000 });
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
    expect(h.deps.notify).toHaveBeenCalledWith(SITE, h.lastReview());

    h.settle(snapshot(['a.html', 'b.html'], { computedAt: 2 }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.deploy).not.toHaveBeenCalled();
    expect(h.deps.notify).toHaveBeenCalledTimes(1);

    h.planWith(async () =>
      plan([
        change('a.html', { action: 'conflict', conflict: 'existsOnServer', local: 'added' }),
        change('b.html', { action: 'conflict', conflict: 'changedOnServer', remote: 'changed' }),
      ]),
    );
    h.settle(['a.html', 'b.html', 'c.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).not.toHaveBeenCalled();
    expect(h.deps.notify).toHaveBeenCalledTimes(2);
  });

  it('stops on a mass delete', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    const deletes = Array.from({ length: 21 }, (_, i) =>
      change(`f${i}.html`, { local: 'deleted', action: 'deleteRemote' }),
    );
    h.planWith(async () => plan(deletes, { massDelete: true }));
    h.settle(deletes.map((one) => one.path));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).not.toHaveBeenCalled();
    expect(h.lastReview()).toMatchObject({ reason: 'massDelete' });
    expect(h.lastReview()?.message).toContain('21');
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('stops before a first deploy, which a person has to look at', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () =>
      plan([change('a.html')], { firstDeploy: { existing: 40, sameSize: 3 } }),
    );
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).not.toHaveBeenCalled();
    expect(h.lastReview()).toMatchObject({ reason: 'conflicts' });
    expect(h.lastReview()?.message).toMatch(/first deploy/i);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('stops without planning when the deploy folder is empty and files would be deleted', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(
      snapshot([], {
        files: [{ path: 'a.html', change: 'deleted', size: 10 }],
        totals: { added: 0, modified: 0, deleted: 1, bytes: 0 },
        localFileCount: 0,
      }),
    );
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).not.toHaveBeenCalled();
    expect(h.deps.deploy).not.toHaveBeenCalled();
    expect(h.lastReview()).toMatchObject({ reason: 'massDelete' });
  });

  it('clears a conflict review once nothing is pending any more', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => conflicted());
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()?.reason).toBe('conflicts');
    h.settle([]);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lastReview()).toBeNull();
  });
});

describe('pausing on login, trust and vault failures', () => {
  const PAUSE: FilesErrorCode[] = [
    'auth',
    'hostKeyUnknown',
    'hostKeyChanged',
    'tlsUntrusted',
    'tlsNameMismatch',
    'tlsUnavailable',
    'vaultLocked',
  ];

  it.each(PAUSE)('pauses on %s thrown by the plan', async (code) => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError(code, 'No.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()).toMatchObject({ reason: 'paused' });
    expect(h.deps.notify).toHaveBeenCalledTimes(1);

    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it.each(PAUSE)('pauses on %s thrown by the deploy', async (code) => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.deployWith(async () => {
      throw filesError(code, 'No.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()).toMatchObject({ reason: 'paused' });
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it.each(PAUSE)('pauses on %s in the run result', async (code) => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.deployWith(async () => result({ state: 'failed', error: { code, message: 'No.' } }));
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()).toMatchObject({ reason: 'paused' });
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('resumes when the site is updated', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('auth', 'Wrong password.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()?.reason).toBe('paused');

    h.planWith(async () => plan([change('a.html')]));
    await h.auto.siteUpdated(site({ needsReview: h.lastReview() ?? null }));
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.lastReview()).toBeNull();
  });

  it('resumes when Deploy on save is turned on again', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('hostKeyChanged', 'The key changed.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    h.planWith(async () => plan([change('a.html')]));
    await h.auto.enable(SITE, 5);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
  });

  it('tries once more when the vault unlocks, and pauses again if it is still locked', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('vaultLocked', 'The vault is locked.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);

    h.unlock();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);

    h.planWith(async () => plan([change('a.html')]));
    h.unlock();
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.lastReview()).toBeNull();
  });

  it('does not resume an auth pause when the vault unlocks', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('auth', 'Wrong password.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    h.unlock();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).toHaveBeenCalledTimes(1);
  });

  it('resumes after a manual deploy that worked', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('auth', 'Wrong password.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    h.auto.runStarted(SITE, 'user');
    h.auto.runFinished(SITE, 'user', result({ trigger: 'user' }));
    await vi.advanceTimersByTimeAsync(0);
    expect(h.lastReview()).toBeNull();

    h.planWith(async () => plan([change('b.html')]));
    h.settle(['b.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
  });
});

describe('other failures and success', () => {
  it('asks for a review on another failure and tries again on the next settle', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('unreachable', 'The server did not answer.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()).toMatchObject({ reason: 'failed' });
    expect(h.lastReview()?.message).toContain('The server did not answer.');
    expect(h.deps.notify).toHaveBeenCalledTimes(1);

    h.planWith(async () => plan([change('a.html')]));
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.lastReview()).toBeNull();
  });

  it('notifies once for the same failure over and over', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.planWith(async () => {
      throw filesError('timeout', 'The server took too long.');
    });
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    h.settle(['a.html', 'b.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.plan).toHaveBeenCalledTimes(2);
    expect(h.deps.notify).toHaveBeenCalledTimes(1);
  });

  it('asks for a review when some files failed', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.deployWith(async () =>
      result({
        state: 'partial',
        failed: [{ path: 'b.html', code: 'permissionDenied', message: 'Not allowed.' }],
      }),
    );
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.lastReview()).toMatchObject({ reason: 'failed' });
  });

  it('leaves a cancelled run alone', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.deployWith(async () => result({ state: 'cancelled' }));
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.setNeedsReview).not.toHaveBeenCalled();
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it('clears a review the site already had once a run succeeds', async () => {
    const h = harness(site({ needsReview: { reason: 'failed', message: 'Old failure.', at: 1 } }));
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.setNeedsReview).toHaveBeenCalledWith(SITE, null);
  });

  it('does not write the store after a success when there was nothing to clear', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.deps.deploy).toHaveBeenCalledTimes(1);
    expect(h.deps.setNeedsReview).not.toHaveBeenCalled();
  });

  it('writes review messages as plain sentences without an em dash', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    const failures: (() => Promise<FilesPlanView>)[] = [
      async () => plan([change('a', { action: 'conflict', conflict: 'deletedOnServer' })]),
      async () => plan([change('a')], { massDelete: true, deleteCount: 30 }),
      async () => plan([change('a')], { firstDeploy: { existing: 0, sameSize: 0 } }),
      async () => {
        throw filesError('server', 'Odd answer.');
      },
      ...(['auth', 'hostKeyUnknown', 'hostKeyChanged', 'tlsUntrusted'] as const).map(
        (code) => async () => {
          throw filesError(code, 'No.');
        },
      ),
    ];
    for (const [i, failure] of failures.entries()) {
      h.planWith(failure);
      await h.auto.enable(SITE, 5);
      h.settle([`f${i}`]);
      await vi.advanceTimersByTimeAsync(5000);
    }
    const messages = h.reviews.flatMap((review) => (review ? [review.message] : []));
    expect(messages.length).toBe(failures.length);
    for (const message of messages) {
      expect(message).not.toContain(String.fromCharCode(0x2014));
      expect(message).toMatch(/^[A-Z].*\.$/);
    }
  });
});

describe('enable, disable and closeAll', () => {
  it('disable cancels the wait, stops watching and clears the review', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(3000);
    await h.auto.disable(SITE);
    expect(h.deps.changes.keepWatching).toHaveBeenLastCalledWith(SITE, false);
    expect(h.deps.setNeedsReview).toHaveBeenCalledWith(SITE, null);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
  });

  it('a run that ends after disable changes nothing', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    const run = deferred<FilesRunResult>();
    h.deployWith(() => run.promise);
    h.settle(['a.html']);
    await vi.advanceTimersByTimeAsync(5000);
    await h.auto.disable(SITE);
    vi.mocked(h.deps.setNeedsReview).mockClear();
    run.resolve(result({ state: 'failed', error: { code: 'server', message: 'Odd.' } }));
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.setNeedsReview).not.toHaveBeenCalled();
    expect(h.deps.notify).not.toHaveBeenCalled();
  });

  it('siteUpdated with Deploy on save off disables, and on enables', async () => {
    const h = harness(site({ deployOnSave: false }));
    await h.auto.siteUpdated(site({ deployOnSave: true }));
    expect(h.deps.changes.keepWatching).toHaveBeenLastCalledWith(SITE, true);
    await h.auto.siteUpdated(site({ deployOnSave: false }));
    expect(h.deps.changes.keepWatching).toHaveBeenLastCalledWith(SITE, false);
  });

  it('siteUpdated for a site that stays off does nothing', async () => {
    const h = harness(site({ deployOnSave: false }));
    await h.auto.siteUpdated(site({ deployOnSave: false }));
    expect(h.deps.changes.keepWatching).not.toHaveBeenCalled();
    expect(h.deps.setNeedsReview).not.toHaveBeenCalled();
  });

  it('closeAll cancels every wait and stops listening', async () => {
    const h = harness();
    await h.auto.enable(SITE, 5);
    h.settle(['a.html']);
    h.auto.closeAll();
    expect(h.settled.size).toBe(0);
    expect(h.unlocks.size).toBe(0);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(h.deps.plan).not.toHaveBeenCalled();
  });
});
