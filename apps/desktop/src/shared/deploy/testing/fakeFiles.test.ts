import { describe, expect, it } from 'vitest';
import type { FileEntry } from '../protocol/generated/AgentMate.ServerCore.Contracts';
import { FakeCore } from './fakeCore';
import { FAKE_FILES_IDLE_MS, FakeFilesError } from './fakeFiles';

/**
 * The fake core's file trees (E27) keep the rules the desktop's Docker file client leans on: a
 * session per container or volume, Admins only, coded refusals, and the actions a stopped or
 * shell-less container turns down.
 */

const T0 = Date.UTC(2026, 9, 22, 9, 0, 0);
const S = 0o100000;
const D = 0o040000;

function setup() {
  let now = T0;
  const core = new FakeCore(() => now);
  return {
    core,
    files: core.files,
    hub: core.connect(),
    advance: (ms: number) => {
      now += ms;
    },
  };
}

function codeOf(work: () => unknown): string | null {
  try {
    work();
  } catch (error) {
    return error instanceof FakeFilesError ? error.code : `not coded: ${String(error)}`;
  }
  return null;
}

async function hubFailure(work: Promise<unknown>): Promise<string> {
  try {
    await work;
  } catch (error) {
    return (error as Error).message;
  }
  throw new Error('expected a failure');
}

