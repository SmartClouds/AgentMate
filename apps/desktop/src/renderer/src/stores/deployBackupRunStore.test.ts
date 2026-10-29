import type { DeployRestoreResult } from '@shared/deployHardeningTypes';
import type {
  DeployBringUpResult,
  DeployServerRestoreResult,
} from '@shared/deployServerBackupsTypes';
import { describe, expect, it, vi } from 'vitest';
import { RUN } from '@/components/deploy/backups/testing/fixtures';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { useDeployBackupRunStore } from './deployBackupRunStore';

/**
 * Back up now and a restore follow their progress from here rather than from the Backups section,
 * so leaving the Deploy page keeps them going and coming back shows where they got to.
 */

const { toast } = vi.hoisted(() => ({ toast: { success: vi.fn(), error: vi.fn() } }));
vi.mock('sonner', () => ({ toast }));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const store = () => useDeployBackupRunStore.getState();
const backup = () => store().backups['srv-1'];
const restore = () => store().restores['srv-1'];

const RUNNING = { ...RUN, id: 'run-now', state: 'running' as const };
const DONE = { ...RUNNING, state: 'succeeded' as const };

describe('deployBackupRunStore: back up now', () => {
  it('starts a backup, follows it to the end, and keeps the dialog open over it', async () => {
    const watch = deferred<unknown>();
    const bridge = installRunovaBridge({ 'deployServerBackups.watchRun': () => watch.promise });
    const refresh = vi.fn();
    store().setOpen('srv-1', true);

    const done = store().backUp('srv-1', async () => ({ started: true, run: RUNNING }), refresh);
    await vi.waitFor(() => expect(backup().run).toEqual(RUNNING));
    expect(backup()).toMatchObject({ busy: true, open: true });

    bridge.$emit('deployServerBackups.onRunProgress', {
      serverId: 'srv-1',
      run: RUNNING,
      downloadedBytes: 2048,
    });
    bridge.$emit('deployServerBackups.onRunProgress', {
      serverId: 'srv-2',
      run: RUNNING,
      downloadedBytes: 1,
    });
    expect(backup().downloaded).toBe(2048);

    watch.resolve({ run: DONE, download: { saved: true, path: 'C:\\backups\\web-1.tar' } });
    await done;
    expect(backup()).toMatchObject({ busy: false, run: DONE, saved: { saved: true } });
    expect(toast.success).toHaveBeenCalledWith('Backup saved to C:\\backups\\web-1.tar');
    expect(refresh).toHaveBeenCalled();
  });

  it('says why the backup could not start', async () => {
    installRunovaBridge({});
    await store().backUp('srv-1', async () => {
      throw new Error('No destination answers.');
    });
    expect(backup()).toMatchObject({ busy: false, problem: 'No destination answers.', run: null });
  });

  it('starts one backup at a time, and closing a finished one forgets it', async () => {
    const watch = deferred<unknown>();
    installRunovaBridge({ 'deployServerBackups.watchRun': () => watch.promise });
    const launch = vi.fn(async () => ({ started: true, run: RUNNING }));
    void store().backUp('srv-1', launch);
    await store().backUp('srv-1', launch);
    expect(launch).toHaveBeenCalledTimes(1);

    // Closed while it runs: the run is kept, so opening again shows it.
    store().setOpen('srv-1', false);
    expect(backup().run).toEqual(RUNNING);
    watch.resolve({ run: DONE });
    await vi.waitFor(() => expect(backup().busy).toBe(false));
    store().setOpen('srv-1', false);
    expect(backup()).toBeUndefined();
  });
});

