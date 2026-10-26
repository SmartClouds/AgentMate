import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SecretEnvelope, StoredSshServer } from '../../shared/apiTypes';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { store } from '../store';
import {
  decryptSecret,
  encryptSecret,
  lockVault,
  migrateLegacySafeStorage,
  registerSealedSecretStore,
} from './vault';

/**
 * On macOS and Linux the keychain entry behind safeStorage is named after the app, so secrets
 * saved before the rename are sealed under a key the renamed app can't open. A helper running
 * under the old name opens them, and they are sealed again under the current key.
 */

beforeEach(() => {
  const dir = tempDir('runova-legacy-key-');
  mkdirSync(join(dir, 'data'), { recursive: true });
  setElectronPath('userData', dir);
  lockVault();
});

/** Sealed under the old key: the test keychain can't open it, the fake helper can. */
function oldKey(plaintext: string): SecretEnvelope {
  return { mode: 'safeStorage', ciphertext: Buffer.from(`old:${plaintext}`).toString('base64') };
}

const helper = vi.fn(async (ciphertexts: string[]) =>
  ciphertexts.map((ciphertext) => {
    const text = Buffer.from(ciphertext, 'base64').toString('utf-8');
    return text.startsWith('old:') ? text.slice(4) : null;
  }),
);

function server(id: string, secretEnvelope: SecretEnvelope): StoredSshServer {
  return { id, nickname: id, host: `${id}.example`, secretEnvelope } as StoredSshServer;
}

describe('migrateLegacySafeStorage', () => {
  it('seals every secret from before the rename again under the current key', async () => {
    const current = await encryptSecret('already fine');
    await store.setSshServers([server('a', oldKey('ssh password')), server('b', current)]);
    const sealed = { envelope: oldKey('device key') };
    const unregister = registerSealedSecretStore({
      prepare: async (move) => {
        const moved = await move(sealed.envelope);
        return async () => {
          sealed.envelope = moved;
        };
      },
    });
    helper.mockClear();
    try {
      expect(await migrateLegacySafeStorage(helper)).toEqual({ moved: 2, unreadable: 0 });

      // Only the two the current key could not open went to the helper, in one call.
      expect(helper).toHaveBeenCalledTimes(1);
      expect(helper.mock.calls[0][0]).toHaveLength(2);
      const [a, b] = await store.getSshServers();
      expect(await decryptSecret(a.secretEnvelope as SecretEnvelope)).toBe('ssh password');
      expect(b.secretEnvelope).toEqual(current);
      expect(await decryptSecret(sealed.envelope)).toBe('device key');
    } finally {
      unregister();
    }
  });

  it('does not start the helper when every secret already opens', async () => {
    await store.setSshServers([server('a', await encryptSecret('fine'))]);
    helper.mockClear();

    expect(await migrateLegacySafeStorage(helper)).toEqual({ moved: 0, unreadable: 0 });
    expect(helper).not.toHaveBeenCalled();
  });

  it('leaves a secret neither key opens as it was, and counts it', async () => {
    const lost: SecretEnvelope = {
      mode: 'safeStorage',
      ciphertext: Buffer.from('garbage').toString('base64'),
    };
    await store.setSshServers([server('a', lost)]);

    expect(await migrateLegacySafeStorage(helper)).toEqual({ moved: 0, unreadable: 1 });
    expect((await store.getSshServers())[0].secretEnvelope).toEqual(lost);
  });
});
