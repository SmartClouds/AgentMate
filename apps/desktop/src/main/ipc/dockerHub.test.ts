import type { IpcMainInvokeEvent } from 'electron';
import { describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { RegistryLockedError } from '../deploy/registry/service';
import { type DockerHubHandlerDeps, dockerHubSignIn, registerDockerHubHandlers } from './dockerHub';

/**
 * The Docker Hub view's channels. They answer only the main window, check every name before it
 * reaches Hub's API or `docker pull`, and send the saved sign-in with a pull only when the
 * repository is private.
 */

type Listener = (event: IpcMainInvokeEvent, ...args: unknown[]) => unknown;

const HUB_CREDENTIAL = {
  id: 'c1',
  kind: 'dockerhub',
  registry: 'docker.io',
  username: 'hubber',
  locked: false,
};

function harness({ trusted = true, credentials = [HUB_CREDENTIAL] as unknown[] } = {}) {
  const handlers = new Map<string, Listener>();
  const registries = {
    list: vi.fn(async () => credentials),
    authsForRegistries: vi.fn(async () => [
      { registry: 'docker.io', username: 'hubber', secret: 'dckr_pat_x' },
    ]),
  };
  const hub = {
    repositories: vi.fn(async () => [{ name: 'api' }]),
    tags: vi.fn(async () => [{ name: '1.4' }]),
  };
  const pull = vi.fn(async () => ({ ok: true }));
  registerDockerHubHandlers({
    ipc: { handle: (channel, listener) => handlers.set(channel, listener) },
    registries: registries as unknown as DockerHubHandlerDeps['registries'],
    hub: hub as unknown as DockerHubHandlerDeps['hub'],
    pull,
    guard: () => trusted,
  });
  const call = (channel: string, ...args: unknown[]) => {
    const handler = handlers.get(channel);
    if (!handler) throw new Error(`No handler for ${channel}`);
    return handler({} as IpcMainInvokeEvent, ...args);
  };
  return { handlers, registries, hub, pull, call };
}

describe('registerDockerHubHandlers', () => {
  it('handles every channel of the group', () => {
    const { handlers } = harness();
    expect([...handlers.keys()].sort()).toEqual(Object.values(IPC.dockerHub).sort());
  });

  it('answers only the main window', async () => {
    const { call, hub } = harness({ trusted: false });

    await expect(call(IPC.dockerHub.repositories)).rejects.toThrow(/main window/);
    expect(hub.repositories).not.toHaveBeenCalled();
  });

  describe('status', () => {
    it('is signed in with the saved Docker Hub user name', async () => {
      const { call } = harness();

      await expect(call(IPC.dockerHub.status)).resolves.toEqual({
        state: 'signedIn',
        username: 'hubber',
      });
    });

    it('is signed out when only other registries have a sign-in', async () => {
      const { call } = harness({
        credentials: [{ ...HUB_CREDENTIAL, kind: 'github', registry: 'ghcr.io' }],
      });

      await expect(call(IPC.dockerHub.status)).resolves.toEqual({
        state: 'signedOut',
        username: null,
      });
    });

    it('is locked while the Servers passkey seals the sign-in', async () => {
      const { call } = harness({ credentials: [{ ...HUB_CREDENTIAL, locked: true }] });

      await expect(call(IPC.dockerHub.status)).resolves.toEqual({
        state: 'locked',
        username: 'hubber',
      });
    });
  });

  it('lists repositories', async () => {
    const { call } = harness();

    await expect(call(IPC.dockerHub.repositories)).resolves.toEqual([{ name: 'api' }]);
  });

  describe('tags', () => {
    it('passes checked names through', async () => {
      const { call, hub } = harness();

      await expect(call(IPC.dockerHub.tags, 'hubber', 'my-api.v2')).resolves.toEqual([
        { name: '1.4' },
      ]);
      expect(hub.tags).toHaveBeenCalledWith('hubber', 'my-api.v2');
    });

    it.each([
      ['../etc', 'api'],
      ['hubber', 'API'],
      ['hubber', ''],
      [7, 'api'],
    ])('refuses %j / %j', async (namespace, name) => {
      const { call, hub } = harness();

      await expect(call(IPC.dockerHub.tags, namespace, name)).rejects.toThrow();
      expect(hub.tags).not.toHaveBeenCalled();
    });
  });

  describe('pull', () => {
    it('pulls a public tag with the user’s own docker setup', async () => {
      const { call, pull, registries } = harness();

      await expect(
        call(IPC.dockerHub.pull, {
          namespace: 'hubber',
          name: 'api',
          tag: '1.4',
          isPrivate: false,
        }),
      ).resolves.toEqual({ ok: true });
      expect(pull).toHaveBeenCalledWith('hubber/api:1.4', undefined);
      expect(registries.authsForRegistries).not.toHaveBeenCalled();
    });

    it('sends the saved sign-in with a private one', async () => {
      const { call, pull, registries } = harness();

      await call(IPC.dockerHub.pull, {
        namespace: 'hubber',
        name: 'secret',
        tag: 'latest',
        isPrivate: true,
      });

      expect(registries.authsForRegistries).toHaveBeenCalledWith(['docker.io']);
      expect(pull).toHaveBeenCalledWith('hubber/secret:latest', {
        username: 'hubber',
        secret: 'dckr_pat_x',
      });
    });

    it('drops the library/ prefix of official images', async () => {
      const { call, pull } = harness();

      await call(IPC.dockerHub.pull, {
        namespace: 'library',
        name: 'nginx',
        tag: '1.27',
        isPrivate: false,
      });

      expect(pull).toHaveBeenCalledWith('nginx:1.27', undefined);
    });

    it('refuses a tag docker could read as something else', async () => {
      const { call, pull } = harness();

      await expect(
        call(IPC.dockerHub.pull, {
          namespace: 'hubber',
          name: 'api',
          tag: '-help',
          isPrivate: false,
        }),
      ).rejects.toThrow();
      expect(pull).not.toHaveBeenCalled();
    });
  });
});

describe('dockerHubSignIn', () => {
  it('is the saved Docker Hub sign-in, unsealed', async () => {
    const signIn = dockerHubSignIn({
      authsForRegistries: async () => [{ registry: 'docker.io', username: 'hubber', secret: 's' }],
    });

    await expect(signIn()).resolves.toEqual({ username: 'hubber', secret: 's' });
  });

  it('is null when there is none', async () => {
    const signIn = dockerHubSignIn({ authsForRegistries: async () => [] });

    await expect(signIn()).resolves.toBeNull();
  });

  it('asks for the passkey in words that fit this page, not a deploy', async () => {
    const signIn = dockerHubSignIn({
      authsForRegistries: async () => {
        throw new RegistryLockedError('Unlock the Servers passkey so ... this deploy.');
      },
    });

    await expect(signIn()).rejects.toThrow(
      'Unlock the Servers passkey to use your Docker Hub sign-in.',
    );
  });
});
