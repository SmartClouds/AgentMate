import { readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/main/fixtures';
import { RegistryState, registryFilePort, type StoredRegistryCredential } from './state';

const STACK = '0f8fad5b-d9cb-469f-a165-70867728950e';

function credential(overrides: Partial<StoredRegistryCredential> = {}): StoredRegistryCredential {
  return {
    id: 'c1',
    kind: 'github',
    source: 'packagesToken',
    registry: 'ghcr.io',
    username: 'octocat',
    envelope: { mode: 'safeStorage', ciphertext: 'c2VhbGVk' },
    scopes: ['read:packages'],
    broaderScopes: [],
    savedAt: 1,
    checkedAt: 1,
    ...overrides,
  };
}

function memory(initial: unknown = null) {
  let file = initial;
  return {
    port: {
      read: async () => file,
      write: async (value: unknown) => {
        file = value;
      },
    },
    file: () => file,
  };
}

describe('RegistryState', () => {
  it('keeps one sign-in per registry, the newest', async () => {
    const { port } = memory();
    const state = new RegistryState(port);

    await state.save(credential());
    await state.save(credential({ id: 'c2', username: 'robot' }));

    expect((await state.credentials()).map((item) => item.id)).toEqual(['c2']);
  });

  it('drops what it cannot trust', async () => {
    const { port } = memory({
      version: 1,
      credentials: [
        credential(),
        credential({ id: 'dup' }),
        { ...credential({ id: 'bad' }), registry: 'Not A Host' },
        { ...credential({ id: 'noenvelope' }), registry: 'quay.io', envelope: null },
      ],
      apps: { [`srv:${STACK}`]: { sendSignIns: false }, 'junk key': { sendSignIns: false } },
    });
    const state = new RegistryState(port);

    expect((await state.credentials()).map((item) => item.id)).toEqual(['c1']);
    expect(await state.sendSignIns('srv', STACK)).toBe(false);
    expect(await state.sendSignIns('srv', '1f8fad5b-d9cb-469f-a165-70867728950e')).toBe(true);
    expect(await new RegistryState(memory({ version: 2 }).port).credentials()).toEqual([]);
  });

  it('moves the sealed secrets when the passkey changes, all at once', async () => {
    const { port } = memory();
    const state = new RegistryState(port);
    await state.save(credential());

    const commit = await state.sealedKeys.prepare(async () => ({
      mode: 'passphrase',
      ciphertext: 'bmV3',
      iv: 'aXY=',
      authTag: 'dGFn',
    }));
    expect((await state.credentials())[0].envelope.mode).toBe('safeStorage');
    await commit();
    expect((await state.credentials())[0].envelope.mode).toBe('passphrase');
  });

  it('removes a sign-in and remembers each app choice', async () => {
    const { port } = memory();
    const state = new RegistryState(port);
    await state.save(credential());
    await state.setSendSignIns('srv', STACK, false);
    await state.remove('c1');

    expect(await state.credentials()).toEqual([]);
    expect(await state.sendSignIns('srv', STACK)).toBe(false);
  });

  it('writes the file for this user only', async () => {
    const path = join(tempDir('runova-registries-'), 'data', 'registries.json');
    const state = new RegistryState(registryFilePort(path));
    await state.save(credential());

    expect(JSON.parse(readFileSync(path, 'utf-8')).credentials[0].id).toBe('c1');
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(await new RegistryState(registryFilePort(`${path}.missing`)).credentials()).toEqual([]);
  });
});
