import type { SaveVaultEntryInput } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { openVaultFile, type VaultFileV1 } from './format';
import type { KdfCost } from './kdf';
import { VaultError, VaultSession } from './session';
import { MemoryVaultFiles } from './testing/memoryVaultFiles';

const FAST: KdfCost = { N: 1024, r: 8, p: 1 };
const PASSWORD = 'correct horse battery staple';
const NEW_PASSWORD = 'violet lantern orbit 42';

let clock = 1_000;
let ids = 0;

function makeSession(files = new MemoryVaultFiles(), cost: KdfCost = FAST) {
  const session = new VaultSession({
    files,
    cost,
    now: () => clock,
    newId: () => `id${++ids}`,
    lastUsedFlushMs: 2000,
  });
  return { session, files };
}

const login = (overrides: Partial<Extract<SaveVaultEntryInput, { type: 'login' }>> = {}) =>
  ({
    type: 'login',
    title: 'GitHub',
    tags: [],
    favorite: false,
    notes: 'S3NT1NEL-notes',
    username: 'octo',
    password: 'S3NT1NEL-password',
    urls: ['github.com'],
    totpSecret: '',
    ...overrides,
  }) satisfies SaveVaultEntryInput;

async function expectCode(promise: Promise<unknown> | (() => unknown), code: string) {
  try {
    await (typeof promise === 'function' ? promise() : promise);
  } catch (error) {
    expect(error).toBeInstanceOf(VaultError);
    expect((error as VaultError).code).toBe(code);
    return;
  }
  throw new Error(`expected VaultError ${code}`);
}

beforeEach(() => {
  clock = 1_000;
  ids = 0;
});

afterEach(() => {
  vi.useRealTimers();
});

describe('VaultSession lifecycle', () => {
  it('starts uninitialized, creates, locks and unlocks', async () => {
    const { session, files } = makeSession();
    expect(await session.state()).toBe('uninitialized');
    await expectCode(session.unlock(PASSWORD), 'uninitialized');

    await session.create(PASSWORD);
    expect(await session.state()).toBe('unlocked');
    expect(files.writes).toBe(1);
    expect(session.list()).toEqual([]);

    await session.lock();
    expect(await session.state()).toBe('locked');
    expect(await session.unlock('wrong password here')).toBe(false);
    expect(await session.state()).toBe('locked');
    expect(await session.unlock(PASSWORD)).toBe(true);
    expect(await session.state()).toBe('unlocked');
  });

  it('refuses to create twice or with a weak password', async () => {
    const { session } = makeSession();
    await expectCode(session.create('short'), 'weak-password');
    await expectCode(session.create('password1234'), 'weak-password');
    await session.create(PASSWORD);
    await expectCode(session.create(PASSWORD), 'exists');
  });

  it('reads nothing and writes nothing while locked', async () => {
    const { session } = makeSession();
    await session.create(PASSWORD);
    const saved = await session.save(login());
    await session.lock();
    await expectCode(() => session.list(), 'locked');
    await expectCode(() => session.reveal(saved.id, 'password'), 'locked');
    await expectCode(session.save(login()), 'locked');
    await expectCode(session.remove([saved.id]), 'locked');
  });

  it('reports a damaged file as corrupt instead of a wrong password', async () => {
    const files = new MemoryVaultFiles();
    files.current = { format: 'agentmate-vault' as const /* legacy-name */, version: 1 };
    const { session } = makeSession(files);
    expect(await session.state()).toBe('locked');
    await expectCode(session.unlock(PASSWORD), 'corrupt');
  });

  it('persists across sessions', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    await session.save(login());
    await session.lock();

    const { session: again } = makeSession(files);
    expect(await again.state()).toBe('locked');
    expect(await again.unlock(PASSWORD)).toBe(true);
    expect(again.list().map((s) => s.title)).toEqual(['GitHub']);
  });

  it('changes the master password and rotates the data key', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    await session.save(login());
    const before = files.current as VaultFileV1;

    expect(await session.changePassword('not it at all', NEW_PASSWORD)).toBe(false);
    await expectCode(session.changePassword(PASSWORD, 'weak'), 'weak-password');
    expect(await session.changePassword(PASSWORD, NEW_PASSWORD)).toBe(true);

    const after = files.current as VaultFileV1;
    expect(after.keyWrap.ciphertext).not.toBe(before.keyWrap.ciphertext);
    expect(after.kdf.salt).not.toBe(before.kdf.salt);
    expect(await openVaultFile(after, PASSWORD)).toBe('wrong-password');
    const oldOpened = await openVaultFile(before, PASSWORD);
    const newOpened = await openVaultFile(after, NEW_PASSWORD);
    if (typeof oldOpened === 'string' || typeof newOpened === 'string')
      throw new Error('open failed');
    expect(newOpened.dataKey.equals(oldOpened.dataKey)).toBe(false);
    expect(session.list()).toHaveLength(1);
  });

  it('verifies the current password without changing anything', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    const writes = files.writes;
    expect(await session.verifyPassword(PASSWORD)).toBe(true);
    expect(await session.verifyPassword('nope nope nope')).toBe(false);
    expect(files.writes).toBe(writes);
  });

  it('resets by moving the file aside and starting over', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    await session.reset();
    expect(await session.state()).toBe('uninitialized');
    expect(Object.keys(files.aside)).toEqual([expect.stringMatching(/^vault\.json\.reset-/)]);
  });

  it('upgrades a weak KDF cost the first time it unlocks', async () => {
    const files = new MemoryVaultFiles();
    const { session } = makeSession(files, FAST);
    await session.create(PASSWORD);
    await session.lock();
    const stronger: KdfCost = { N: 4096, r: 8, p: 1 };
    const { session: upgraded } = makeSession(files, stronger);
    expect(await upgraded.unlock(PASSWORD)).toBe(true);
    expect((files.current as VaultFileV1).kdf).toMatchObject(stronger);
    await upgraded.lock();
    expect(await upgraded.unlock(PASSWORD)).toBe(true);
  });
});

