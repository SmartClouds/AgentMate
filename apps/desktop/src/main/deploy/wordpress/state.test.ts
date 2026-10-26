import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import { type StoredWpSite, WordPressBases, WordPressState, wordPressStateFilePort } from './state';
import { WP_VECTORS } from './testing/vectors';

/**
 * The WordPress store keeps sites and bases on disk, drops whatever it cannot trust, moves every
 * sealed secret on a passkey change, and never writes a secret in the clear.
 */

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function temp(): string {
  const dir = mkdtempSync(join(tmpdir(), 'runova-wp-state-'));
  dirs.push(dir);
  return dir;
}

const sealed = (text: string): SecretEnvelope => ({ mode: 'safeStorage', ciphertext: `x${text}` });

export function storedSite(overrides: Partial<StoredWpSite> = {}): StoredWpSite {
  return {
    id: '6f1c2a9e-3b7d-4c51-9e0a-2d8f4b6c1a03',
    label: 'Shop',
    siteUrl: 'https://shop.example',
    restUrl: 'https://shop.example/wp-json/runova/v1',
    ajaxUrl: 'https://shop.example/wp-admin/admin-ajax.php',
    rescueUrl: null,
    siteName: 'Shop',
    scope: 'write',
    sitePublicKey: WP_VECTORS.keys.site.publicKey,
    connectionId: 'c0nn-1',
    connectionExpiresAt: null,
    publicKey: WP_VECTORS.keys.desktop.publicKey,
    privateKey: sealed('pem'),
    httpAuth: null,
    allowPlainHttp: false,
    pluginVersion: '1.0.0',
    protocol: 1,
    endpoint: null,
    clockOffset: 0,
    connectedAt: 1_790_000_000_000,
    lastSeenAt: null,
    ...overrides,
  };
}

describe('WordPressState', () => {
  it('saves, changes and forgets sites in a 0600 file', async () => {
    const path = join(temp(), 'data', 'deploy-wordpress.json');
    const state = new WordPressState(wordPressStateFilePort(path));
    expect(await state.sites()).toEqual([]);

    await state.saveSite(storedSite());
    await state.saveSite(storedSite({ id: 'second', label: 'Blog' }));
    await state.saveSite(storedSite({ label: 'Shop 2' }));
    expect((await state.sites()).map((site) => site.label)).toEqual(['Shop 2', 'Blog']);

    const changed = await state.updateSite('second', (site) => ({ ...site, label: 'Notes' }));
    expect(changed?.label).toBe('Notes');
    expect(await state.updateSite('missing', (site) => site)).toBeNull();
    expect((await state.site('second'))?.label).toBe('Notes');
    expect(await state.site('missing')).toBeNull();

    await state.setInflight({
      siteId: 'second',
      deployId: 'd1',
      projectId: null,
      operationId: 'op-12345678',
      startedAt: 1,
    });
    expect((await state.inflight('second'))?.deployId).toBe('d1');
    await state.clearInflight('second', 'other');
    expect(await state.inflight('second')).not.toBeNull();
    await state.clearInflight('second', 'd1');
    expect(await state.inflight('second')).toBeNull();

    await state.setInflight({
      siteId: 'second',
      deployId: 'd2',
      projectId: 'p1',
      operationId: 'op-12345678',
      startedAt: 1,
    });
    await state.removeSite('second');
    expect(await state.inflight('second')).toBeNull();
    expect((await state.sites()).map((site) => site.id)).toEqual([storedSite().id]);

    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readFileSync(path, 'utf-8')).not.toContain('BEGIN PRIVATE KEY');
  });

  it('drops records it cannot trust', async () => {
    const path = join(temp(), 'deploy-wordpress.json');
    const good = storedSite();
    writeFileSync(
      path,
      JSON.stringify({
        version: 1,
        sites: [
          good,
          { ...good, id: 'dup' + '' },
          { ...good, id: '../x' },
          { ...good, id: 'b', sitePublicKey: 'short' },
          { ...good, id: 'c', privateKey: { mode: 'plain', ciphertext: 'x' } },
          { ...good, id: 'd', restUrl: 'ftp://x' },
          { ...good, id: 'e', connectionId: '-' },
          { ...good, id: 'f', httpAuth: { username: 'u', password: 'p' } },
          { ...good, id: 'g', endpoint: 'soap' },
          { ...good, id: 'h', connectedAt: -1 },
          { ...good, id: good.id, label: 'second copy' },
          null,
        ],
        inflight: {
          dup: { siteId: 'dup', deployId: 'd1', projectId: null, operationId: 'o', startedAt: 1 },
          other: { siteId: 'dup', deployId: 'd1', projectId: null, operationId: 'o', startedAt: 1 },
          bad: { siteId: 'bad', deployId: '../', projectId: null, operationId: 'o', startedAt: 1 },
        },
      }),
    );
    const state = new WordPressState(wordPressStateFilePort(path));
    expect((await state.sites()).map((site) => site.id)).toEqual([good.id, 'dup']);
    expect((await state.inflight('dup'))?.deployId).toBe('d1');
    expect(await state.inflight('other')).toBeNull();

    writeFileSync(path, 'not json');
    expect(await state.sites()).toEqual([]);
    writeFileSync(path, JSON.stringify({ version: 2, sites: [good] }));
    expect(await state.sites()).toEqual([]);
  });

  it('moves every sealed secret on a passkey change, and only commits when asked', async () => {
    const path = join(temp(), 'deploy-wordpress.json');
    const state = new WordPressState(wordPressStateFilePort(path));
    await state.saveSite(storedSite({ httpAuth: { username: 'stage', password: sealed('pw') } }));
    await state.saveSite(storedSite({ id: 'plain' }));

    const commit = await state.sealedKeys.prepare(async (envelope) => ({
      mode: 'passphrase',
      iv: 'iv',
      authTag: 'tag',
      ciphertext: `moved:${envelope.ciphertext}`,
    }));
    expect((await state.site('plain'))?.privateKey.mode).toBe('safeStorage');
    // A site added between prepare and commit is left alone.
    await state.saveSite(storedSite({ id: 'late' }));
    await commit();

    const first = await state.site(storedSite().id);
    expect(first?.privateKey).toEqual({
      mode: 'passphrase',
      iv: 'iv',
      authTag: 'tag',
      ciphertext: 'moved:xpem',
    });
    expect(first?.httpAuth?.password.ciphertext).toBe('moved:xpw');
    expect((await state.site('plain'))?.privateKey.ciphertext).toBe('moved:xpem');
    expect((await state.site('plain'))?.httpAuth).toBeNull();
    expect((await state.site('late'))?.privateKey.ciphertext).toBe('xpem');
  });

  it('survives a write that fails and keeps the queue going', async () => {
    let fail = true;
    const store: { value: unknown } = { value: null };
    const state = new WordPressState({
      read: async () => store.value,
      write: async (value) => {
        if (fail) throw new Error('disk full');
        store.value = value;
      },
    });
    await expect(state.saveSite(storedSite())).rejects.toThrow('disk full');
    fail = false;
    await state.saveSite(storedSite());
    expect(await state.sites()).toHaveLength(1);
  });
});

