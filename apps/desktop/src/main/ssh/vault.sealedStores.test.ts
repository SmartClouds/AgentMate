import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import type { SecretEnvelope } from '../../shared/apiTypes';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import {
  decryptSecret,
  encryptSecret,
  lockVault,
  registerSealedSecretStore,
  setPasskey,
} from './vault';

/**
 * Secrets other stores seal with the Servers vault (the Deploy section's device keys) move with a
 * passkey change like the vault's own, or they would end up under a key nothing can reach.
 */

beforeEach(() => {
  const dir = tempDir('runova-sealed-');
  mkdirSync(join(dir, 'data'), { recursive: true });
  setElectronPath('userData', dir);
  lockVault();
});

function memoryStore(initial: SecretEnvelope) {
  const box = { envelope: initial, commits: 0 };
  const unregister = registerSealedSecretStore({
    prepare: async (move) => {
      const moved = await move(box.envelope);
      return async () => {
        box.envelope = moved;
        box.commits += 1;
      };
    },
  });
  return { box, unregister };
}

describe('registered sealed secret stores', () => {
  it('move to the new passkey and back to the keychain with the rest', async () => {
    const { box, unregister } = memoryStore(await encryptSecret('device private key'));
    try {
      expect((await setPasskey('a servers passkey')).ok).toBe(true);
      expect(box.envelope.mode).not.toBe('safeStorage');
      expect(await decryptSecret(box.envelope)).toBe('device private key');

      expect((await setPasskey(null)).ok).toBe(true);
      expect(box.envelope.mode).toBe('safeStorage');
      expect(await decryptSecret(box.envelope)).toBe('device private key');
      expect(box.commits).toBe(2);
    } finally {
      unregister();
    }
  });

  it('are left alone once unregistered', async () => {
    const original = await encryptSecret('device private key');
    const { box, unregister } = memoryStore(original);
    unregister();

    await setPasskey('a servers passkey');

    expect(box.envelope).toEqual(original);
    expect(box.commits).toBe(0);
  });

  it('keep their secret when the move fails part way', async () => {
    const { box, unregister } = memoryStore(await encryptSecret('device private key'));
    const failing = registerSealedSecretStore({
      prepare: async () => {
        throw new Error('disk is gone');
      },
    });
    try {
      const result = await setPasskey('a servers passkey');

      expect(result).toEqual({ ok: false, error: 'disk is gone' });
      expect(box.commits).toBe(0);
      expect(box.envelope.mode).toBe('safeStorage');
    } finally {
      failing();
      unregister();
    }
  });
});
