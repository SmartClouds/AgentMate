import { readFileSync } from 'node:fs';
import { healthHoursFromSamples, INITIAL_HEALTH_TRACK } from '@runova/core';
import { beforeEach, describe, expect, it } from 'vitest';
import type { HealthTargetInput } from '../../shared/healthTypes';
import { IPC } from '../../shared/ipcChannels';
import { FakeBrowserWindow } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';
import type { StoredHealthTarget } from './store';

/**
 * Where healthcheck targets and their results live: two JSON files in the app's data folder.
 * The key is only ever on disk sealed with the Servers vault, every change goes through one
 * queue, and anything malformed on disk is dropped rather than trusted.
 */

const userData = useTempUserData();
let health: typeof import('./store');
let vault: typeof import('../ssh/vault');

const KEY = 'rnh_plaintextKeyThatMustNotBeOnDisk_0123456789abcd';

function input(overrides: Partial<HealthTargetInput> = {}): HealthTargetInput {
  return {
    projectId: 'p1',
    environmentId: null,
    name: 'API',
    serverLabel: null,
    serverLink: null,
    url: 'https://shop.example.com/_runova/health',
    intervalSec: 60,
    timeoutSec: 10,
    authMode: 'bearer',
    basicUser: null,
    allowInsecure: false,
    autoDiagnose: true,
    ...overrides,
  };
}

async function storedTarget(overrides: Partial<StoredHealthTarget> = {}) {
  return {
    ...input(),
    id: 't1',
    createdAt: 1,
    updatedAt: 1,
    paused: false,
    secretEnvelope: await vault.encryptSecret(KEY),
    secretRotatedAt: null,
    ...overrides,
  } satisfies StoredHealthTarget;
}

function onDisk(name: string): string {
  return readFileSync(userData.dataFile(name), 'utf-8');
}

beforeEach(async () => {
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    { id: 'p2', name: 'Blog', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
  ]);
  userData.writeData('project-environments.json', [
    {
      id: 'e1',
      projectId: 'p1',
      name: 'Production',
      kind: 'production',
      order: 0,
      files: [],
      credentials: [],
    },
    {
      id: 'e2',
      projectId: 'p2',
      name: 'Staging',
      kind: 'staging',
      order: 0,
      files: [],
      credentials: [],
    },
  ]);
  health = await import('./store');
  vault = await import('../ssh/vault');
});

