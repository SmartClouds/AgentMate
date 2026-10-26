import { resolve } from 'node:path';
import { app, safeStorage } from 'electron';
import { LEGACY_USER_DATA_ENV } from '../shared/legacyNames';

/**
 * Set by the end-to-end suite. Turns off the startup work that reaches outside the app's own
 * profile, so a test run can't disturb a real install on the same machine.
 */
export const isE2E = process.env.RUNOVA_E2E === '1';

// A profile of its own for tests, or for a throwaway second instance. This has to happen before
// anything reads userData: the single-instance lock, the terminal host's pipe name (hashed from
// this path) and every data file hang off it. The variable's name from before the rename still
// works.
export const userDataOverride =
  process.env.RUNOVA_USER_DATA_DIR?.trim() || process.env[LEGACY_USER_DATA_ENV]?.trim();
if (userDataOverride) {
  app.setPath('userData', resolve(userDataOverride));
}

// CI Linux runners have no keyring, so safeStorage would refuse to encrypt and saving a server
// password would fail. Tests fall back to Electron's in-memory key there instead.
if (isE2E && process.platform === 'linux') {
  void app.whenReady().then(() => {
    if (!safeStorage.isEncryptionAvailable()) safeStorage.setUsePlainTextEncryption(true);
  });
}

/**
 * Windows stay hidden during e2e runs so a test run doesn't pop apps up over whatever the
 * developer is doing. Set RUNOVA_E2E_SHOW=1 to watch a run.
 */
export const keepWindowsHidden = isE2E && process.env.RUNOVA_E2E_SHOW !== '1';

// macOS gives every Electron process an icon in the Dock, window or not, so a run with hidden
// windows still made one pop in and out of the Dock for each test.
if (keepWindowsHidden && process.platform === 'darwin') app.dock?.hide();