describe('deployBackupRunStore: restore', () => {
  it('folds the steps of the server restored onto, then waits for it to be brought up', async () => {
    const call = deferred<unknown>();
    const bridge = installRunovaBridge({});
    const after = vi.fn(async () => undefined);
    const done = store().restore(
      'srv-1',
      'srv-2',
      () => call.promise as Promise<DeployServerRestoreResult>,
      after,
    );
    expect(restore()).toMatchObject({ phase: 'restoring', targetId: 'srv-2', steps: [] });

    const step = (serverId: string, status: string) =>
      bridge.$emit('deployServerBackups.onRestoreProgress', {
        serverId,
        kind: 'step',
        progress: { phase: 'fetch', title: 'Fetch the backup', status },
      });
    step('srv-2', 'running');
    step('srv-1', 'running');
    step('srv-2', 'done');
    expect(restore().steps).toEqual([
      { phase: 'fetch', title: 'Fetch the backup', status: 'done' },
    ]);

    call.resolve({ backupHostName: 'web-1' });
    await done;
    expect(after).toHaveBeenCalled();
    expect(restore().phase).toBe('pending');
  });

  it('goes back to the form, with the reason, when the restore fails', async () => {
    installRunovaBridge({});
    await store().restore('srv-1', 'srv-1', async () => {
      throw new Error('The secret key is wrong.');
    });
    expect(restore()).toMatchObject({ phase: 'form', problem: 'The secret key is wrong.' });
  });

  it('brings the restored server up and keeps the outcome', async () => {
    const bridge = installRunovaBridge({});
    store().setRestorePhase('srv-1', 'srv-2', 'pending');
    const result = { status: { state: 'succeeded', steps: [] }, moved: [] };
    const call = deferred<unknown>();
    const done = store().bringUp('srv-1', () => call.promise as Promise<DeployBringUpResult>);
    expect(restore().phase).toBe('bringingUp');
    bridge.$emit('deployServerBackups.onRestoreProgress', {
      serverId: 'srv-2',
      kind: 'bringUp',
      status: { state: 'running', steps: [] },
    });
    expect(restore().bringUpStatus).toEqual({ state: 'running', steps: [] });
    call.resolve(result);
    await done;
    expect(restore()).toMatchObject({ phase: 'done', result, bringUpStatus: result.status });
  });
});

describe('deployBackupRunStore: core restore over SSH', () => {
  const core = () => store().coreRestores['srv-1'];

  it('folds the steps of its own server and keeps the outcome', async () => {
    const call = deferred<DeployRestoreResult>();
    const bridge = installRunovaBridge({});
    const after = vi.fn();
    store().setCoreRestoreOpen('srv-1', true);
    const done = store().restoreCore('srv-1', () => call.promise, after);
    expect(core()).toMatchObject({ open: true, busy: true, steps: [] });

    const step = (serverId: string, status: 'running' | 'done') =>
      bridge.$emit('deployHardening.onRestoreProgress', {
        serverId,
        progress: { phase: 'stage', title: 'Decrypt and check the backup', status },
      });
    step('srv-1', 'running');
    step('srv-2', 'running');
    step('srv-1', 'done');
    expect(core().steps).toEqual([
      { phase: 'stage', title: 'Decrypt and check the backup', status: 'done' },
    ]);

    const result = { backupHostName: 'old-web' } as DeployRestoreResult;
    call.resolve(result);
    await done;
    expect(core()).toMatchObject({ busy: false, result });
    expect(after).toHaveBeenCalled();
  });

  it('says why it stopped, and keeps the dialog open while it runs', async () => {
    installRunovaBridge({});
    let fail!: (error: unknown) => void;
    const call = new Promise<DeployRestoreResult>((_, reject) => {
      fail = reject;
    });
    store().setCoreRestoreOpen('srv-1', true);
    const done = store().restoreCore('srv-1', () => call);
    store().setCoreRestoreOpen('srv-1', false);
    expect(core().open).toBe(true);
    fail(new Error('The passphrase is wrong.'));
    await done;
    expect(core()).toMatchObject({ busy: false, problem: 'The passphrase is wrong.' });
    store().setCoreRestoreOpen('srv-1', false);
    expect(core()).toBeUndefined();
  });
});
