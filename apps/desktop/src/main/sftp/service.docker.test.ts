import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { filesErrorCode } from '../../shared/deployFilesErrors';
import { dockerFileTargetId } from '../../shared/fileTargets';
import { tempDir } from '../../test/main/fixtures';
import { createDockerFilePool, routeFilePool } from '../deploy/dockerFiles/pool';
import { describeDockerTarget } from '../deploy/dockerFiles/targets';
import {
  type FakeDockerFiles,
  startFakeDockerFiles,
} from '../deploy/dockerFiles/testing/fakeBackend';
import { LocalBrowseRegistry } from './localBrowse';
import { SftpService } from './service';
import { FakeSftpServer } from './testing/fakeSftpClient';

/**
 * The file manager's sessions on containers and volumes (E27), through the same service as a
 * saved server's disk: the routing pool, the Docker target's description, what the session
 * allows and why, partial listings, and a core session that ended being opened again.
 */

const OWNER = 1;
const SERVER = 'srv-1';
const WEB = dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'shop-web-1' });
const STOPPED = dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'migrate-once' });
const UPLOADS = dockerFileTargetId({ serverId: SERVER, kind: 'volume', id: 'shop_uploads' });
const GONE = dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'deleted-1' });

let fixture: FakeDockerFiles;

beforeEach(async () => {
  fixture = await startFakeDockerFiles();
});

afterEach(async () => {
  await fixture.close();
});

function setup() {
  const ssh = new FakeSftpServer({ home: '/home/deploy' });
  const docker = createDockerFilePool({ backend: () => fixture.backend });
  const service = new SftpService({
    pool: routeFilePool(ssh.pool, docker),
    findServer: async (serverId) =>
      serverId === 'ssh-1'
        ? { nickname: 'web', host: 'web.example.com', port: 22, username: 'deploy' }
        : describeDockerTarget(serverId, {
            backend: () => fixture.backend,
            serverName: async (id) => (id === SERVER ? 'prod' : null),
            lastSession: (id) => docker.lastSession(id),
          }),
    send: () => undefined,
    keepAwake: () => undefined,
    tempDir: () => join(tempDir('agentmate-sftp-docker-'), 'edits'),
    localBrowse: new LocalBrowseRegistry(),
    engine: { platform: 'linux' },
  });
  return { service, ssh, docker };
}

describe('SftpService on Docker targets', () => {
  it('opens a container with its kind, what it allows and who it works as', async () => {
    fixture.core.files.homes.set('shop-web-1', '/usr/share/nginx/html');
    fixture.core.files.tree({ kind: 'container', id: 'shop-web-1' }).dir('/usr/share/nginx/html');
    const { service } = setup();

    const info = await service.open(OWNER, WEB);

    expect(info).toEqual({
      sessionId: expect.any(String),
      serverId: WEB,
      nickname: 'shop-web-1 (container)',
      host: 'prod',
      port: 0,
      username: 'root',
      home: '/usr/share/nginx/html',
      kind: 'container',
      capabilities: { rename: true, remove: true, chmod: true, edit: true },
      limitation: null,
    });
  });

  it('says why a stopped container cannot rename, delete or change permissions', async () => {
    const { service } = setup();

    const info = await service.open(OWNER, STOPPED);

    expect(info.kind).toBe('container');
    expect(info.capabilities).toEqual({ rename: false, remove: false, chmod: false, edit: false });
    expect(info.limitation).toMatch(/stopped/);
  });

  it('opens a volume at its root', async () => {
    const { service } = setup();

    const info = await service.open(OWNER, UPLOADS);

    expect(info).toMatchObject({ kind: 'volume', nickname: 'shop_uploads (volume)', home: '/' });
  });

  it('answers a saved server the way it always did, as kind ssh', async () => {
    const { service } = setup();

    const info = await service.open(OWNER, 'ssh-1');

    expect(info.kind).toBe('ssh');
    expect(info).not.toHaveProperty('capabilities');
    expect(info).not.toHaveProperty('limitation');
  });

  it('reports a container that is not there as gone', async () => {
    const { service } = setup();

    const refused = await service.open(OWNER, GONE).catch((error: unknown) => error);

    expect(filesErrorCode(refused)).toBe('siteUnknown');
  });

  it('marks a listing the core cut short, and only that one', async () => {
    fixture.core.files.noShell.add('toolbox');
    fixture.core.files.scanCap = 1;
    fixture.core.files
      .tree({ kind: 'container', id: 'toolbox' })
      .file('/x/a', '')
      .file('/x/b', '')
      .file('/y/only', '');
    const { service } = setup();
    const toolbox = await service.open(
      OWNER,
      dockerFileTargetId({ serverId: SERVER, kind: 'container', id: 'toolbox' }),
    );
    const ssh = await service.open(OWNER, 'ssh-1');

    const cut = await service.list(OWNER, toolbox.sessionId, '/x');
    const whole = await service.list(OWNER, toolbox.sessionId, '/y');
    const disk = await service.list(OWNER, ssh.sessionId, '~');

    expect(cut.partial).toBe(true);
    expect(cut.entries).toHaveLength(1);
    expect(whole).not.toHaveProperty('partial');
    expect(disk).not.toHaveProperty('partial');
  });

  it('opens a new core session when the old one ended, and carries on', async () => {
    fixture.core.files.tree({ kind: 'volume', id: 'shop_uploads' }).file('/a.txt', 'a');
    const { service } = setup();
    const { sessionId } = await service.open(OWNER, UPLOADS);
    fixture.core.files.expire();

    const listing = await service.list(OWNER, sessionId, '/');

    expect(listing.entries.map((entry) => entry.name)).toEqual(['a.txt']);
    expect(fixture.core.files.opened).toHaveLength(2);
  });

  it('closes its core sessions with the file manager session', async () => {
    const { service } = setup();
    const { sessionId } = await service.open(OWNER, UPLOADS);

    await service.close(OWNER, sessionId);

    await expect.poll(() => fixture.core.files.openSessions).toBe(0);
  });

  it('names the targets it has sessions on', async () => {
    const { service } = setup();
    await service.open(OWNER, UPLOADS);
    await service.open(OWNER, 'ssh-1');

    expect(service.serverIds().sort()).toEqual([UPLOADS, 'ssh-1'].sort());
  });
});