describe('VaultSession entries', () => {
  it('saves, lists summaries without secrets, and reveals on request', async () => {
    const { session } = makeSession();
    await session.create(PASSWORD);
    const summary = await session.save(login());
    expect(summary).toMatchObject({ title: 'GitHub', host: 'github.com', hasPassword: true });
    expect(JSON.stringify(session.list())).not.toContain('S3NT1NEL');
    expect(session.reveal(summary.id, 'password')).toBe('S3NT1NEL-password');
    expect(session.getEntry(summary.id)).toMatchObject({ notes: 'S3NT1NEL-notes' });
    await expectCode(() => session.reveal('missing', 'password'), 'not-found');
    await expectCode(() => session.reveal(summary.id, 'secret'), 'not-found');
  });

  it('keeps the stored password when an edit leaves it undefined', async () => {
    const { session } = makeSession();
    await session.create(PASSWORD);
    const saved = await session.save(login());
    clock = 5_000;
    await session.save(login({ id: saved.id, title: 'GitHub work', password: undefined }));
    expect(session.reveal(saved.id, 'password')).toBe('S3NT1NEL-password');
    expect(session.list()[0]).toMatchObject({ title: 'GitHub work', updatedAt: 5_000 });
  });

  it('rejects invalid input with an invalid code and an unknown id with not-found', async () => {
    const { session } = makeSession();
    await session.create(PASSWORD);
    await expectCode(session.save(login({ title: '   ' })), 'invalid');
    await expectCode(session.save({ nonsense: true } as unknown as SaveVaultEntryInput), 'invalid');
    await expectCode(session.save(login({ id: 'ghost' })), 'not-found');
  });

  it('patches favorite and tags, duplicates and removes', async () => {
    const { session } = makeSession();
    await session.create(PASSWORD);
    const a = await session.save(login());
    const b = await session.save(login({ title: 'GitLab', urls: ['gitlab.com'] }));

    expect(await session.patch(a.id, { favorite: true, tags: [' Work ', 'work'] })).toMatchObject({
      favorite: true,
      tags: ['Work'],
    });
    const copy = await session.duplicate(a.id);
    expect(copy.title).toBe('GitHub (copy)');
    expect(session.reveal(copy.id, 'password')).toBe('S3NT1NEL-password');

    expect(await session.remove([a.id, b.id, 'missing'])).toBe(2);
    expect(session.list().map((s) => s.id)).toEqual([copy.id]);
  });

  it('runs concurrent saves one after another so none is lost', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    await Promise.all(
      Array.from({ length: 20 }, (_, i) => session.save(login({ title: `Entry ${i}` }))),
    );
    expect(session.list()).toHaveLength(20);

    await session.lock();
    const { session: fresh } = makeSession(files);
    await fresh.unlock(PASSWORD);
    expect(fresh.list()).toHaveLength(20);
  });

  it('leaves memory untouched when the write fails', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    await session.save(login());
    files.failWrites = true;
    await expect(session.save(login({ title: 'Never' }))).rejects.toThrow('disk full');
    expect(session.list().map((s) => s.title)).toEqual(['GitHub']);
    files.failWrites = false;
    await session.save(login({ title: 'Later' }));
    expect(session.list()).toHaveLength(2);
  });

  it('records last use right away in memory but batches the write', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    const saved = await session.save(login());
    const writes = files.writes;

    clock = 9_000;
    session.markUsed(saved.id);
    session.markUsed(saved.id);
    expect(session.list()[0].lastUsedAt).toBe(9_000);
    expect(files.writes).toBe(writes);

    await vi.advanceTimersByTimeAsync(2000);
    await vi.waitFor(() => expect(files.writes).toBe(writes + 1));
  });

  it('flushes a pending last-use write when locking', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    const saved = await session.save(login());
    clock = 7_000;
    session.markUsed(saved.id);
    await session.lock();

    const { session: fresh } = makeSession(files);
    await fresh.unlock(PASSWORD);
    expect(fresh.list()[0].lastUsedAt).toBe(7_000);
  });

  it('replaces all entries in one write for imports', async () => {
    const { session, files } = makeSession();
    await session.create(PASSWORD);
    await session.save(login());
    const writes = files.writes;
    await session.replaceAll((entries) => [
      ...entries,
      { ...entries[0], id: 'imported', title: 'Imported' },
    ]);
    expect(files.writes).toBe(writes + 1);
    expect(
      session
        .list()
        .map((s) => s.title)
        .sort(),
    ).toEqual(['GitHub', 'Imported']);
    expect(session.allEntries()).toHaveLength(2);
  });

  it('drops decrypted entries on lock', async () => {
    const { session } = makeSession();
    await session.create(PASSWORD);
    await session.save(login());
    await session.lock();
    expect(JSON.stringify(session)).not.toContain('S3NT1NEL');
  });
});
