import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../shared/coreErrors';
import { FakeCore } from '../../shared/deploy/testing/fakeCore';
import { DB_PASSWORD, PLANTED_SECRETS } from '../../shared/deploy/testing/fakeDockerData';
import { DeployDocker } from './docker';
import { CoreLinks } from './live/coreLinks';
import { fakeLiveHubs } from './testing/fakeLiveHub';

/**
 * The Containers screen's calls against a core in memory: what each role may do, environment
 * values only for an Admin who stepped up, the lifecycle, and a log tail collected once.
 */

beforeEach(() => {
  vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout', 'Date'] });
  vi.setSystemTime(1_700_000_000_000);
});

afterEach(() => {
  vi.useRealTimers();
});

function setup(roles: string[] = ['owner']) {
  const core = new FakeCore(() => Date.now());
  core.roles = roles;
  const hubs = fakeLiveHubs(core);
  const links = new CoreLinks({ open: async () => hubs.open() });
  const docker = new DeployDocker({ links, roles: () => roles });
  return { core, links, docker };
}

describe('DeployDocker', () => {
  it('reads the engine, the grouped containers and a container without its values', async () => {
    const { docker } = setup(['viewer']);

    expect(await docker.status('srv-1')).toMatchObject({
      installed: true,
      engineVersion: '29.1.3',
    });
    const list = await docker.listContainers('srv-1');
    expect(list.groups.map((group) => group.project ?? null)).toEqual(['monitoring', 'shop', null]);
    const details = await docker.inspect('srv-1', 'shop-api-1');
    expect(details.envKeys).toEqual(['NODE_ENV', 'PORT', 'DATABASE_URL', 'API_TOKEN']);
    for (const secret of PLANTED_SECRETS) expect(JSON.stringify(details)).not.toContain(secret);
  });

  it('reveals values to an Admin only after a step-up, which the call can make on the way', async () => {
    const { core, docker } = setup(['admin']);

    const refused = await docker
      .revealEnv({ serverId: 'srv-1', containerId: 'shop-db-1' })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('stepUpRequired');

    const values = await docker.revealEnv({
      serverId: 'srv-1',
      containerId: 'shop-db-1',
      password: core.password,
    });
    expect(values).toContainEqual({ name: 'POSTGRES_PASSWORD', value: DB_PASSWORD });

    const wrong = await docker
      .revealEnv({ serverId: 'srv-1', containerId: 'shop-db-1', password: 'nope' })
      .catch((error: unknown) => error);
    expect((wrong as Error).message).toBe('That password is not right.');
  });

  it('tells an Operator the reveal is not theirs rather than asking for a password', async () => {
    const { core, docker } = setup(['operator']);
    const refused = await docker
      .revealEnv({ serverId: 'srv-1', containerId: 'shop-db-1', password: core.password })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('forbidden');
  });

  it('runs every lifecycle action and answers with the container as it is now', async () => {
    const { core, docker } = setup(['operator']);
    const act = (action: 'start' | 'stop' | 'restart' | 'pause' | 'unpause' | 'kill') =>
      docker.act({ serverId: 'srv-1', containerId: 'toolbox', action });

    expect((await act('stop')).state).toBe('exited');
    expect((await act('start')).state).toBe('running');
    expect((await act('pause')).state).toBe('paused');
    expect((await act('unpause')).state).toBe('running');
    expect((await act('restart')).state).toBe('running');
    expect((await act('kill')).state).toBe('exited');
    expect(core.docker.events.map((event) => event.action)).toEqual([
      'die',
      'start',
      'pause',
      'unpause',
      'restart',
      'kill',
    ]);
  });

  it('refuses the lifecycle to a Viewer in words the screen can show', async () => {
    const { docker } = setup(['viewer']);
    const refused = await docker
      .act({ serverId: 'srv-1', containerId: 'toolbox', action: 'stop', timeoutSeconds: 3 })
      .catch((error: unknown) => error);
    expect(coreErrorCode(refused)).toBe('forbidden');
    expect((refused as Error).message).toContain('(viewer)');
  });

  it('removes a container, with its volumes only for Admins', async () => {
    const operator = setup(['operator']);
    await expect(
      operator.docker.remove({
        serverId: 'srv-1',
        containerId: 'migrate-once',
        removeVolumes: true,
        force: false,
      }),
    ).rejects.toThrow('Removing a container with its volumes is for Admins.');
    await operator.docker.remove({
      serverId: 'srv-1',
      containerId: 'migrate-once',
      removeVolumes: false,
      force: false,
    });
    expect(operator.core.docker.find('migrate-once')).toBeUndefined();

    const admin = setup(['admin']);
    await admin.docker.remove({
      serverId: 'srv-1',
      containerId: 'shop-db-1',
      removeVolumes: true,
      force: true,
    });
    expect(admin.core.docker.removed).toEqual([
      { containerId: 'shop-db-1', removeVolumes: true, force: true },
    ]);
  });

  it('collects the last lines of a log once', async () => {
    const { core, docker } = setup(['viewer']);
    for (let n = 1; n <= 5; n += 1) {
      vi.setSystemTime(1_700_000_000_000 + n * 1_000);
      core.docker.log('shop-api-1', `line ${n}`, n % 2 ? 'stdout' : 'stderr');
    }
    const lines = await docker.logTail({ serverId: 'srv-1', containerId: 'shop-api-1', tail: 3 });
    expect(lines.map((line) => line.text)).toEqual(['line 3', 'line 4', 'line 5']);
    expect(lines.map((line) => line.stream)).toEqual(['stdout', 'stderr', 'stdout']);
  });

  it('reports a log that cannot be read', async () => {
    const { docker } = setup(['viewer']);
    await expect(docker.logTail({ serverId: 'srv-1', containerId: 'ghost' })).rejects.toThrow(
      'No such container: ghost',
    );
  });

  it('says which container or volume went, so its file sessions can close (E27)', async () => {
    const core = new FakeCore(() => Date.now());
    const hubs = fakeLiveHubs(core);
    const removed: string[] = [];
    const docker = new DeployDocker({
      links: new CoreLinks({ open: async () => hubs.open() }),
      roles: () => ['owner'],
      removed: (serverId, kind, id) => removed.push(`${serverId} ${kind} ${id}`),
    });

    await docker.remove({
      serverId: 'srv-1',
      containerId: 'migrate-once',
      removeVolumes: false,
      force: false,
    });
    await docker.removeVolume({ serverId: 'srv-1', volume: 'old-cache', force: false });
    await docker
      .removeVolume({ serverId: 'srv-1', volume: 'nope', force: false })
      .catch(() => undefined);

    expect(removed).toEqual(['srv-1 container migrate-once', 'srv-1 volume old-cache']);
  });

  it('lists, pulls and removes images, volumes and networks, and prunes', async () => {
    const { core, docker } = setup(['owner']);
    expect((await docker.listImages('srv-1')).map((image) => image.tags[0])).toContain(
      'nginx:1.29',
    );
    const pull = await docker.pullImage({ serverId: 'srv-1', reference: 'redis:8' });
    expect(pull).toMatchObject({ kind: 'imagePull', title: 'Pull redis:8', state: 'running' });
    await docker.removeImage({ serverId: 'srv-1', image: 'debian:13', force: true });
    expect(core.docker.images.some((image) => image.tags.includes('debian:13'))).toBe(false);

    expect(await docker.listVolumes('srv-1')).toHaveLength(3);
    await docker.removeVolume({ serverId: 'srv-1', volume: 'old-cache', force: false });
    expect(core.docker.volumes.map((volume) => volume.name)).not.toContain('old-cache');

    expect(await docker.listNetworks('srv-1')).toHaveLength(3);
    await expect(docker.removeNetwork('srv-1', 'bridge')).rejects.toThrow('bridge is built in.');
    await docker.removeNetwork('srv-1', 'shop_default');

    expect((await docker.diskUsage('srv-1')).buildCache.reclaimableBytes).toBeGreaterThan(0);
    expect(await docker.prune({ serverId: 'srv-1', target: 'images' })).toEqual({
      removed: 2,
      reclaimedBytes: 124_000_000,
    });
    expect(core.docker.pruned).toEqual([
      { target: 'images', allImages: false, includeVolumes: false },
    ]);
  });

  it('installs Docker as a job, which fails without agreement to remove what is in the way', async () => {
    const { core, docker } = setup(['admin']);
    core.docker.status = {
      ...core.docker.status,
      installed: false,
      conflictingPackages: ['podman'],
    };

    const refused = await docker.install({ serverId: 'srv-1', removeConflictingPackages: false });
    expect(refused).toMatchObject({ kind: 'dockerInstall', state: 'failed' });

    const job = await docker.install({ serverId: 'srv-1', removeConflictingPackages: true });
    expect(job).toMatchObject({ kind: 'dockerInstall', state: 'running' });
  });
});
