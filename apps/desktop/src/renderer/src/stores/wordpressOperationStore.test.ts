import type {
  DeployWordPressDeployResult,
  DeployWordPressProgressEvent,
} from '@shared/deployWordPressTypes';
import { describe, expect, it } from 'vitest';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import {
  findWordPressRun,
  listenForWordPressProgress,
  useWordPressOperationStore,
} from './wordpressOperationStore';

/**
 * A pull or deploy keeps going in the main process when its dialog closes, so its progress
 * lives here, keyed by the operation id the renderer picked, and a dialog opened again finds it.
 */

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function progress(
  operationId: string,
  phase: DeployWordPressProgressEvent['phase'],
  done = 0,
  total = 0,
): DeployWordPressProgressEvent {
  return { operationId, siteId: 's1', projectId: 'p1', kind: 'deploy', phase, done, total };
}

const deployed: DeployWordPressDeployResult = {
  deployId: 'd1',
  state: 'done',
  health: [],
  uploaded: 3,
  deleted: 1,
  durationMs: 1200,
};

describe('wordpressOperationStore', () => {
  it('follows its own run through the phases and keeps the result with the done state', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const bridge = installRunovaBridge({ 'deployWordPress.deploy': () => call.promise });

    const done = useWordPressOperationStore
      .getState()
      .deploy(
        { planId: 'plan-1', operationId: 'op-1', force: false },
        { siteId: 's1', projectId: 'p1' },
      );
    bridge.$emit('deployWordPress.onProgress', progress('op-1', 'connecting'));
    bridge.$emit('deployWordPress.onProgress', progress('op-1', 'upload', 1, 4));
    bridge.$emit('deployWordPress.onProgress', progress('op-1', 'upload', 4, 4));
    // A done event does not end a run started here: the call does, with its result.
    bridge.$emit('deployWordPress.onProgress', progress('op-1', 'done'));

    let run = useWordPressOperationStore.getState().runs['op-1'];
    expect(run?.status).toBe('running');
    expect(run?.phases).toEqual(['connecting', 'upload']);
    expect(run?.progress.upload).toEqual({ done: 4, total: 4, bytes: undefined });

    call.resolve(deployed);
    await expect(done).resolves.toEqual(deployed);
    run = useWordPressOperationStore.getState().runs['op-1'];
    expect(run?.status).toBe('done');
    expect(run?.result).toEqual({ kind: 'deploy', value: deployed });
    expect(bridge.$fn('deployWordPress.deploy')).toHaveBeenCalledWith({
      planId: 'plan-1',
      operationId: 'op-1',
      force: false,
    });
  });

  it('listens once, however many runs start', async () => {
    const bridge = installRunovaBridge({
      'deployWordPress.pull': async () => ({
        downloaded: 0,
        deletedLocal: 0,
        conflictCopies: [],
        leftOut: [],
      }),
    });
    const store = useWordPressOperationStore.getState();
    await store.pull(
      { planId: 'a', operationId: 'op-a', force: false },
      { siteId: 's1', projectId: 'p1' },
    );
    await store.pull(
      { planId: 'b', operationId: 'op-b', force: false },
      { siteId: 's1', projectId: 'p1' },
    );
    listenForWordPressProgress();

    expect(bridge.$listenerCount('deployWordPress.onProgress')).toBe(1);
  });

  it('keeps the reason and its code when a run fails', async () => {
    installRunovaBridge({
      'deployWordPress.createProject': async () => {
        throw new Error(
          "Error invoking remote method 'deployWordPress:createProject': Error: [wp:folderNotEmpty] wp-content/themes/twentytwentyfive already holds files.",
        );
      },
    });

    const project = await useWordPressOperationStore.getState().createProject({
      operationId: 'op-c',
      siteId: 's1',
      items: [{ kind: 'theme', slug: 'twentytwentyfive' }],
      folderPath: 'C:\\code\\site',
      name: 'Site',
      agentType: 'claude-code',
    });

    expect(project).toBeNull();
    expect(useWordPressOperationStore.getState().runs['op-c']).toMatchObject({
      status: 'failed',
      kind: 'createProject',
      error: 'wp-content/themes/twentytwentyfive already holds files.',
      errorCode: 'folderNotEmpty',
    });
  });

  it('shows a run it did not start, and ends it on its own done or failed event', () => {
    const bridge = installRunovaBridge();
    listenForWordPressProgress();

    bridge.$emit('deployWordPress.onProgress', progress('elsewhere', 'download', 2, 9));
    expect(useWordPressOperationStore.getState().runs.elsewhere).toMatchObject({
      status: 'running',
      owned: false,
      phases: ['download'],
    });

    bridge.$emit('deployWordPress.onProgress', {
      ...progress('elsewhere', 'failed'),
      error: '[wp:unreachable] The site did not answer.',
    });
    expect(useWordPressOperationStore.getState().runs.elsewhere).toMatchObject({
      status: 'failed',
      error: 'The site did not answer.',
      errorCode: 'unreachable',
    });
  });

  it('asks the main process to stop a running operation, and forgets a cleared one', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const bridge = installRunovaBridge({ 'deployWordPress.deploy': () => call.promise });
    const store = useWordPressOperationStore.getState();
    const done = store.deploy(
      { planId: 'plan-1', operationId: 'op-1', force: true },
      { siteId: 's1', projectId: 'p1' },
    );

    await store.cancel('op-1');
    expect(bridge.$fn('deployWordPress.cancel')).toHaveBeenCalledWith('op-1');
    expect(useWordPressOperationStore.getState().runs['op-1']?.cancelling).toBe(true);

    call.reject(new Error('[wp:cancelled] Stopped.'));
    await done;
    expect(useWordPressOperationStore.getState().runs['op-1']).toMatchObject({
      status: 'failed',
      cancelling: false,
      errorCode: 'cancelled',
    });

    // Stopping a run that already ended asks nothing of the main process.
    await store.cancel('op-1');
    expect(bridge.$fn('deployWordPress.cancel')).toHaveBeenCalledTimes(1);

    store.clear('op-1');
    expect(useWordPressOperationStore.getState().runs['op-1']).toBeUndefined();
  });

  it('refuses to start a second run under an id that is still running', async () => {
    const call = deferred<DeployWordPressDeployResult>();
    const bridge = installRunovaBridge({ 'deployWordPress.deploy': () => call.promise });
    const store = useWordPressOperationStore.getState();
    const input = { planId: 'plan-1', operationId: 'op-1', force: false };
    const first = store.deploy(input, { siteId: 's1', projectId: 'p1' });

    await expect(store.deploy(input, { siteId: 's1', projectId: 'p1' })).resolves.toBeNull();
    expect(bridge.$fn('deployWordPress.deploy')).toHaveBeenCalledTimes(1);
    call.resolve(deployed);
    await first;
  });

  it('finds the newest run of a kind for a project', async () => {
    installRunovaBridge({ 'deployWordPress.deploy': async () => deployed });
    const store = useWordPressOperationStore.getState();
    await store.deploy(
      { planId: 'a', operationId: 'old', force: false },
      { siteId: 's1', projectId: 'p1' },
    );
    useWordPressOperationStore.setState((state) => ({
      runs: { ...state.runs, old: { ...state.runs.old, startedAt: 1 } },
    }));
    await store.deploy(
      { planId: 'b', operationId: 'new', force: false },
      { siteId: 's1', projectId: 'p1' },
    );

    const runs = useWordPressOperationStore.getState().runs;
    expect(findWordPressRun(runs, { kind: 'deploy', projectId: 'p1' })?.operationId).toBe('new');
    expect(findWordPressRun(runs, { kind: 'deploy', projectId: 'p2' })).toBeNull();
    expect(findWordPressRun(runs, { kind: 'pull', projectId: 'p1' })).toBeNull();
    expect(findWordPressRun(runs, { kind: 'deploy', siteId: 's2' })).toBeNull();
  });

  it('swaps in the project a changed item list returns', async () => {
    const bridge = installRunovaBridge({
      'deployWordPress.setProjectItems': async () => ({ id: 'p1', name: 'Site' }),
    });
    const project = await useWordPressOperationStore
      .getState()
      .setProjectItems(
        { operationId: 'op-i', projectId: 'p1', items: [{ kind: 'plugin', slug: 'akismet' }] },
        's1',
      );

    expect(project).toEqual({ id: 'p1', name: 'Site' });
    expect(bridge.$fn('deployWordPress.setProjectItems')).toHaveBeenCalledWith({
      operationId: 'op-i',
      projectId: 'p1',
      items: [{ kind: 'plugin', slug: 'akismet' }],
    });
    expect(useWordPressOperationStore.getState().runs['op-i']).toMatchObject({
      kind: 'items',
      siteId: 's1',
      projectId: 'p1',
      status: 'done',
    });
  });
});
