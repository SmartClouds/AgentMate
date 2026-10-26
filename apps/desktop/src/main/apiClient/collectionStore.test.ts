import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { isFolder, type PostmanRequestItem } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * Collections live one per file under userData/data/api-client/collections, with a small index
 * beside them for order and metadata. These check the round trip through disk, that concurrent
 * saves do not lose each other's changes, and that one broken file does not hide the rest.
 */

const userData = useTempUserData();

let store: typeof import('./collectionStore')['collectionStore'];

beforeEach(async () => {
  ({ collectionStore: store } = await import('./collectionStore'));
});

const request = (id: string, name = 'Get users'): PostmanRequestItem => ({
  id,
  name,
  request: { method: 'GET', url: 'https://api.test/users' },
});

const collectionFile = (id: string) =>
  join(userData.dir, 'data', 'api-client', 'collections', `${id}.json`);

describe('collectionStore', () => {
  it('starts empty', async () => {
    expect(await store.list()).toEqual([]);
  });

  it('creates a collection and lists it with its outline', async () => {
    const created = await store.create('  Billing API ');
    expect(created).toMatchObject({
      name: 'Billing API',
      requestCount: 0,
      tree: [],
      projectIds: [],
    });

    const listed = await store.list();
    expect(listed).toEqual([created]);
    expect(existsSync(collectionFile(created.id))).toBe(true);
    const onDisk = JSON.parse(readFileSync(collectionFile(created.id), 'utf-8'));
    expect(onDisk.info.name).toBe('Billing API');
  });

  it('lists collections in the order they were created', async () => {
    await store.create('A');
    await store.create('B');
    expect((await store.list()).map((c) => c.name)).toEqual(['A', 'B']);
  });

  it('saves a new request at the top level or in a folder, and updates it in place later', async () => {
    const { id } = await store.create('API');
    const { folderId } = await store.createFolder(id, null, 'Users');

    await store.saveRequest({ collectionId: id, parentId: folderId, item: request('r1') });
    await store.saveRequest({ collectionId: id, parentId: null, item: request('r2', 'Health') });
    const summary = await store.saveRequest({
      collectionId: id,
      parentId: null,
      item: request('r1', 'List users'),
    });

    expect(summary.requestCount).toBe(2);
    expect(summary.tree).toEqual([
      {
        id: folderId,
        name: 'Users',
        kind: 'folder',
        children: [{ id: 'r1', name: 'List users', kind: 'request', method: 'GET' }],
      },
      { id: 'r2', name: 'Health', kind: 'request', method: 'GET' },
    ]);
    const collection = await store.get(id);
    const folder = collection.item[0];
    expect(folder && isFolder(folder) && folder.item[0]?.request).toEqual(request('r1').request);
  });

  it('keeps every change when several saves arrive at once', async () => {
    const { id } = await store.create('API');
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        store.saveRequest({ collectionId: id, parentId: null, item: request(`r${i}`) }),
      ),
    );
    expect((await store.get(id)).item).toHaveLength(10);
  });

  it('renames a collection in the index and in the file', async () => {
    const { id } = await store.create('Old');
    await store.rename(id, 'New');
    expect((await store.list())[0]?.name).toBe('New');
    expect((await store.get(id)).info.name).toBe('New');
    await expect(store.rename(id, '   ')).rejects.toThrow(/name/i);
  });

  it('removes items and whole collections', async () => {
    const { id } = await store.create('API');
    await store.saveRequest({ collectionId: id, parentId: null, item: request('r1') });
    await store.removeItem(id, 'r1');
    expect((await store.get(id)).item).toEqual([]);

    await store.remove(id);
    expect(await store.list()).toEqual([]);
    expect(existsSync(collectionFile(id))).toBe(false);
  });

  it('refuses to work on a collection that does not exist', async () => {
    await expect(store.get('nope')).rejects.toThrow(/no longer exists/);
    await expect(
      store.saveRequest({ collectionId: 'nope', parentId: null, item: request('r') }),
    ).rejects.toThrow(/no longer exists/);
  });

  it('lists a collection whose file is broken with the reason, and keeps the rest', async () => {
    const good = await store.create('Good');
    const bad = await store.create('Bad');
    writeFileSync(collectionFile(bad.id), '{ not json', 'utf-8');

    const listed = await store.list();
    expect(listed.find((c) => c.id === good.id)?.error).toBeNull();
    expect(listed.find((c) => c.id === bad.id)).toMatchObject({
      name: 'Bad',
      tree: [],
      error: expect.stringMatching(/could not be read/),
    });
  });
});
