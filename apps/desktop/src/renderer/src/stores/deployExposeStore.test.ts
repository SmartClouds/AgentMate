import { describe, expect, it, vi } from 'vitest';
import type { ExposeRequest } from '@/lib/deploy/sites/expose';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { exposeKey, useDeployExposeStore } from './deployExposeStore';

/**
 * Putting a port on a domain takes three calls from here (the site, nginx, the certificate). They
 * run from this store, so closing the dialog or leaving the page does not lose how far they got.
 */

const KEY = exposeKey('srv-1', 'shop-api:3000');
const SAVED = { problems: [], site: { settings: {} } };
const APPLIED = { applied: true, problems: [], warnings: [] };

const REQUEST: ExposeRequest = {
  serverId: 'srv-1',
  domain: 'api.example.com',
  service: 'shop-api',
  port: 8091,
  certificate: false,
  websocket: true,
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const run = () => useDeployExposeStore.getState().runs[KEY];

describe('deployExposeStore', () => {
  it('keeps the steps as they go, and how it ended', async () => {
    const apply = deferred<unknown>();
    installRunovaBridge({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': () => apply.promise,
    });
    const onSettled = vi.fn();

    const done = useDeployExposeStore.getState().expose(KEY, REQUEST, onSettled);
    await vi.waitFor(() =>
      expect(run().steps.find((step) => step.id === 'apply')?.state).toBe('running'),
    );
    expect(run()).toMatchObject({
      phase: 'working',
      domain: 'api.example.com',
      certificate: false,
    });
    expect(run().steps[0].state).toBe('done');

    apply.resolve(APPLIED);
    await done;
    expect(run().phase).toBe('done');
    expect(run().steps.map((step) => step.state)).toEqual(['done', 'done', 'skipped']);
    expect(onSettled).toHaveBeenCalled();
  });

  it('marks the run failed at the step that failed', async () => {
    installRunovaBridge({
      'deploySites.save': SAVED,
      'deploySites.applyChanges': { applied: false, error: 'nginx -t failed' },
    });
    await useDeployExposeStore.getState().expose(KEY, REQUEST);
    expect(run().phase).toBe('failed');
    expect(run().steps[1]).toMatchObject({ state: 'failed', detail: 'nginx -t failed' });
  });

  it('runs one at a time for a route, and forgets a run once cleared', async () => {
    const save = deferred<unknown>();
    const bridge = installRunovaBridge({ 'deploySites.save': () => save.promise });
    void useDeployExposeStore.getState().expose(KEY, REQUEST);
    expect(await useDeployExposeStore.getState().expose(KEY, REQUEST)).toBeNull();
    expect(bridge.$fn('deploySites.save')).toHaveBeenCalledTimes(1);

    useDeployExposeStore.getState().clear(KEY);
    expect(run()).toBeUndefined();
  });
});
