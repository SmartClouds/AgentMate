import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { isImageReference } from '../../shared/dockerNames';
import { IPC } from '../../shared/ipcChannels';
import type { DeployDocker } from '../deploy/docker';
import type { DockerSubscriptions } from '../deploy/live/dockerSubscriptions';
import { registerDeployDockerHandlers } from './deployDocker';

/**
 * The Containers screen's channels answer only the main window, check every argument against
 * the core's own rules before a server hears of it, and tie each live subscription (and each
 * console's keystrokes) to the window that opened it.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const SUBSCRIPTION = '5b0e0f3c-8d6e-4c55-9d0e-3f7a1c2b9e10';
const C = IPC.deployDocker;

function harness(trusted = true) {
  const handlers = new Map<string, Listener>();
  const docker = Object.fromEntries(
    [
      'status',
      'install',
      'listContainers',
      'inspect',
      'revealEnv',
      'act',
      'remove',
      'logTail',
      'listImages',
      'pullImage',
      'removeImage',
      'listVolumes',
      'removeVolume',
      'listNetworks',
      'removeNetwork',
      'diskUsage',
      'prune',
    ].map((name) => [name, vi.fn(async () => ({}))]),
  ) as unknown as Record<string, ReturnType<typeof vi.fn>>;
  const subscriptions = {
    watchStats: vi.fn((..._args: unknown[]) => 'sub-s'),
    watchEvents: vi.fn((..._args: unknown[]) => 'sub-e'),
    watchLogs: vi.fn((..._args: unknown[]) => 'sub-l'),
    openConsole: vi.fn((..._args: unknown[]) => 'sub-c'),
    consoleInput: vi.fn((..._args: unknown[]) => true),
    consoleResize: vi.fn((..._args: unknown[]) => true),
    unwatch: vi.fn((..._args: unknown[]) => true),
  };
  const owner = { id: 7, send: vi.fn() };
  registerDeployDockerHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    docker: docker as unknown as DeployDocker,
    subscriptions: subscriptions as unknown as DockerSubscriptions,
    guard: () => trusted,
    owner: () => owner,
  });
  const call = async (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, docker, subscriptions, owner, call };
}

describe('registerDeployDockerHandlers', () => {
  it('handles every invoke channel of the group', () => {
    const { handlers } = harness();
    const invokes = Object.entries(C)
      .filter(([name]) => !name.startsWith('on'))
      .map(([, channel]) => channel);
    expect([...handlers.keys()].sort()).toEqual(invokes.sort());
  });

  it('answers only the main window', async () => {
    const { docker, subscriptions, call } = harness(false);
    await expect(call(C.listContainers, 'srv-1')).rejects.toThrow(/main window/);
    await expect(call(C.watchStats, 'srv-1')).rejects.toThrow(/main window/);
    expect(docker.listContainers).not.toHaveBeenCalled();
    expect(subscriptions.watchStats).not.toHaveBeenCalled();
  });

  it('passes checked reads through', async () => {
    const { docker, call } = harness();
    await call(C.status, 'srv-1');
    await call(C.listContainers, 'srv-1');
    await call(C.inspect, 'srv-1', 'shop-api-1');
    await call(C.listImages, 'srv-1');
    await call(C.listVolumes, 'srv-1');
    await call(C.listNetworks, 'srv-1');
    await call(C.diskUsage, 'srv-1');
    await call(C.logTail, { serverId: 'srv-1', containerId: 'shop-api-1', tail: 50 });
    await call(C.logTail, { serverId: 'srv-1', containerId: 'shop-api-1' });

    expect(docker.status).toHaveBeenCalledWith('srv-1');
    expect(docker.inspect).toHaveBeenCalledWith('srv-1', 'shop-api-1');
    expect(docker.logTail).toHaveBeenNthCalledWith(1, {
      serverId: 'srv-1',
      containerId: 'shop-api-1',
      tail: 50,
    });
    expect(docker.logTail).toHaveBeenNthCalledWith(2, {
      serverId: 'srv-1',
      containerId: 'shop-api-1',
    });
  });

  it('refuses names Docker would not accept, so nothing can reach another engine endpoint', async () => {
    const { docker, call } = harness();
    for (const bad of ['../containers', 'a/b', 'name?x', '', '-leading', 'x'.repeat(129), 7]) {
      await expect(call(C.inspect, 'srv-1', bad)).rejects.toThrow(/container id or name/);
    }
    await expect(call(C.inspect, 'not a server!', 'web')).rejects.toThrow(/saved server/);
    await expect(call(C.removeNetwork, 'srv-1', 'net/../x')).rejects.toThrow(/network/);
    await expect(
      call(C.removeVolume, { serverId: 'srv-1', volume: '%2e%2e', force: false }),
    ).rejects.toThrow(/volume/);
    expect(docker.inspect).not.toHaveBeenCalled();
    expect(docker.removeNetwork).not.toHaveBeenCalled();
    expect(docker.removeVolume).not.toHaveBeenCalled();
  });

  it('checks each lifecycle action and only the options it takes', async () => {
    const { docker, call } = harness();
    await call(C.act, { serverId: 'srv-1', containerId: 'web', action: 'stop', timeoutSeconds: 5 });
    await call(C.act, { serverId: 'srv-1', containerId: 'web', action: 'kill', signal: 'SIGTERM' });
    await call(C.act, { serverId: 'srv-1', containerId: 'web', action: 'kill' });
    await call(C.act, {
      serverId: 'srv-1',
      containerId: 'web',
      action: 'start',
      timeoutSeconds: 5,
      signal: 'SIGTERM',
    });

    expect(docker.act.mock.calls.map(([input]) => input)).toEqual([
      { serverId: 'srv-1', containerId: 'web', action: 'stop', timeoutSeconds: 5 },
      { serverId: 'srv-1', containerId: 'web', action: 'kill', signal: 'SIGTERM' },
      { serverId: 'srv-1', containerId: 'web', action: 'kill' },
      { serverId: 'srv-1', containerId: 'web', action: 'start' },
    ]);
    await expect(
      call(C.act, { serverId: 'srv-1', containerId: 'web', action: 'explode' }),
    ).rejects.toThrow(/Start, stop/);
    await expect(
      call(C.act, { serverId: 'srv-1', containerId: 'web', action: 'kill', signal: 'SIGSEGV' }),
    ).rejects.toThrow(/SIGKILL/);
    await expect(
      call(C.act, { serverId: 'srv-1', containerId: 'web', action: 'stop', timeoutSeconds: 601 }),
    ).rejects.toThrow(/0 to 600/);
    await expect(call(C.act, 'stop')).rejects.toThrow(/Expected a container action/);
  });

  it('needs a yes or no for removing volumes, and forces nothing unless asked', async () => {
    const { docker, call } = harness();
    await call(C.remove, { serverId: 'srv-1', containerId: 'web', removeVolumes: true });
    expect(docker.remove).toHaveBeenCalledWith({
      serverId: 'srv-1',
      containerId: 'web',
      removeVolumes: true,
      force: false,
    });
    await expect(
      call(C.remove, { serverId: 'srv-1', containerId: 'web', removeVolumes: 'yes' }),
    ).rejects.toThrow(/Say yes or no/);
  });

  it('passes a step-up along with a reveal, and nothing else', async () => {
    const { docker, call } = harness();
    await call(C.revealEnv, {
      serverId: 'srv-1',
      containerId: 'shop-api-1',
      password: 'secret',
      extra: 'dropped',
    });
    expect(docker.revealEnv).toHaveBeenCalledWith({
      serverId: 'srv-1',
      containerId: 'shop-api-1',
      password: 'secret',
    });
  });

  it('takes image references and ids as Docker spells them', async () => {
    const { docker, call } = harness();
    await call(C.pullImage, { serverId: 'srv-1', reference: 'ghcr.io/org/app:1.2.3' });
    await call(C.removeImage, { serverId: 'srv-1', image: 'sha256:0123456789ab' });
    await call(C.removeImage, { serverId: 'srv-1', image: 'nginx:1.29', force: true });
    expect(docker.pullImage).toHaveBeenCalledWith({
      serverId: 'srv-1',
      reference: 'ghcr.io/org/app:1.2.3',
    });
    expect(docker.removeImage).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      image: 'nginx:1.29',
      force: true,
    });
    await expect(call(C.pullImage, { serverId: 'srv-1', reference: 'Nginx' })).rejects.toThrow(
      /image reference/,
    );
    await expect(call(C.removeImage, { serverId: 'srv-1', image: 'a b' })).rejects.toThrow(
      /image id or reference/,
    );
  });

  it('knows a pullable reference', () => {
    expect(isImageReference('nginx')).toBe(true);
    expect(isImageReference('registry.example.com:5000/team/app:v1')).toBe(true);
    expect(isImageReference(`busybox@sha256:${'a'.repeat(64)}`)).toBe(true);
    expect(isImageReference('Upper')).toBe(false);
    expect(isImageReference('app:')).toBe(false);
    expect(isImageReference('')).toBe(false);
  });

  it('prunes only what the core knows, with flags off unless asked', async () => {
    const { docker, call } = harness();
    await call(C.prune, { serverId: 'srv-1', target: 'images', allImages: true });
    expect(docker.prune).toHaveBeenCalledWith({
      serverId: 'srv-1',
      target: 'images',
      allImages: true,
      includeVolumes: false,
    });
    await call(C.prune, { serverId: 'srv-1', target: 'buildCache' });
    expect(docker.prune).toHaveBeenLastCalledWith({
      serverId: 'srv-1',
      target: 'buildCache',
      allImages: false,
      includeVolumes: false,
    });
    await expect(call(C.prune, { serverId: 'srv-1', target: 'everything' })).rejects.toThrow(
      /Prune containers/,
    );
  });

  it('asks for agreement in so many words before an install', async () => {
    const { docker, call } = harness();
    await call(C.install, { serverId: 'srv-1', removeConflictingPackages: false });
    expect(docker.install).toHaveBeenCalledWith({
      serverId: 'srv-1',
      removeConflictingPackages: false,
    });
    await expect(call(C.install, { serverId: 'srv-1' })).rejects.toThrow(/Say yes or no/);
  });

  it('ties subscriptions to the calling window and checks their ids', async () => {
    const { subscriptions, owner, call } = harness();
    expect(await call(C.watchStats, 'srv-1')).toBe('sub-s');
    expect(await call(C.watchEvents, 'srv-1')).toBe('sub-e');
    expect(
      await call(C.watchLogs, {
        serverId: 'srv-1',
        containerId: 'shop-api-1',
        follow: true,
        tail: 0,
        sinceUnixMs: 5,
      }),
    ).toBe('sub-l');
    expect(subscriptions.watchLogs).toHaveBeenCalledWith(owner, {
      serverId: 'srv-1',
      containerId: 'shop-api-1',
      follow: true,
      tail: 0,
      sinceUnixMs: 5,
    });
    await call(C.unwatchStats, SUBSCRIPTION);
    await call(C.unwatchLogs, SUBSCRIPTION);
    await call(C.unwatchEvents, SUBSCRIPTION);
    await call(C.closeConsole, SUBSCRIPTION);
    expect(subscriptions.unwatch.mock.calls.map(([, kind]) => kind)).toEqual([
      'stats',
      'logs',
      'events',
      'console',
    ]);
    await expect(call(C.unwatchLogs, 'sub-1')).rejects.toThrow(/subscription/);
    await expect(
      call(C.watchLogs, { serverId: 'srv-1', containerId: 'web', follow: true, tail: 5001 }),
    ).rejects.toThrow(/0 to 5000/);
  });

  it('opens consoles with a checked size, program and user', async () => {
    const { subscriptions, owner, call } = harness();
    await call(C.openConsole, {
      serverId: 'srv-1',
      containerId: 'shop-api-1',
      columns: 120,
      rows: 30,
      command: ['/bin/sh'],
      user: 'node',
    });
    await call(C.openConsole, {
      serverId: 'srv-1',
      containerId: 'shop-api-1',
      columns: 80,
      rows: 24,
      user: '',
    });
    expect(subscriptions.openConsole.mock.calls.map(([, input]) => input)).toEqual([
      {
        serverId: 'srv-1',
        containerId: 'shop-api-1',
        columns: 120,
        rows: 30,
        command: ['/bin/sh'],
        user: 'node',
      },
      { serverId: 'srv-1', containerId: 'shop-api-1', columns: 80, rows: 24 },
    ]);
    expect(subscriptions.openConsole.mock.calls[0][0]).toBe(owner);

    const base = { serverId: 'srv-1', containerId: 'web', columns: 80, rows: 24 };
    await expect(call(C.openConsole, { ...base, columns: 0 })).rejects.toThrow(/columns/);
    await expect(call(C.openConsole, { ...base, user: 'root; rm' })).rejects.toThrow(/user/);
    await expect(call(C.openConsole, { ...base, command: [] })).rejects.toThrow(/program/);
    await expect(call(C.openConsole, { ...base, command: ['sh', 'a\0b'] })).rejects.toThrow(
      /program/,
    );
    await expect(
      call(C.openConsole, { ...base, command: Array.from({ length: 33 }, () => 'x') }),
    ).rejects.toThrow(/program/);
  });

  it('sends keystrokes and sizes to the window’s own console only', async () => {
    const { subscriptions, owner, call } = harness();
    expect(await call(C.consoleInput, SUBSCRIPTION, 'ls\r')).toBe(true);
    expect(await call(C.consoleResize, SUBSCRIPTION, 100, 40)).toBe(true);
    expect(subscriptions.consoleInput).toHaveBeenCalledWith(owner, SUBSCRIPTION, 'ls\r');
    expect(subscriptions.consoleResize).toHaveBeenCalledWith(owner, SUBSCRIPTION, 100, 40);
    await expect(call(C.consoleInput, SUBSCRIPTION, 5)).rejects.toThrow(/text/);
    await expect(call(C.consoleInput, SUBSCRIPTION, 'x'.repeat(65 * 1024))).rejects.toThrow(/text/);
    await expect(call(C.consoleResize, SUBSCRIPTION, 100, 0)).rejects.toThrow(/rows/);
  });
});
