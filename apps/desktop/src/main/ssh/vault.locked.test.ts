import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it } from 'vitest';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import {
  decryptSecret,
  encryptSecret,
  lockVault,
  onVaultUnlocked,
  setPasskey,
  unlockVault,
} from './vault';
import { VaultLockedError } from './vaultErrors';

/**
 * A locked vault refuses with an error of its own class, so the Deploy section's lasting
 * connections can wait for the unlock rather than retry, and it says when it opens again.
 */

const PASSKEY = 'a servers passkey';

beforeEach(() => {
  const dir = tempDir('runova-locked-');
  mkdirSync(join(dir, 'data'), { recursive: true });
  setElectronPath('userData', dir);
  lockVault();
});

describe('the locked Servers vault', () => {
  it('refuses to open or seal secrets with a VaultLockedError', async () => {
    expect((await setPasskey(PASSKEY)).ok).toBe(true);
    const sealed = await encryptSecret('device private key');
    lockVault();

    await expect(decryptSecret(sealed)).rejects.toBeInstanceOf(VaultLockedError);
    await expect(encryptSecret('another')).rejects.toBeInstanceOf(VaultLockedError);
  });

  it('tells its listeners when the right passkey opens it, and only then', async () => {
    expect((await setPasskey(PASSKEY)).ok).toBe(true);
    lockVault();
    let unlocked = 0;
    const stop = onVaultUnlocked(() => {
      unlocked += 1;
    });

    expect(await unlockVault('not the passkey')).toBe(false);
    expect(unlocked).toBe(0);
    expect(await unlockVault(PASSKEY)).toBe(true);
    expect(unlocked).toBe(1);

    stop();
    lockVault();
    expect(await unlockVault(PASSKEY)).toBe(true);
    expect(unlocked).toBe(1);
  });
});