describe('reading and writing', () => {
  it('starts empty when there are no files', async () => {
    expect(await health.readHealthState()).toEqual({ targets: [], results: {} });
  });

  it('keeps the key sealed on disk', async () => {
    const target = await storedTarget();
    await health.mutateHealth((state) => {
      state.targets.push(target);
    });
    const raw = onDisk('health-targets.json');
    expect(raw).not.toContain(KEY);
    expect(raw).not.toContain(KEY.slice(4));
    const [read] = await health.readHealthTargets();
    expect(await vault.decryptSecret(read.secretEnvelope as never)).toBe(KEY);
  });

  it('runs changes one after another so none is lost', async () => {
    const a = await storedTarget({ id: 'a' });
    const b = await storedTarget({ id: 'b' });
    await Promise.all([
      health.mutateHealth(async (state) => {
        await new Promise((resolve) => setTimeout(resolve, 20));
        state.targets.push(a);
      }),
      health.mutateHealth((state) => {
        state.targets.push(b);
      }),
    ]);
    expect((await health.readHealthTargets()).map((target) => target.id)).toEqual(['a', 'b']);
  });

  it('keeps going after a change that throws, and writes nothing for it', async () => {
    await expect(
      health.mutateHealth((state) => {
        state.targets.push({ id: 'half' } as StoredHealthTarget);
        throw new Error('nope');
      }),
    ).rejects.toThrow('nope');
    const target = await storedTarget();
    await health.mutateHealth((state) => {
      state.targets.push(target);
    });
    expect((await health.readHealthTargets()).map((one) => one.id)).toEqual(['t1']);
  });

  it('writes the results file only when results change', async () => {
    const target = await storedTarget();
    await health.mutateHealth((state) => {
      state.targets.push(target);
    });
    expect(() => onDisk('health-results.json')).toThrow();
    await health.mutateHealth((state) => {
      state.results.t1 = health.emptyHealthResult();
    });
    expect(JSON.parse(onDisk('health-results.json')).t1.track).toEqual(INITIAL_HEALTH_TRACK);
  });

  it('drops malformed entries instead of trusting them', async () => {
    const good = await storedTarget();
    userData.writeData('health-targets.json', [
      good,
      { ...good, id: 'bad-url', url: 42 },
      { ...good, id: 'bad-auth', authMode: 'digest' },
      'nonsense',
    ]);
    userData.writeData('health-results.json', {
      t1: { ...health.emptyHealthResult(), lastCheckedAt: 5 },
      ghost: 'nonsense',
      other: { samples: 'nope' },
    });
    const state = await health.readHealthState();
    expect(state.targets.map((target) => target.id)).toEqual(['t1']);
    expect(Object.keys(state.results)).toEqual(['t1']);
    expect(state.results.t1.lastCheckedAt).toBe(5);
  });

  it('builds the hours of a results file saved before hours were kept from its samples', async () => {
    const samples = [
      { at: 1_760_000_000_000, state: 'pass', latencyMs: 10 },
      { at: 1_760_000_060_000, state: 'fail', latencyMs: null },
    ] as const;
    const { hours: _hours, ...old } = health.emptyHealthResult();
    userData.writeData('health-results.json', { t1: { ...old, samples } });
    const state = await health.readHealthState();
    expect(state.results.t1.hours).toEqual(healthHoursFromSamples([...samples]));
    expect(state.results.t1.hours.reduce((sum, hour) => sum + hour.checks, 0)).toBe(2);
  });

  it('starts a new result with no hours', () => {
    expect(health.emptyHealthResult().hours).toEqual([]);
  });

  it('reads a results file that is not JSON as empty', async () => {
    userData.writeData('health-targets.json', []);
    const { writeFileSync } = await import('node:fs');
    writeFileSync(userData.dataFile('health-results.json'), '{ not json', 'utf-8');
    expect((await health.readHealthState()).results).toEqual({});
  });

  it('refuses to read a targets file that is not JSON, so a write cannot wipe it', async () => {
    const { writeFileSync } = await import('node:fs');
    writeFileSync(userData.dataFile('health-targets.json'), '{ not json', 'utf-8');
    await expect(health.readHealthTargets()).rejects.toThrow();
  });
});

describe('cleanHealthTargetInput', () => {
  it('keeps a valid target and trims what the user typed', async () => {
    const cleaned = await health.cleanHealthTargetInput(
      input({
        name: '  API  ',
        serverLabel: ' web-1 ',
        environmentId: 'e1',
        url: ' https://a.b/h ',
      }),
    );
    expect(cleaned).toMatchObject({
      name: 'API',
      serverLabel: 'web-1',
      environmentId: 'e1',
      url: 'https://a.b/h',
    });
  });

  it('brings the interval and timeout into range', async () => {
    const cleaned = await health.cleanHealthTargetInput(input({ intervalSec: 1, timeoutSec: 999 }));
    expect(cleaned.intervalSec).toBe(15);
    expect(cleaned.timeoutSec).toBe(60);
  });

  it('drops the Basic username of a Bearer target and an empty server label', async () => {
    const cleaned = await health.cleanHealthTargetInput(
      input({ basicUser: 'someone', serverLabel: '   ' }),
    );
    expect(cleaned.basicUser).toBeNull();
    expect(cleaned.serverLabel).toBeNull();
  });

  it('keeps a Basic username and a server link', async () => {
    const cleaned = await health.cleanHealthTargetInput(
      input({ authMode: 'basic', basicUser: ' ops ', serverLink: { kind: 'ssh', id: 'srv-1' } }),
    );
    expect(cleaned.basicUser).toBe('ops');
    expect(cleaned.serverLink).toEqual({ kind: 'ssh', id: 'srv-1' });
  });

  it.each([
    ['an empty name', { name: '   ' }, /name/],
    ['a name over 80 characters', { name: 'x'.repeat(81) }, /80/],
    ['an address that does not parse', { url: 'not a url' }, /URL/],
    ['an address that is not http', { url: 'ftp://example.com/health' }, /http/],
    [
      'credentials in the address',
      { url: 'https://user:pass@example.com/h' },
      /username or password/,
    ],
    ['a username in the address', { url: 'https://user@example.com/h' }, /username or password/],
    ['a very long address', { url: `https://example.com/${'x'.repeat(2050)}` }, /long/],
    ['Basic without a username', { authMode: 'basic', basicUser: null }, /username/],
    ['a username with a colon', { authMode: 'basic', basicUser: 'a:b' }, /colon/],
    ['a username over 128', { authMode: 'basic', basicUser: 'x'.repeat(129) }, /128/],
    ['a server label over 80', { serverLabel: 'x'.repeat(81) }, /80/],
    ['a project that is gone', { projectId: 'gone' }, /project/],
    ["another project's environment", { environmentId: 'e2' }, /another project/],
    ['an environment that is gone', { environmentId: 'missing' }, /environment/],
  ] as [string, Partial<HealthTargetInput>, RegExp][])(
    'rejects %s',
    async (_label, overrides, message) => {
      await expect(health.cleanHealthTargetInput(input(overrides))).rejects.toThrow(message);
    },
  );
});

