import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import {
  GoogleCloudState,
  type GoogleCloudStatePort,
  googleCloudFilePort,
  type StoredGoogleAccount,
} from './state';

/**
 * The Google accounts at rest, in google-cloud.json: each refresh token (and the user's own client
 * secret, when they brought a client) sealed with the Servers vault. Nothing unreadable is trusted.
 */

const SEALED: SecretEnvelope = { mode: 'safeStorage', ciphertext: 'c2VhbGVk' };
const SECRET: SecretEnvelope = { mode: 'safeStorage', ciphertext: 'c2VjcmV0' };

function account(id: string, extra: Partial<StoredGoogleAccount> = {}): StoredGoogleAccount {
  return {
    id,
    email: `${id}@example.com`,
    clientMode: 'runova',
    clientId: 'runova-client.apps.googleusercontent.com',
    clientSecret: null,
    refreshToken: SEALED,
    projectId: null,
    needsSignIn: false,
    addedAt: '2026-10-30T10:00:00.000Z',
    ...extra,
  };
}

function memoryPort(initial: unknown = null): GoogleCloudStatePort & { value: unknown } {
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

describe('GoogleCloudState', () => {
  it('keeps accounts, replaces one with the same id and forgets one at a time', async () => {
    const state = new GoogleCloudState(memoryPort());
    await state.save(account('a'));
    await state.save(account('b', { clientMode: 'own', clientId: 'mine', clientSecret: SECRET }));
    await state.save(account('a', { email: 'renamed@example.com' }));
    expect((await state.accounts()).map((one) => [one.id, one.email])).toEqual([
      ['a', 'renamed@example.com'],
      ['b', 'b@example.com'],
    ]);
    expect((await state.account('b'))?.clientSecret).toEqual(SECRET);
    await state.remove('a');
    expect((await state.accounts()).map((one) => one.id)).toEqual(['b']);
    expect(await state.account('a')).toBeNull();
  });

  it('remembers the project and whether a fresh sign-in is needed', async () => {
    const state = new GoogleCloudState(memoryPort());
    await state.save(account('a'));
    await state.setProject('a', 'my-project');
    await state.setNeedsSignIn('a', true);
    expect(await state.account('a')).toMatchObject({ projectId: 'my-project', needsSignIn: true });
    // Changing an account that is gone does nothing.
    await state.setProject('missing', 'x');
    expect(await state.accounts()).toHaveLength(1);
  });

  it('drops what it cannot read instead of trusting it', async () => {
    const state = new GoogleCloudState(
      memoryPort({
        version: 1,
        accounts: [
          account('good'),
          account('good', { email: 'twice@example.com' }),
          { ...account('no-token'), refreshToken: { mode: 'safeStorage' } },
          { ...account('bad-mode'), clientMode: 'other' },
          { ...account('own-no-secret'), clientMode: 'own', clientSecret: 'plain text' },
          'nonsense',
        ],
      }),
    );
    expect((await state.accounts()).map((one) => one.id)).toEqual(['good']);
    expect(await new GoogleCloudState(memoryPort('garbage')).accounts()).toEqual([]);
    expect(await new GoogleCloudState(memoryPort({ version: 9, accounts: [] })).accounts()).toEqual(
      [],
    );
  });

  it('runs changes one after another so none is lost', async () => {
    const state = new GoogleCloudState(memoryPort());
    await Promise.all(['a', 'b', 'c', 'd'].map((id) => state.save(account(id))));
    expect(await state.accounts()).toHaveLength(4);
  });

  it('moves every sealed secret when the passkey changes, and only when told to', async () => {
    const port = memoryPort();
    const state = new GoogleCloudState(port);
    await state.save(account('a'));
    await state.save(account('b', { clientMode: 'own', clientId: 'mine', clientSecret: SECRET }));
    const moved: SecretEnvelope[] = [];
    const commit = await state.sealedKeys.prepare(async (envelope) => {
      moved.push(envelope);
      return {
        mode: 'passphrase',
        iv: 'iv',
        authTag: 'tag',
        ciphertext: `new-${envelope.ciphertext}`,
      };
    });
    expect(moved).toHaveLength(3);
    expect((await state.account('a'))?.refreshToken.mode).toBe('safeStorage');
    await commit();
    expect((await state.account('a'))?.refreshToken).toMatchObject({ ciphertext: 'new-c2VhbGVk' });
    expect((await state.account('b'))?.clientSecret).toMatchObject({ ciphertext: 'new-c2VjcmV0' });
  });
});

describe('googleCloudFilePort', () => {
  it('writes the file readable only by the user and reads it back', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'runova-google-'));
    folders.push(folder);
    const path = join(folder, 'data', 'google-cloud.json');
    const state = new GoogleCloudState(googleCloudFilePort(path));
    await state.save(account('a'));
    expect(JSON.parse(readFileSync(path, 'utf-8')).accounts[0].email).toBe('a@example.com');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await new GoogleCloudState(googleCloudFilePort(path)).accounts()).toHaveLength(1);
  });

  it('reads a missing or broken file as empty', async () => {
    const folder = mkdtempSync(join(tmpdir(), 'runova-google-'));
    folders.push(folder);
    const path = join(folder, 'google-cloud.json');
    expect(await googleCloudFilePort(path).read()).toBeNull();
    writeFileSync(path, '{not json');
    expect(await googleCloudFilePort(path).read()).toBeNull();
  });
});
