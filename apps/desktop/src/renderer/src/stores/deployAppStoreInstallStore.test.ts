import { describe, expect, it, vi } from 'vitest';
import type { InstallRequest } from '@/components/deploy/appStore/InstallSheet';
import { SERVER, STACK_ID, storeBridge } from '@/components/deploy/appStore/testing/fixtures';
import { installRunovaBridge } from '../../../test/renderer/runovaBridge';
import { useDeployAppStoreInstallStore } from './deployAppStoreInstallStore';

/**
 * An App Store install, and the domain steps after it, run from this store rather than from the
 * App Store section, so leaving the page loses neither the install nor its generated passwords.
 */

function request(domain: string | null = null): InstallRequest {
  return {
    template: { id: 'whoami' },
    draft: { version: '1', name: 'whoami', certificate: false },
    check: {
      params: { port: 8080 },
      secrets: { ADMIN_PASSWORD: 'correct horse' },
      domain,
      render: {
        web: { service: 'web', port: 80 },
        ports: [{ service: 'web', target: 80, published: 18080 }],
      },
    },
  } as unknown as InstallRequest;
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

const install = () => useDeployAppStoreInstallStore.getState().installs[SERVER.id];
const store = () => useDeployAppStoreInstallStore.getState();

describe('deployAppStoreInstallStore', () => {
  it('installs and keeps the passwords for the card that follows', async () => {
    const call = deferred<unknown>();
    const bridge = installRunovaBridge({
      ...storeBridge(),
      'deployAppStore.install': () => call.promise,
    });
    const onSettled = vi.fn();

    const done = store().install(SERVER.id, request(), onSettled);
    expect(install()).toMatchObject({ busy: true, error: null, session: null });
    expect(bridge.$fn('deployAppStore.install')).toHaveBeenCalledWith({
      serverId: SERVER.id,
      templateId: 'whoami',
      version: '1',
      name: 'whoami',
      params: { port: 8080 },
      secrets: { ADMIN_PASSWORD: 'correct horse' },
      domain: null,
    });

    call.resolve(await (storeBridge()['deployAppStore.install'] as () => Promise<unknown>)());
    await done;
    expect(install()).toMatchObject({
      busy: false,
      session: {
        stackId: STACK_ID,
        secrets: { ADMIN_PASSWORD: 'correct horse' },
        expose: null,
        notice: null,
        opened: false,
      },
    });
    expect(onSettled).toHaveBeenCalled();
  });

  it('puts the app on its domain after the install, step by step', async () => {
    installRunovaBridge({
      ...storeBridge(),
      'deploySites.save': { problems: [], site: { settings: {} } },
      'deploySites.applyChanges': { applied: true, problems: [], warnings: [] },
    });
    await store().install(SERVER.id, request('who.example.com'));
    await vi.waitFor(() =>
      expect(install().session?.expose?.steps.map((step) => step.state)).toEqual([
        'done',
        'done',
        'skipped',
      ]),
    );
    expect(install().session?.expose?.domain).toBe('who.example.com');
  });

  it('says why the install was refused', async () => {
    installRunovaBridge({
      ...storeBridge(),
      'deployAppStore.install': async () => {
        throw new Error('There is already an app called whoami on this server.');
      },
    });
    await store().install(SERVER.id, request());
    expect(install()).toMatchObject({
      busy: false,
      error: 'There is already an app called whoami on this server.',
      session: null,
    });
  });

  it('installs one app at a time on a server', async () => {
    const call = deferred<unknown>();
    const bridge = installRunovaBridge({
      ...storeBridge(),
      'deployAppStore.install': () => call.promise,
    });
    void store().install(SERVER.id, request());
    await store().install(SERVER.id, request());
    expect(bridge.$fn('deployAppStore.install')).toHaveBeenCalledTimes(1);
  });

  it('marks the app opened once, and forgets the passwords when dismissed', async () => {
    installRunovaBridge(storeBridge());
    await store().install(SERVER.id, request());
    store().markOpened(SERVER.id);
    expect(install().session?.opened).toBe(true);
    store().dismiss(SERVER.id);
    expect(install()).toBeUndefined();
  });
});