describe('pruneOrphanHealthTargets', () => {
  beforeEach(async () => {
    const targets = [
      await storedTarget({ id: 'keep', environmentId: 'e1' }),
      await storedTarget({ id: 'orphan', projectId: 'p2' }),
    ];
    await health.mutateHealth((state) => {
      state.targets.push(...targets);
      state.results.keep = health.emptyHealthResult();
      state.results.orphan = health.emptyHealthResult();
    });
  });

  it('removes the targets and results of a deleted project', async () => {
    const window = new FakeBrowserWindow();
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await health.pruneOrphanHealthTargets({ projectIds: ['p2'] });
    const state = await health.readHealthState();
    expect(state.targets.map((target) => target.id)).toEqual(['keep']);
    expect(Object.keys(state.results)).toEqual(['keep']);
    expect(window.webContents.sentOn(IPC.health.onChanged)).toEqual([[{ targetIds: ['orphan'] }]]);
  });

  it('removes targets of a project that is gone even when it is not named', async () => {
    userData.writeData('projects.json', [
      { id: 'p1', name: 'Shop', folderPath: tempDir(), createdAt: '2026-01-01T00:00:00Z' },
    ]);
    await health.pruneOrphanHealthTargets();
    expect((await health.readHealthTargets()).map((target) => target.id)).toEqual(['keep']);
  });

  it('keeps a target whose environment was deleted, without the environment', async () => {
    userData.writeData('project-environments.json', []);
    await health.pruneOrphanHealthTargets({ environmentIds: ['e1'] });
    const targets = await health.readHealthTargets();
    expect(targets.map((target) => [target.id, target.environmentId])).toEqual([
      ['keep', null],
      ['orphan', null],
    ]);
  });

  it('does nothing and sends nothing when everything still exists', async () => {
    const window = new FakeBrowserWindow();
    await health.pruneOrphanHealthTargets();
    expect((await health.readHealthTargets()).length).toBe(2);
    expect(window.webContents.sentOn(IPC.health.onChanged)).toEqual([]);
  });
});

describe('healthSealedKeys', () => {
  it('moves every key to a new passkey and back to the keychain', async () => {
    const target = await storedTarget();
    await health.mutateHealth((state) => {
      state.targets.push(target);
    });
    const unregister = vault.registerSealedSecretStore(health.healthSealedKeys);
    try {
      expect((await vault.setPasskey('a servers passkey')).ok).toBe(true);
      const [moved] = await health.readHealthTargets();
      expect(moved.secretEnvelope?.mode).toBe('passphrase');
      expect(await vault.decryptSecret(moved.secretEnvelope as never)).toBe(KEY);
      expect(onDisk('health-targets.json')).not.toContain(KEY);

      vault.lockVault();
      expect(vault.isLockedEnvelope(moved.secretEnvelope ?? undefined)).toBe(true);
      expect(await vault.unlockVault('a servers passkey')).toBe(true);
      expect((await vault.setPasskey(null)).ok).toBe(true);
      const [back] = await health.readHealthTargets();
      expect(back.secretEnvelope?.mode).toBe('safeStorage');
      expect(await vault.decryptSecret(back.secretEnvelope as never)).toBe(KEY);
    } finally {
      unregister();
    }
  });
});
