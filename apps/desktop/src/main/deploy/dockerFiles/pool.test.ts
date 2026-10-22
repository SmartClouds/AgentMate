import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { filesErrorCode, filesErrorMessage } from '../../../shared/deployFilesErrors';
import { dockerFileTargetId } from '../../../shared/fileTargets';
import type { ClientLease, SftpPool } from '../../sftp/client';
import { mapSshConnectError } from '../files/transport/errors';
import { DockerFileClient, type DockerFilesBackend } from './client';
import { createDockerFilePool, routeFilePool } from './pool';
import { describeDockerTarget, dockerTargetsOn, sameDockerTarget } from './targets';
import { type FakeDockerFiles, startFakeDockerFiles } from './testing/fakeBackend';

/**
 * Where Docker file sessions come from (E27): the pool opens a core file session per lease and
 * closes it on release, the routing pool sends Docker target ids there and every other id to the
 * SSH pool, and a Docker target is described for the file manager's header.
 */

const SERVER = 'srv-1';
const WEB = dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'shop-web-1' });
const UPLOADS = dockerFileTargetId({ serverId: SERVER, kind: 'volume', id: 'shop_uploads' });

let fixture: FakeDockerFiles;

beforeEach(async () => {
  fixture = await startFakeDockerFiles();
});

afterEach(async () => {
  await fixture.close();
});

async function failure(work: Promise<unknown>): Promise<Error> {
  try {
    await work;
  } catch (error) {
    return error as Error;
  }
  throw new Error('expected a failure');
}

describe('createDockerFilePool', () => {
  it('opens a core session per lease and closes it once on release', async () => {
    const pool = createDockerFilePool({ backend: () => fixture.backend });

    const lease = await pool.acquire(WEB);
    const separate = await pool.openSeparate(WEB);

    expect(lease.client).toBeInstanceOf(DockerFileClient);
    expect(lease.client.isOpen).toBe(true);
    expect(fixture.core.files.opened).toHaveLength(2);
    expect(fixture.core.files.openSessions).toBe(2);
    lease.release();
    lease.release();
    await vi.waitFor(() => expect(fixture.core.files.closed).toHaveLength(1));
    expect(lease.client.isOpen).toBe(false);
    expect(separate.client.isOpen).toBe(true);
    expect(pool.lastSession(WEB)).toMatchObject({ displayName: 'shop-web-1', user: 'root' });
  });

  it('opens a volume', async () => {
    const pool = createDockerFilePool({ backend: () => fixture.backend });

    const lease = await pool.acquire(UPLOADS);

    expect((lease.client as DockerFileClient).session.target).toEqual({
      kind: 'volume',
      id: 'shop_uploads',
    });
  });

  it('ignores a core that cannot be told the session is over', async () => {
    const pool = createDockerFilePool({ backend: () => fixture.backend });
    const lease = await pool.acquire(UPLOADS);
    fixture.core.roles = ['viewer'];

    expect(() => lease.release()).not.toThrow();
    await vi.waitFor(() => expect(lease.client.isOpen).toBe(false));
  });

  it('refuses an id that is not a Docker target', async () => {
    const pool = createDockerFilePool({ backend: () => fixture.backend });

    expect(filesErrorCode(await failure(pool.acquire('docker~srv~image~x')))).toBe('invalidInput');
  });

  it('words the refusals of opening a session for the connect prompt', async () => {
    const pool = createDockerFilePool({ backend: () => fixture.backend });
    const gone = dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'deleted-1' });

    const missing = mapSshConnectError(await failure(pool.acquire(gone)));
    fixture.core.roles = ['operator'];
    const denied = mapSshConnectError(await failure(pool.acquire(WEB)));

    expect(filesErrorCode(missing)).toBe('siteUnknown');
    expect(filesErrorMessage(missing)).toMatch(/No such container: deleted-1/);
    expect(filesErrorCode(denied)).toBe('permissionDenied');
    expect(filesErrorMessage(denied)).toMatch(/Only Admins/);
  });

  it('keeps the core’s own sentence for other refusals, wherever SignalR put the tag', async () => {
    const refusing = (message: string): DockerFilesBackend => ({
      withHub: async () => {
        throw new Error(message);
      },
      withCoreHttp: async () => {
        throw new Error('not used');
      },
    });
    const hub = "An unexpected error occurred invoking 'FilesOpen' on the server. HubException: ";
    const open = (message: string) =>
      failure(createDockerFilePool({ backend: () => refusing(message) }).acquire(WEB));

    const denied = await open(`${hub}[files:permissionDenied] The volume is read-only.`);
    const helper = await open(`${hub}[files:server] Docker could not pull busybox.`);
    const plain = await open('The connection to the core dropped.');

    expect(filesErrorCode(denied)).toBe('permissionDenied');
    expect(filesErrorMessage(denied)).toBe('The volume is read-only.');
    expect(filesErrorCode(helper)).toBe('server');
    expect(filesErrorMessage(helper)).toBe('Docker could not pull busybox.');
    expect(filesErrorCode(plain)).toBeNull();
    expect(plain.message).toBe('The connection to the core dropped.');
  });

  it('says Deploy is not ready when there is no backend yet', async () => {
    const pool = createDockerFilePool({ backend: () => null });

    expect(filesErrorCode(await failure(pool.acquire(WEB)))).toBe('server');
  });
});

