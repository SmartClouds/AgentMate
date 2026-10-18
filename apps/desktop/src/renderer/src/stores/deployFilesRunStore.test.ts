import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  plan,
  progressEvent,
  runResult,
  SITE_ID,
} from '@/components/deploy/files/testing/fixtures';
import { EMPTY_SITE_RUN, selectSiteRun, useDeployFilesRunStore } from './deployFilesRunStore';

/**
 * A deploy to an FTP or SFTP site keeps running in main when the page is left, and a Deploy on
 * save run starts with nobody on the page at all. Its review, progress and outcome live here, per
 * site, so the Deploy page and a project's Deploy tab pick up where it got to.
 */

const store = useDeployFilesRunStore;

function run(siteId = SITE_ID) {
  return selectSiteRun(siteId)(store.getState());
}

beforeEach(() => {
  store.setState(store.getInitialState(), true);
  vi.useFakeTimers();
  vi.setSystemTime(new Date('2026-10-18T10:00:00Z'));
});

afterEach(() => {
  vi.useRealTimers();
});

describe('deployFilesRunStore review', () => {
  it('starts every site empty, with the same object so selectors stay still', () => {
    expect(run()).toBe(EMPTY_SITE_RUN);
    expect(run('other')).toBe(EMPTY_SITE_RUN);
  });

  it('marks the check of the server and keeps the plan it brings back', () => {
    store.getState().setPlanning(SITE_ID, true);
    expect(run().planning).toBe(true);

    const view = plan({ firstDeploy: { existing: 214, sameSize: 200 } });
    store.getState().setReview(SITE_ID, view, null);
    expect(run().planning).toBe(false);
    expect(run().review?.plan).toBe(view);
    expect(run().review?.firstDeploy).toBe('adoptSameSize');
    expect(run().review?.conflicts).toEqual({});
    expect(run().review?.reupload).toEqual([]);
  });

  it('sets an Upload choice for a file deleted on the server, and none for the other conflicts', () => {
    const view = plan({
      changes: [
        {
          ...plan().changes[0],
          path: 'a.html',
          action: 'conflict',
          conflict: 'deletedOnServer',
        },
        { ...plan().changes[0], path: 'b.html', action: 'conflict', conflict: 'changedOnServer' },
      ],
    });
    store.getState().setReview(SITE_ID, view, null);
    expect(run().review?.conflicts).toEqual({ 'a.html': 'overwrite' });
    expect(run().review?.firstDeploy).toBeNull();
  });

  it('keeps the paths a retry is limited to', () => {
    store.getState().setReview(SITE_ID, plan(), ['index.html']);
    expect(run().review?.only).toEqual(['index.html']);
  });

  it('records the choices made in the review', () => {
    store.getState().setReview(SITE_ID, plan(), null);
    store.getState().chooseConflicts(SITE_ID, { 'index.html': 'skip' });
    store.getState().chooseConflicts(SITE_ID, { 'css/site.css': 'overwrite' });
    store.getState().chooseFirstDeploy(SITE_ID, 'overwrite');
    store.getState().setReupload(SITE_ID, ['gone.txt']);

    expect(run().review?.conflicts).toEqual({ 'index.html': 'skip', 'css/site.css': 'overwrite' });
    expect(run().review?.firstDeploy).toBe('overwrite');
    expect(run().review?.reupload).toEqual(['gone.txt']);
  });

  it('ignores choices when there is no review', () => {
    store.getState().chooseConflicts(SITE_ID, { 'index.html': 'skip' });
    store.getState().chooseFirstDeploy(SITE_ID, 'overwrite');
    store.getState().setReupload(SITE_ID, ['x']);
    expect(run().review).toBeNull();
  });

  it('drops the review and says why when the check fails', () => {
    store.getState().setReview(SITE_ID, plan(), null);
    store
      .getState()
      .setProblem(SITE_ID, { message: 'The server is out of space.', code: 'diskFull' });
    expect(run().problem).toEqual({ message: 'The server is out of space.', code: 'diskFull' });
    expect(run().planning).toBe(false);

    store.getState().setPlanning(SITE_ID, true);
    expect(run().problem).toBeNull();
    store.getState().clearReview(SITE_ID);
    expect(run().review).toBeNull();
  });
});

describe('deployFilesRunStore ticks and requests', () => {
  it('keeps the unticked files per site, so they survive the panel going away', () => {
    expect(run().deselected.size).toBe(0);
    store.getState().setDeselected(SITE_ID, new Set(['a.html']));
    expect([...run().deselected]).toEqual(['a.html']);
    expect(run('other').deselected.size).toBe(0);
    store.getState().forget(SITE_ID);
    expect(run().deselected.size).toBe(0);
  });

  it('holds a request to check the server until it is taken, once', () => {
    store.getState().requestStart(SITE_ID);
    expect(run().startRequested).toBe(true);
    expect(store.getState().takeStartRequest(SITE_ID)).toBe(true);
    expect(run().startRequested).toBe(false);
    expect(store.getState().takeStartRequest(SITE_ID)).toBe(false);
  });
});