describe('FakeFiles', () => {
  it('opens a running container with everything allowed and a volume at /', async () => {
    const { hub } = setup();

    const web = await hub.filesOpen({ kind: 'container', id: 'shop-web-1' });
    const volume = await hub.filesOpen({ kind: 'volume', id: 'shop_uploads' });

    expect(web).toMatchObject({
      target: { kind: 'container', id: 'shop-web-1' },
      displayName: 'shop-web-1',
      home: '/',
      user: 'root',
      capabilities: { rename: true, remove: true, chmod: true, atomicUpload: true },
    });
    expect(web.limitation).toBeUndefined();
    expect(volume).toMatchObject({ displayName: 'shop_uploads', home: '/' });
    expect(web.sessionId).not.toBe(volume.sessionId);
  });

  it('only lists, transfers and makes folders in a stopped or shell-less container', async () => {
    const { hub, files } = setup();
    files.noShell.add('shop-api-1');

    const stopped = await hub.filesOpen({ kind: 'container', id: 'migrate-once' });
    const distroless = await hub.filesOpen({ kind: 'container', id: 'shop-api-1' });

    const none = { rename: false, remove: false, chmod: false, atomicUpload: false };
    expect(stopped.capabilities).toEqual(none);
    expect(stopped.limitation).toMatch(/stopped/);
    expect(distroless.capabilities).toEqual(none);
    expect(distroless.limitation).toMatch(/no shell/);

    files.tree({ kind: 'container', id: 'migrate-once' }).file('/a.txt', 'a');
    const sessionId = stopped.sessionId;
    await hub.filesMkdir({ sessionId, path: '/made' });
    expect(await hubFailure(hub.filesRename({ sessionId, from: '/a.txt', to: '/b.txt' }))).toMatch(
      /HubException: \[files:unsupported\] .*stopped/,
    );
    expect(
      await hubFailure(hub.filesRemove({ sessionId, path: '/a.txt', directory: false })),
    ).toMatch(/\[files:unsupported\]/);
    expect(await hubFailure(hub.filesChmod({ sessionId, path: '/a.txt', mode: 0o600 }))).toMatch(
      /\[files:unsupported\]/,
    );
  });

  it('turns away anyone but an Admin, the way the hub policy does', async () => {
    const { core, hub } = setup();
    core.roles = ['operator'];

    expect(await hubFailure(hub.filesOpen({ kind: 'volume', id: 'old-cache' }))).toMatch(
      /because user is unauthorized/,
    );
  });

  it('refuses a target that is not there, and a session once its target goes', async () => {
    const { core, hub } = setup();
    expect(await hubFailure(hub.filesOpen({ kind: 'container', id: 'nope' }))).toMatch(
      /\[files:notFound\]/,
    );

    const { sessionId } = await hub.filesOpen({ kind: 'container', id: 'migrate-once' });
    core.docker.remove({ containerId: 'migrate-once', removeVolumes: false, force: false });

    expect(await hubFailure(hub.filesList({ sessionId, path: '/' }))).toMatch(
      /\[files:targetGone\]/,
    );
  });

  it('ends a session after 15 minutes without a call, and on close', async () => {
    const { hub, advance, files } = setup();
    const first = await hub.filesOpen({ kind: 'volume', id: 'old-cache' });
    const second = await hub.filesOpen({ kind: 'volume', id: 'old-cache' });

    advance(FAKE_FILES_IDLE_MS - 1);
    await hub.filesList({ sessionId: first.sessionId, path: '/' });
    advance(2);
    expect(await hubFailure(hub.filesList({ sessionId: second.sessionId, path: '/' }))).toMatch(
      /\[files:sessionGone\]/,
    );

    await hub.filesClose(first.sessionId);
    expect(files.closed).toEqual([first.sessionId]);
    expect(
      await hubFailure(hub.filesStat({ sessionId: first.sessionId, path: '/' })),
    ).toMatch(/\[files:sessionGone\]/);
  });

  it('lists entries with the full mode, lstat links and marks broken ones', async () => {
    const { files, hub } = setup();
    const tree = files.tree({ kind: 'volume', id: 'shop_uploads' });
    tree
      .dir('/site', 0o750)
      .file('/site/a.txt', 'hello', { mode: 0o640, mtimeMs: T0 + 999, uid: 33, gid: 33 })
      .link('/site/to-a', 'a.txt')
      .link('/site/to-dir', '/site')
      .link('/site/gone', '/nowhere');
    const { sessionId } = await hub.filesOpen({ kind: 'volume', id: 'shop_uploads' });

    const listing = await hub.filesList({ sessionId, path: '/site/' });

    const byName = (name: string) => listing.entries.find((entry) => entry.name === name);
    expect(listing.path).toBe('/site');
    expect(listing.partial).toBe(false);
    expect(listing.entries.map((entry) => entry.name)).toEqual([
      'a.txt',
      'gone',
      'to-a',
      'to-dir',
    ]);
    expect(byName('a.txt')).toEqual<FileEntry>({
      name: 'a.txt',
      kind: 'file',
      size: 5,
      mtimeUnixMs: T0,
      mode: S | 0o640,
      uid: 33,
      gid: 33,
      linkIsDirectory: false,
      brokenLink: false,
    });
    expect(byName('to-a')).toMatchObject({
      kind: 'symlink',
      size: 5,
      mode: 0o120777,
      linkTarget: 'a.txt',
      linkIsDirectory: false,
      brokenLink: false,
    });
    expect(byName('to-dir')).toMatchObject({ linkIsDirectory: true, brokenLink: false });
    expect(byName('gone')).toMatchObject({ brokenLink: true, linkTarget: '/nowhere' });
    await expect(hub.filesStat({ sessionId, path: '/site/to-a' })).resolves.toMatchObject({
      kind: 'symlink',
    });
    await expect(hub.filesStat({ sessionId, path: '/site/none' })).resolves.toBeNull();
    await expect(hub.filesRealpath({ sessionId, path: '/site/to-dir/./to-a' })).resolves.toBe(
      '/site/a.txt',
    );
    await expect(hub.filesStat({ sessionId, path: '/' })).resolves.toMatchObject({
      kind: 'directory',
      mode: D | 0o755,
    });
  });

  it('cuts a shell-less listing short past its cap and says so', async () => {
    const { files, hub } = setup();
    files.noShell.add('toolbox');
    files.scanCap = 2;
    const tree = files.tree({ kind: 'container', id: 'toolbox' });
    tree.dir('/many').file('/many/a', '').file('/many/b', '').file('/many/c', '');
    const { sessionId } = await hub.filesOpen({ kind: 'container', id: 'toolbox' });

    const listing = await hub.filesList({ sessionId, path: '/many' });

    expect(listing.partial).toBe(true);
    expect(listing.entries).toHaveLength(2);
  });

  it('codes the failures of each change the way the core does', () => {
    const { files } = setup();
    const tree = files.tree({ kind: 'volume', id: 'old-cache' });
    tree.dir('/full').file('/full/x', 'x').dir('/empty').file('/f', 'f');

    expect(codeOf(() => tree.mkdir('/full'))).toBe('exists');
    expect(codeOf(() => tree.mkdir('/no/parent'))).toBe('notFound');
    expect(codeOf(() => tree.remove('/full', true))).toBe('notEmpty');
    expect(codeOf(() => tree.remove('/f', true))).toBe('notDirectory');
    expect(codeOf(() => tree.remove('/empty', false))).toBe('isDirectory');
    expect(codeOf(() => tree.remove('/missing', false))).toBe('notFound');
    expect(codeOf(() => tree.rename('/f', '/full'))).toBe('exists');
    expect(codeOf(() => tree.rename('/full', '/full/inside'))).toBe('invalidInput');
    expect(codeOf(() => tree.list('/f'))).toBe('notDirectory');
    expect(codeOf(() => tree.read('/full'))).toBe('isDirectory');
    expect(codeOf(() => tree.chmod('/f', 0o10000))).toBe('invalidInput');
    expect(codeOf(() => tree.list('relative'))).toBe('invalidInput');
    expect(codeOf(() => tree.list('/a\0b'))).toBe('invalidInput');

    tree.remove('/empty', true);
    tree.rename('/f', '/full/g');
    expect(tree.list('/').entries.map((entry) => entry.name)).toEqual(['full']);
    expect(new TextDecoder().decode(tree.read('/full/g').bytes)).toBe('f');
  });

  it('writes an upload owned like its folder, keeping the mode of what it replaces', () => {
    const { files } = setup();
    const tree = files.tree({ kind: 'volume', id: 'old-cache' });
    tree.dir('/www', 0o755, { uid: 33, gid: 34 }).file('/www/conf', 'old', { mode: 0o600 });

    const replaced = tree.write('/www/conf', new TextEncoder().encode('new'));
    const fresh = tree.write('/www/new.txt', new Uint8Array(3), 0o640);

    expect(replaced).toMatchObject({ mode: S | 0o600, size: 3, uid: 33, gid: 34 });
    expect(fresh).toMatchObject({ mode: S | 0o640 });
    expect(tree.write('/www/plain', new Uint8Array(0)).mode).toBe(S | 0o644);
  });

  it('fails the next call of a kind when told to', async () => {
    const { files, hub } = setup();
    const { sessionId } = await hub.filesOpen({ kind: 'volume', id: 'old-cache' });
    files.failNext('list', 'permissionDenied', 'The volume refused it.');

    expect(await hubFailure(hub.filesList({ sessionId, path: '/' }))).toMatch(
      /\[files:permissionDenied\] The volume refused it\./,
    );
    await expect(hub.filesList({ sessionId, path: '/' })).resolves.toMatchObject({ path: '/' });
  });
});