describe('routeFilePool', () => {
  function fakePool(name: string, calls: string[]): SftpPool {
    const lease = (id: string): ClientLease => ({
      client: { isOpen: true } as unknown as ClientLease['client'],
      release: () => calls.push(`${name} release ${id}`),
    });
    return {
      acquire: async (id) => {
        calls.push(`${name} acquire ${id}`);
        return lease(id);
      },
      openSeparate: async (id) => {
        calls.push(`${name} separate ${id}`);
        return lease(id);
      },
    };
  }

  it('sends Docker targets to the Docker pool and saved servers to the SSH pool', async () => {
    const calls: string[] = [];
    const pool = routeFilePool(fakePool('ssh', calls), fakePool('docker', calls));

    await pool.acquire('9c4b7e0e-2f7a-4f43-9d55-6a1f6f5f1a10');
    await pool.openSeparate('9c4b7e0e-2f7a-4f43-9d55-6a1f6f5f1a10');
    await pool.acquire(WEB);
    await pool.openSeparate(UPLOADS);
    // Looks like a Docker id but is not one, so it stays with SSH.
    await pool.acquire('docker~srv~image~x');

    expect(calls).toEqual([
      'ssh acquire 9c4b7e0e-2f7a-4f43-9d55-6a1f6f5f1a10',
      'ssh separate 9c4b7e0e-2f7a-4f43-9d55-6a1f6f5f1a10',
      `docker acquire ${WEB}`,
      `docker separate ${UPLOADS}`,
      'ssh acquire docker~srv~image~x',
    ]);
  });
});

