import { readFileSync, statSync } from 'node:fs';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';
import type { ErrorProjectLink } from '../../shared/errorTrackingTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { StoredErrorConnection } from './store';

/**
 * Where error tracking connections and project links live (E24): `error-tracking.json` in the
 * app's data folder. A token is only ever on disk sealed with the Servers vault, every change
 * goes through one queue, and anything malformed on disk is dropped rather than trusted.
 */

const userData = useTempUserData();

// The first import pulls in all of @agentmat/core, which can take longer than a hook is allowed
// on a busy machine. Paying for it once up front keeps the per-test re-imports quick.
beforeAll(async () => {
  await import('./store');
}, 120_000);

let errorStore: typeof import('./store');
let vault: typeof import('../ssh/vault');

const TOKEN = 'sntryu_plaintextTokenThatMustNotBeOnDisk_0123456789';
const FILE = 'error-tracking.json';

async function connection(
  overrides: Partial<StoredErrorConnection> = {},
): Promise<StoredErrorConnection> {
  return {
    id: 'c1',
    provider: 'sentry',
    label: 'Acme',
    host: 'https://sentry.io',
    apiBase: 'https://de.sentry.io',
    orgSlug: 'acme',
    orgName: 'Acme',
    scopes: ['org:read', 'project:read', 'event:read'],
    canWrite: false,
    createdAt: 1,
    checkedAt: 2,
    problem: null,
    tokenEnvelope: await vault.encryptSecret(TOKEN),
    ...overrides,
  };
}

function link(overrides: Partial<ErrorProjectLink> = {}): ErrorProjectLink {
  return {
    projectId: 'p1',
    connectionId: 'c1',
    remoteProjectId: '102',
    remoteSlug: 'storefront-api',
    remoteName: 'storefront-api',
    ...overrides,
  };
}

function onDisk(): string {
  return readFileSync(userData.dataFile(FILE), 'utf-8');
}

beforeEach(async () => {
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Blog', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
  ]);
  errorStore = await import('./store');
  vault = await import('../ssh/vault');
});