describe('deployFilesRunStore runs', () => {
  it('starts a run from the review with its notes and no review left', () => {
    store
      .getState()
      .setReview(SITE_ID, plan({ notices: ['notAtomic'], serverOnlyDrift: ['x'] }), null);
    store.getState().begin(SITE_ID, { notices: ['notAtomic'], drift: ['x'] });

    expect(run().review).toBeNull();
    expect(run().starting).toBe(true);
    expect(run().startedAt).toBe(Date.now());
    expect(run().notes).toEqual({ notices: ['notAtomic'], drift: ['x'] });
  });

  it('collects progress for its own site, stamped as it arrives', () => {
    store.getState().begin(SITE_ID, null);
    store.getState().progress(progressEvent({ bytesDone: 0 }));
    vi.advanceTimersByTime(2000);
    store.getState().progress(progressEvent({ bytesDone: 4096 }));
    store.getState().progress(progressEvent({ siteId: 'other', bytesDone: 1 }));

    expect(run().starting).toBe(false);
    expect(run().progress?.bytesDone).toBe(4096);
    expect(run().samples.map((sample) => sample.bytes)).toEqual([0, 4096]);
    expect(run('other').progress?.bytesDone).toBe(1);
  });

  it('keeps only the recent samples', () => {
    store.getState().begin(SITE_ID, null);
    for (let index = 0; index < 40; index += 1) {
      store.getState().progress(progressEvent({ bytesDone: index }));
      vi.advanceTimersByTime(1000);
    }
    expect(run().samples.length).toBeLessThanOrEqual(12);
    expect(run().samples.at(-1)?.bytes).toBe(39);
  });

  it('picks up a run nobody started from here, like Deploy on save', () => {
    store.getState().progress(progressEvent({ trigger: 'deployOnSave' }));
    expect(run().progress?.trigger).toBe('deployOnSave');
    expect(run().startedAt).toBe(Date.now());
  });

  it('drops an open review when a run starts elsewhere, since its plan is stale', () => {
    store.getState().setReview(SITE_ID, plan(), null);
    store.getState().progress(progressEvent({ trigger: 'deployOnSave' }));
    expect(run().review).toBeNull();
    expect(run().planning).toBe(false);
  });

  it('starts over when progress for a new run comes after an outcome', () => {
    store.getState().finish(runResult());
    store.getState().progress(progressEvent({ runId: 'run-2' }));
    expect(run().result).toBeNull();
    expect(run().progress?.runId).toBe('run-2');
  });

  it('ignores late progress from the run that already finished', () => {
    store.getState().progress(progressEvent());
    store.getState().finish(runResult());
    store.getState().progress(progressEvent({ bytesDone: 1 }));
    expect(run().result?.runId).toBe('run-1');
    expect(run().progress).toBeNull();
  });

  it('takes an outcome once, whether it comes from the event or the call', () => {
    store.getState().begin(SITE_ID, null);
    store.getState().progress(progressEvent());
    expect(store.getState().finish(runResult())).toBe(true);
    expect(store.getState().finish(runResult())).toBe(false);

    expect(run().result?.state).toBe('done');
    expect(run().progress).toBeNull();
    expect(run().starting).toBe(false);
  });

  it('stops waiting when the deploy call fails before anything ran', () => {
    store.getState().begin(SITE_ID, null);
    store.getState().failStart(SITE_ID, { message: 'busy', code: 'busy' });
    expect(run().starting).toBe(false);
    expect(run().problem).toEqual({ message: 'busy', code: 'busy' });
  });

  it('puts the outcome away when it is dismissed', () => {
    store.getState().finish(runResult());
    store.getState().dismissResult(SITE_ID);
    expect(run().result).toBeNull();
    expect(run().notes).toBeNull();
  });

  it('drops the notes of an earlier run when a run nobody started here comes in', () => {
    store.getState().begin(SITE_ID, { notices: ['notAtomic'], drift: ['x'] });
    store.getState().progress(progressEvent());
    store.getState().finish(runResult());
    store.getState().progress(progressEvent({ runId: 'run-2', trigger: 'deployOnSave' }));
    expect(run().notes).toBeNull();
  });

  it('keeps the readings of the last few seconds, however often they come', () => {
    store.getState().begin(SITE_ID, null);
    // Ten a second for three seconds: a count cap would keep barely one second of them.
    for (let index = 0; index < 30; index += 1) {
      store.getState().progress(progressEvent({ bytesDone: index * 100 }));
      vi.advanceTimersByTime(100);
    }
    expect(run().samples).toHaveLength(30);
    for (let index = 30; index < 100; index += 1) {
      store.getState().progress(progressEvent({ bytesDone: index * 100 }));
      vi.advanceTimersByTime(100);
    }
    const { samples } = run();
    const span = (samples.at(-1)?.at ?? 0) - (samples[0]?.at ?? 0);
    expect(span).toBeGreaterThanOrEqual(4000);
    expect(span).toBeLessThanOrEqual(5100);
  });

  it('keeps two readings when they come seldom, so there is always a speed', () => {
    store.getState().begin(SITE_ID, null);
    store.getState().progress(progressEvent({ bytesDone: 0 }));
    vi.advanceTimersByTime(8000);
    store.getState().progress(progressEvent({ bytesDone: 8000 }));
    expect(run().samples.map((sample) => sample.bytes)).toEqual([0, 8000]);
  });

  it('forgets a removed site', () => {
    store.getState().finish(runResult());
    store.getState().forget(SITE_ID);
    expect(run()).toBe(EMPTY_SITE_RUN);
  });
});