describe('WordPressBases', () => {
  const base = {
    version: 1 as const,
    siteId: storedSite().id,
    sitePublicKey: WP_VECTORS.keys.site.publicKey,
    siteOrigin: 'https://shop.example',
    updatedAt: 5,
    items: {
      'theme:shop': {
        isFile: false,
        files: { 'style.css': { sha256: 'a'.repeat(64), size: 10 } },
      },
    },
  };

  it('writes, promotes and removes bases outside any project folder', async () => {
    const root = join(temp(), 'bases');
    const bases = new WordPressBases(root);
    expect(await bases.read('p1')).toBeNull();
    await bases.write('p1', base);
    expect(await bases.read('p1')).toEqual(base);

    expect(await bases.promotePending('p1')).toBe(false);
    const next = { ...base, updatedAt: 9 };
    await bases.writePending('p1', next);
    expect(await bases.readPending('p1')).toEqual(next);
    expect(await bases.promotePending('p1')).toBe(true);
    expect((await bases.read('p1'))?.updatedAt).toBe(9);
    expect(await bases.readPending('p1')).toBeNull();

    await bases.writePending('p1', next);
    await bases.remove('p1');
    expect(await bases.read('p1')).toBeNull();
    expect(await bases.readPending('p1')).toBeNull();
    if (process.platform !== 'win32') {
      await bases.write('p2', base);
      expect(statSync(join(root, 'p2.json')).mode & 0o777).toBe(0o600);
    }
  });

  it('refuses project ids that would leave the folder', async () => {
    const bases = new WordPressBases(temp());
    await expect(bases.read('../evil')).rejects.toThrow('not a project');
    await expect(bases.write('a/b', base)).rejects.toThrow('not a project');
  });

  it('drops entries it cannot trust', async () => {
    const root = temp();
    const bases = new WordPressBases(root);
    writeFileSync(
      join(root, 'p1.json'),
      JSON.stringify({
        ...base,
        items: {
          'theme:shop': {
            isFile: false,
            files: {
              'style.css': { sha256: 'a'.repeat(64), size: 10 },
              '../wp-config.php': { sha256: 'a'.repeat(64), size: 1 },
              '.claude/settings.json': { sha256: 'a'.repeat(64), size: 1 },
              'upper.css': { sha256: 'A'.repeat(64), size: 1 },
              'neg.css': { sha256: 'a'.repeat(64), size: -1 },
              'odd.css': 'x',
            },
          },
          'widget:x': { isFile: false, files: {} },
          'plugin:p': { isFile: 'no', files: {} },
          'plugin:q': { isFile: true, files: null },
        },
      }),
    );
    const read = await bases.read('p1');
    expect(Object.keys(read?.items ?? {})).toEqual(['theme:shop', 'plugin:q']);
    expect(Object.keys(read?.items['theme:shop'].files ?? {})).toEqual(['style.css']);

    for (const bad of [
      { ...base, version: 2 },
      { ...base, siteId: '../' },
      { ...base, updatedAt: 'x' },
      { ...base, sitePublicKey: 'short' },
      { ...base, siteOrigin: undefined },
    ]) {
      writeFileSync(join(root, 'p1.json'), JSON.stringify(bad));
      expect(await bases.read('p1')).toBeNull();
    }
    writeFileSync(join(root, 'p1.json'), JSON.stringify({ ...base, items: [] }));
    expect((await bases.read('p1'))?.items).toEqual({});
  });
});
