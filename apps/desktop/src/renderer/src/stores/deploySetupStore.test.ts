import type { DeploySetupProgressEvent } from '@shared/deployTypes';
import { beforeEach, describe, expect, it } from 'vitest';
import { type FakeBridge, installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { useDeploySetupStore } from './deploySetupStore';

/**
 * An install or removal keeps running in the main process when the Deploy page is left, so its
 * progress lives here rather than in the page, and coming back shows where it got to.
 */

const progress = (serverId: string, phase: 'preflight' | 'upload', status: 'running' | 'done') =>
  ({ serverId, progress: { phase, title: phase, status } }) satisfies DeploySetupProgressEvent;

let bridge: FakeBridge;

beforeEach(() => {
  useDeploySetupStore.setState({ runs: {} });
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe('deploySetupStore', () => {
  it('collects progress for its own server while an install runs', async () => {
    const call = deferred<unknown>();
    bridge = installRunovaBridge({ 'deploy.install': () => call.promise });

    const done = useDeploySetupStore.getState().install('srv-1', ['preflight', 'upload'], null);
    bridge.$emit('deploy.onSetupProgress', progress('srv-1', 'preflight', 'running'));
    bridge.$emit('deploy.onSetupProgress', progress('srv-2', 'upload', 'running'));
    bridge.$emit('deploy.onSetupProgress', progress('srv-1', 'preflight', 'done'));

    const run = useDeploySetupStore.getState().runs['srv-1'];
    expect(run?.status).toBe('running');
    expect(run?.events.map((event) => event.status)).toEqual(['running', 'done']);

    call.resolve({
      version: '1.53.0',
      release: 'r',
      transport: 'streamlocal',
      previousVersion: null,
    });
    await done;
    expect(useDeploySetupStore.getState().runs['srv-1']?.status).toBe('done');
    expect(bridge.$listenerCount('deploy.onSetupProgress')).toBe(0);
  });

  it('keeps the reason and its code when an install fails', async () => {
    bridge = installRunovaBridge({
      'deploy.install': async () => {
        throw new Error(
          "Error invoking remote method 'deploy:install': Error: [ssh:sudo-password-rejected] prod did not accept the sudo password for deployer.",
        );
      },
    });

    const result = await useDeploySetupStore.getState().install('srv-1', ['preflight'], 'nope');

    expect(result).toBeNull();
    expect(useDeploySetupStore.getState().runs['srv-1']).toMatchObject({
      status: 'failed',
      error: 'prod did not accept the sudo password for deployer.',
      errorCode: 'sudo-password-rejected',
    });
  });

  it('passes the removal choice and password through', async () => {
    bridge = installRunovaBridge({ 'deploy.uninstall': async () => undefined });

    const removed = await useDeploySetupStore.getState().uninstall('srv-1', false, 'pw');

    expect(removed).toBe(true);
    expect(bridge.$fn('deploy.uninstall')).toHaveBeenCalledWith({
      serverId: 'srv-1',
      keepData: false,
      sudoPassword: 'pw',
    });
    expect(useDeploySetupStore.getState().runs['srv-1']).toMatchObject({
      kind: 'uninstall',
      status: 'done',
    });
  });

  it('refuses to start a second run on a server that has one going', async () => {
    const call = deferred<unknown>();
    bridge = installRunovaBridge({ 'deploy.install': () => call.promise });

    const first = useDeploySetupStore.getState().install('srv-1', ['preflight'], null);
    const second = await useDeploySetupStore.getState().install('srv-1', ['preflight'], null);

    expect(second).toBeNull();
    expect(bridge.$fn('deploy.install')).toHaveBeenCalledTimes(1);
    call.resolve({ version: '1', release: 'r', transport: 'bridge', previousVersion: null });
    await first;
  });

  it('forgets a finished run when asked', async () => {
    bridge = installRunovaBridge({ 'deploy.uninstall': async () => undefined });
    await useDeploySetupStore.getState().uninstall('srv-1', true, null);

    useDeploySetupStore.getState().clear('srv-1');

    expect(useDeploySetupStore.getState().runs['srv-1']).toBeUndefined();
  });
});
