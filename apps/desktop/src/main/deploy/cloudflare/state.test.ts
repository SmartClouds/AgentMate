import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../../shared/apiTypes';
import type { CloudflareTokenReport } from '../../../shared/cloudflareTypes';
import {
  CloudflareState,
  type CloudflareStatePort,
  cloudflareFilePort,
  type StoredCloudflareAccount,
} from './state';

/**
 * Where the Cloudflare accounts live at rest: each token sealed, in cloudflare.json beside the
 * other stores, with the last permission check next to it. Nothing unreadable is trusted, and the
 * single-token file of the first version is read as one account.
 */

const SEALED: SecretEnvelope = { mode: 'safeStorage', ciphertext: 'c2VhbGVk' };
const REPORT: CloudflareTokenReport = {
  tokenId: 'ed17574386854bf78a67040be0a770b0',
  status: 'active',
  expiresOn: null,
  source: 'probes',
  permissions: [
    { id: 'zone', state: 'granted' },
    { id: 'dns', state: 'granted' },
  ],
  zoneCount: 2,
  checkedAt: 1,
};

function account(id: string, label = id): StoredCloudflareAccount {
  return {
    id,
    label,
    token: { envelope: SEALED, tokenId: `token-${id}`, savedAt: 5 },
    report: REPORT,
  };
}

function memoryPort(initial: unknown = null): CloudflareStatePort & { value: unknown } {
  const port = {
    value: initial,
    read: async () => port.value,
    write: async (value: unknown) => {
      port.value = JSON.parse(JSON.stringify(value));
    },
  };
  return port;
}

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