describe('reading and writing', () => {
  it('starts empty when there is no file', async () => {
    expect(await errorStore.readErrorTracking()).toEqual({ connections: [], links: [] });
  });

  it('keeps the token sealed on disk, readable only by the user', async () => {
    const stored = await connection();
    await errorStore.mutateErrorTracking((state) => {
      state.connections.push(stored);
    });
    const raw = onDisk();
    expect(raw).not.toContain(TOKEN);
    expect(raw).not.toContain(TOKEN.slice(7));
    if (process.platform !== 'win32') {
      expect(statSync(userData.dataFile(FILE)).mode & 0o777).toBe(0o600);
    }
    const [read] = (await errorStore.readErrorTracking()).connections;
    expect(await vault.decryptSecret(read.tokenEnvelope)).toBe(TOKEN);
  });

  it('runs changes one after another so none is lost', async () => {
    const a = await connection({ id: 'a' });
    const b = await connection({ id: 'b' });
    await Promise.all([
      errorStore.mutateErrorTracking(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state.connections.push(a);
      }),
      errorStore.mutateErrorTracking((state) => {
        state.connections.push(b);
      }),
    ]);
    const { connections } = await errorStore.readErrorTracking();
    expect(connections.map((one) => one.id)).toEqual(['a', 'b']);
  });

  it('keeps going after a change that throws, and writes nothing for it', async () => {
    await expect(
      errorStore.mutateErrorTracking((state) => {
        state.links.push(link());
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const stored = await connection();
    await errorStore.mutateErrorTracking((state) => {
      state.connections.push(stored);
    });
    expect((await errorStore.readErrorTracking()).links).toEqual([]);
  });

  it('writes nothing when nothing changed', async () => {
    expect(await errorStore.mutateErrorTracking(() => 'read only')).toBe('read only');
    expect(() => onDisk()).toThrow();
  });

  it('drops malformed connections, duplicates and links to connections that are gone', async () => {
    const good = await connection();
    userData.writeData(FILE, {
      connections: [good, { ...good }, { id: 'broken' }, 'nonsense'],
      links: [link(), link({ connectionId: 'gone' }), { projectId: 'p1' }, link()],
    });
    const state = await errorStore.readErrorTracking();
    expect(state.connections.map((one) => one.id)).toEqual(['c1']);
    expect(state.links).toEqual([link()]);
  });

  it('reads a file of the wrong shape as empty', async () => {
    userData.writeData(FILE, ['not', 'an', 'object']);
    expect(await errorStore.readErrorTracking()).toEqual({ connections: [], links: [] });
    userData.writeData(FILE, { connections: 'no', links: null });
    expect(await errorStore.readErrorTracking()).toEqual({ connections: [], links: [] });
  });

  it('refuses a file that is not JSON rather than writing over it', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(userData.dataFile(FILE), '{ half', 'utf-8');
    await expect(errorStore.readErrorTracking()).rejects.toThrow(/error-tracking\.json/);
    await expect(errorStore.mutateErrorTracking(() => undefined)).rejects.toThrow(/not valid JSON/);
    expect(onDisk()).toBe('{ half');
  });
});

describe('broadcastErrorTrackingChanged', () => {
  it('tells every window why', () => {
    const window = new FakeBrowserWindow();
    errorStore.broadcastErrorTrackingChanged('links');
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([[{ reason: 'links' }]]);
  });
});

describe('pruneOrphanErrorLinks', () => {
  beforeEach(async () => {
    const stored = await connection();
    await errorStore.mutateErrorTracking((state) => {
      state.connections.push(stored);
      state.links.push(link(), link({ projectId: 'p2', remoteProjectId: '101' }));
    });
  });

  it('removes the links of a deleted project and says so', async () => {
    const window = new FakeBrowserWindow();
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await errorStore.pruneOrphanErrorLinks({ projectIds: ['p2'] });
    expect((await errorStore.readErrorTracking()).links).toEqual([link()]);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([[{ reason: 'links' }]]);
  });

  it('removes links of a project that is gone even when it is not named', async () => {
    userData.writeData('projects.json', []);
    await errorStore.pruneOrphanErrorLinks();
    expect((await errorStore.readErrorTracking()).links).toEqual([]);
  });

  it('removes a named project even while the project list still has it', async () => {
    await errorStore.pruneOrphanErrorLinks({ projectIds: ['p1'] });
    expect((await errorStore.readErrorTracking()).links.map((one) => one.projectId)).toEqual([
      'p2',
    ]);
  });

  it('does nothing and sends nothing when everything still exists', async () => {
    const window = new FakeBrowserWindow();
    await errorStore.pruneOrphanErrorLinks();
    expect((await errorStore.readErrorTracking()).links).toHaveLength(2);
    expect(window.webContents.sentOn(IPC.errorTracking.onChanged)).toEqual([]);
  });

  it('never throws, leaving the orphans for the next sweep', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(userData.dataFile(FILE), '{ half', 'utf-8');
    await expect(errorStore.pruneOrphanErrorLinks({ projectIds: ['p1'] })).resolves.toBeUndefined();
  });
});

describe('errorTrackingSealedKeys', () => {
  it('moves every token to a new passkey and back to the keychain', async () => {
    const stored = await connection();
    await errorStore.mutateErrorTracking((state) => {
      state.connections.push(stored);
    });
    const unregister = vault.registerSealedSecretStore(errorStore.errorTrackingSealedKeys);
    try {
      expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
      const [moved] = (await errorStore.readErrorTracking()).connections;
      expect(moved.tokenEnvelope.mode).toBe('passphrase');
      expect(await vault.decryptSecret(moved.tokenEnvelope)).toBe(TOKEN);
      expect(onDisk()).not.toContain(TOKEN);

      vault.lockVault();
      expect(vault.isLockedEnvelope(moved.tokenEnvelope)).toBe(true);
      expect(await vault.unlockVault('a servers passkey')).toBe(true);
      expect((await vault.setPasskey(null)).ok).toBe(true);
      const [back] = (await errorStore.readErrorTracking()).connections;
      expect(back.tokenEnvelope.mode).toBe('safeStorage');
      expect(await vault.decryptSecret(back.tokenEnvelope)).toBe(TOKEN);
    } finally {
      unregister();
    }
  });
});