describe('describeDockerTarget', () => {
  const lookups = (overrides: Partial<Parameters<typeof describeDockerTarget>[1]> = {}) => ({
    backend: () => fixture.backend,
    serverName: async (serverId: string) => (serverId === SERVER ? 'prod' : null),
    lastSession: () => undefined,
    ...overrides,
  });

  it('names a container and a volume after themselves, on the Deploy server', async () => {
    await expect(describeDockerTarget(WEB, lookups())).resolves.toEqual({
      nickname: 'shop-web-1 (container)',
      host: 'prod',
      port: 0,
      username: 'root',
    });
    await expect(describeDockerTarget(UPLOADS, lookups())).resolves.toEqual({
      nickname: 'shop_uploads (volume)',
      host: 'prod',
      port: 0,
      username: 'root',
    });
  });

  it('finds a container by its id and shows its name and the session user', async () => {
    const id = fixture.core.docker.require('shop-api-1').summary.id;
    const byId = dockerFileTargetId({ serverId: SERVER, kind: 'container', id });
    const session = await fixture.connection().filesOpen({ kind: 'container', id });

    const info = await describeDockerTarget(
      byId,
      lookups({ lastSession: () => ({ ...session, user: 'node' }) }),
    );

    expect(info).toMatchObject({ nickname: 'shop-api-1 (container)', username: 'node' });
  });

  it('answers null for an unknown server, container or volume', async () => {
    const elsewhere = dockerFileTargetId({ serverId: 'other', kind: 'volume', id: 'shop_uploads' });
    const noContainer = dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'nope' });
    const noVolume = dockerFileTargetId({ serverId: SERVER, kind: 'volume', id: 'nope' });

    await expect(describeDockerTarget(elsewhere, lookups())).resolves.toBeNull();
    await expect(describeDockerTarget(noContainer, lookups())).resolves.toBeNull();
    await expect(describeDockerTarget(noVolume, lookups())).resolves.toBeNull();
    await expect(describeDockerTarget('not-docker', lookups())).resolves.toBeNull();
  });

  it('still describes the target when the core cannot be asked, so opening says why', async () => {
    const info = await describeDockerTarget(
      WEB,
      lookups({
        backend: () => ({
          ...fixture.backend,
          withHub: async () => {
            throw new Error('The server core is not answering (503).');
          },
        }),
      }),
    );

    expect(info).toEqual({
      nickname: 'shop-web-1 (container)',
      host: 'prod',
      port: 0,
      username: 'root',
    });
  });
});

describe('sameDockerTarget', () => {
  const id = 'a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2c3d4e5f6a7b8c9d0a1b2';

  it('matches a container by name, full id or a long enough id prefix', () => {
    expect(sameDockerTarget({ id: 'web-1' }, 'web-1')).toBe(true);
    expect(sameDockerTarget({ id }, id.slice(0, 12))).toBe(true);
    expect(sameDockerTarget({ id: id.slice(0, 12) }, id)).toBe(true);
    expect(sameDockerTarget({ id, displayName: 'web-1' }, 'web-1')).toBe(true);
    expect(sameDockerTarget({ id }, id.slice(0, 6))).toBe(false);
    expect(sameDockerTarget({ id: 'web-1' }, 'web-10')).toBe(false);
  });
});

describe('dockerTargetsOn', () => {
  const ids = [
    'ssh-server-1',
    WEB,
    UPLOADS,
    dockerFileTargetId({ serverId: 'srv-2', kind: 'volume', id: 'shop_uploads' }),
    dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'a1b2c3d4e5f6' }),
  ];

  it('picks every Docker target on a server, for when the server goes', () => {
    expect(dockerTargetsOn(ids, SERVER)).toEqual([
      WEB,
      UPLOADS,
      dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'a1b2c3d4e5f6' }),
    ]);
  });

  it('picks the sessions on one removed container, by name, id or the name the core gave', () => {
    const named = (id: string) => (id === WEB ? { displayName: 'shop-web-1' } : undefined);

    expect(dockerTargetsOn(ids, SERVER, { kind: 'container', idOrName: 'shop-web-1' })).toEqual([
      WEB,
    ]);
    expect(
      dockerTargetsOn(ids, SERVER, {
        kind: 'container',
        idOrName: `a1b2c3d4e5f6${'0'.repeat(52)}`,
      }),
    ).toEqual([dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'a1b2c3d4e5f6' })]);
    expect(dockerTargetsOn(ids, SERVER, { kind: 'volume', idOrName: 'shop_uploads' })).toEqual([
      UPLOADS,
    ]);
    expect(
      dockerTargetsOn([WEB], SERVER, { kind: 'container', idOrName: 'shop-web-1' }, named),
    ).toEqual([WEB]);
    expect(dockerTargetsOn(ids, SERVER, { kind: 'volume', idOrName: 'shop-web-1' })).toEqual([]);
  });
});