describe('CloudflareState', () => {
  it('keeps each sealed token with its report, and forgets one account at a time', async () => {
    const state = new CloudflareState(memoryPort());
    expect(await state.accounts()).toEqual([]);

    await state.save(account('work'));
    await state.save(account('client'));
    expect((await state.accounts()).map((item) => item.id)).toEqual(['work', 'client']);
    expect((await state.account('work'))?.token.envelope).toEqual(SEALED);
    expect((await state.account('work'))?.report).toEqual(REPORT);

    await state.remove('work');
    expect((await state.accounts()).map((item) => item.id)).toEqual(['client']);
    expect(await state.account('work')).toBeNull();
  });

  it('replaces an account in place when it is saved again', async () => {
    const state = new CloudflareState(memoryPort());
    await state.save(account('work', 'Work'));
    await state.save(account('client'));

    await state.save({
      ...account('work', 'Work'),
      token: { ...account('work').token, savedAt: 9 },
    });

    expect((await state.accounts()).map((item) => item.id)).toEqual(['work', 'client']);
    expect((await state.account('work'))?.token.savedAt).toBe(9);
  });

  it('marks a permission missing on the one account Cloudflare refused', async () => {
    const state = new CloudflareState(memoryPort());
    await state.save(account('work'));
    await state.save(account('client'));

    await state.markMissing('work', 'dns');
    await state.markMissing('work', 'waf');

    expect((await state.account('work'))?.report?.permissions).toEqual([
      { id: 'zone', state: 'granted' },
      { id: 'dns', state: 'missing' },
    ]);
    expect((await state.account('client'))?.report?.permissions[1]).toEqual({
      id: 'dns',
      state: 'granted',
    });
    await state.setReport('work', { ...REPORT, zoneCount: 3 });
    expect((await state.account('work'))?.report?.zoneCount).toBe(3);
    expect((await state.account('client'))?.report?.zoneCount).toBe(2);
  });

  it('does nothing to a report when there is none, or no such account', async () => {
    const state = new CloudflareState(memoryPort());
    await state.save({ ...account('work'), report: null });
    await state.markMissing('work', 'dns');
    await state.markMissing('nobody', 'dns');
    expect((await state.account('work'))?.report).toBeNull();
    expect((await state.accounts()).length).toBe(1);
  });

  it('reads the first version of the file as one account', async () => {
    const state = new CloudflareState(
      memoryPort({
        version: 1,
        token: { envelope: SEALED, tokenId: 'old', savedAt: 3 },
        report: REPORT,
      }),
    );

    const accounts = await state.accounts();

    expect(accounts).toEqual([
      {
        id: 'primary',
        label: 'Cloudflare',
        token: { envelope: SEALED, tokenId: 'old', savedAt: 3 },
        report: REPORT,
      },
    ]);
  });

  it('writes the new version once something changes, keeping a migrated account', async () => {
    const port = memoryPort({
      version: 1,
      token: { envelope: SEALED, tokenId: 'old', savedAt: 3 },
      report: null,
    });
    const state = new CloudflareState(port);

    await state.save(account('client'));

    expect((port.value as { version: number }).version).toBe(2);
    expect((await state.accounts()).map((item) => item.id)).toEqual(['primary', 'client']);
  });

  it('drops what it cannot read rather than trusting it', async () => {
    for (const junk of [
      null,
      'nope',
      { version: 3, accounts: [account('x')] },
      { version: 2 },
      { version: 2, accounts: 'all' },
      {
        version: 1,
        token: { envelope: { mode: 'other', ciphertext: 'x' }, tokenId: 'x', savedAt: 1 },
      },
      { version: 1, token: { envelope: SEALED, tokenId: 7, savedAt: 1 } },
      {
        version: 1,
        token: { envelope: { mode: 'passphrase', ciphertext: 'x' }, tokenId: 'x', savedAt: 1 },
      },
      { version: 1, report: { tokenId: 'x', permissions: 'all' } },
      {
        version: 2,
        accounts: [
          { ...account('a'), id: '' },
          { ...account('b'), label: 7 },
          { ...account('c'), token: { envelope: SEALED, tokenId: 7, savedAt: 1 } },
          'text',
        ],
      },
    ]) {
      const state = new CloudflareState(memoryPort(junk));
      expect(await state.accounts(), JSON.stringify(junk)).toEqual([]);
    }
  });

  it('keeps a bad report out of an account that is otherwise fine, and the first of a repeated id', async () => {
    const state = new CloudflareState(
      memoryPort({
        version: 2,
        accounts: [
          { ...account('a'), report: { tokenId: 'x', permissions: 'all' } },
          { ...account('a', 'again') },
        ],
      }),
    );

    const accounts = await state.accounts();

    expect(accounts.map((item) => [item.id, item.label, item.report])).toEqual([['a', 'a', null]]);
  });

  it('keeps a passkey-sealed token as it is', async () => {
    const passphrase: SecretEnvelope = {
      mode: 'passphrase',
      ciphertext: 'x',
      iv: 'i',
      authTag: 't',
    };
    const kept = new CloudflareState(
      memoryPort({
        version: 2,
        accounts: [{ ...account('a'), token: { envelope: passphrase, tokenId: 'x', savedAt: 1 } }],
      }),
    );
    expect((await kept.account('a'))?.token.envelope).toEqual(passphrase);
  });

  it('moves every sealed token to a new passkey only when told to commit', async () => {
    const port = memoryPort();
    const state = new CloudflareState(port);
    await state.save(account('work'));
    await state.save(account('client'));
    const moved: SecretEnvelope = {
      mode: 'passphrase',
      ciphertext: 'bmV3',
      iv: 'aXY=',
      authTag: 'dA==',
    };

    const commit = await state.sealedKeys.prepare(async () => moved);
    expect((await state.account('work'))?.token.envelope).toEqual(SEALED);
    await commit();
    expect((await state.account('work'))?.token.envelope).toEqual(moved);
    expect((await state.account('client'))?.token.envelope).toEqual(moved);

    const empty = new CloudflareState(memoryPort());
    await (await empty.sealedKeys.prepare(async () => moved))();
    expect(await empty.accounts()).toEqual([]);
  });
});

describe('cloudflareFilePort', () => {
  it('writes a file only the user can read, and reads it back', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'runova-cloudflare-'));
    folders.push(folder);
    const path = join(folder, 'data', 'cloudflare.json');
    const port = cloudflareFilePort(path);

    expect(await port.read()).toBeNull();
    await port.write({ version: 2, accounts: [account('work')] });
    expect(await port.read()).toEqual({ version: 2, accounts: [account('work')] });
    expect(JSON.parse(readFileSync(path, 'utf-8')).accounts[0].report.tokenId).toBe(REPORT.tokenId);
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);

    writeFileSync(path, '{ not json');
    expect(await port.read()).toBeNull();
  });

  it('passes on errors other than a missing file', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'runova-cloudflare-'));
    folders.push(folder);
    await expect(cloudflareFilePort(folder).read()).rejects.toThrow();
  });
});
