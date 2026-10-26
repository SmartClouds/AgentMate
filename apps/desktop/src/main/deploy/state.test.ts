import { readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import type { DeployCoreRecord } from '../../shared/deployTypes';
import { tempDir } from '../../test/main/fixtures';
import { DeployState, jsonFilePort } from './state';

/**
 * The app's own record of which core it installed on which server. It is a cache of facts the
 * server can always confirm again, so a damaged file costs a reinstall prompt, never a crash.
 */

const RECORD: DeployCoreRecord = {
  version: '1.53.0',
  release: '/opt/runova-core/releases/1.53.0-abababababab',
  transport: 'streamlocal',
  installedAt: 1_700_000_000_000,
  os: 'Ubuntu 24.04.1 LTS',
  architecture: 'x86_64',
};

function memoryFiles(initial: unknown = null) {
  let content: unknown = initial;
  const writes: unknown[] = [];
  return {
    writes,
    port: {
      read: async () => content,
      write: async (value: unknown) => {
        content = JSON.parse(JSON.stringify(value));
        writes.push(content);
      },
    },
  };
}

describe('DeployState', () => {
  it('starts empty', async () => {
    const state = new DeployState(memoryFiles().port);

    expect(await state.get('srv-1')).toBeNull();
    expect(await state.all()).toEqual({});
  });

  it('remembers a core per server and forgets it again', async () => {
    const state = new DeployState(memoryFiles().port);

    await state.set('srv-1', RECORD);
    await state.set('srv-2', { ...RECORD, transport: 'bridge' });
    await state.remove('srv-1');

    expect(await state.get('srv-1')).toBeNull();
    expect(await state.get('srv-2')).toEqual({ ...RECORD, transport: 'bridge' });
  });

  it('never loses one write to another running at the same time', async () => {
    const state = new DeployState(memoryFiles().port);

    await Promise.all([state.set('a', RECORD), state.set('b', RECORD), state.set('c', RECORD)]);

    expect(Object.keys(await state.all()).sort()).toEqual(['a', 'b', 'c']);
  });

  it('skips records it cannot read instead of failing', async () => {
    const state = new DeployState(
      memoryFiles({
        version: 1,
        cores: { good: RECORD, bad: { version: 7 }, worse: 'text' },
      }).port,
    );

    expect(await state.all()).toEqual({ good: RECORD });
  });

  it('treats a file from somewhere else as empty', async () => {
    for (const content of ['garbage', { version: 99, cores: { a: RECORD } }, [], 42]) {
      expect(await new DeployState(memoryFiles(content).port).all()).toEqual({});
    }
  });
});

describe('DeployState devices', () => {
  const CREDENTIALS = {
    deviceId: 'd1',
    userName: 'maria',
    privateKey: { mode: 'safeStorage' as const, ciphertext: 'c2VhbGVk' },
  };

  it('keeps each server device apart from its core record', async () => {
    const files = memoryFiles();
    const state = new DeployState(files.port);

    await state.set('srv-1', RECORD);
    await state.setDevice('srv-1', CREDENTIALS);
    await state.setDevice('srv-1', { ...CREDENTIALS, sessionId: 's1' });

    expect(await state.device('srv-1')).toEqual({ ...CREDENTIALS, sessionId: 's1' });
    expect(await state.get('srv-1')).toEqual(RECORD);
    expect(files.writes.at(-1)).toMatchObject({ devices: { 'srv-1': { sessionId: 's1' } } });
  });

  it('forgets a device, and the device goes with a removed core', async () => {
    const state = new DeployState(memoryFiles().port);
    await state.set('srv-1', RECORD);
    await state.setDevice('srv-1', CREDENTIALS);
    await state.setDevice('srv-2', CREDENTIALS);

    await state.removeDevice('srv-2');
    await state.remove('srv-1');

    expect(await state.device('srv-1')).toBeNull();
    expect(await state.device('srv-2')).toBeNull();
  });

  it('skips device entries it cannot read', async () => {
    const state = new DeployState(
      memoryFiles({
        version: 1,
        cores: {},
        devices: { good: CREDENTIALS, noKey: { deviceId: 'x', userName: 'y' }, text: 'nope' },
      }).port,
    );

    expect(await state.device('good')).toEqual(CREDENTIALS);
    expect(await state.device('noKey')).toBeNull();
    expect(await state.device('text')).toBeNull();
  });

  it('moves every sealed device key when the passkey changes', async () => {
    const state = new DeployState(memoryFiles().port);
    await state.setDevice('srv-1', CREDENTIALS);
    await state.setDevice('srv-2', { ...CREDENTIALS, deviceId: 'd2' });

    const commit = await state.sealedKeys.prepare(async (envelope) => ({
      mode: 'passphrase' as const,
      ciphertext: `moved:${envelope.ciphertext}`,
      iv: 'iv',
      authTag: 'tag',
    }));
    expect((await state.device('srv-1'))?.privateKey.mode).toBe('safeStorage');
    await commit();

    expect((await state.device('srv-1'))?.privateKey).toMatchObject({
      mode: 'passphrase',
      ciphertext: 'moved:c2VhbGVk',
    });
    expect((await state.device('srv-2'))?.privateKey).toMatchObject({ mode: 'passphrase' });
  });

  describe('a remembered password', () => {
    const SEALED = { mode: 'safeStorage' as const, ciphertext: 'cHc=' };

    it('is kept on the device, and forgotten again without touching the rest', async () => {
      const state = new DeployState(memoryFiles().port);
      await state.setDevice('srv-1', { ...CREDENTIALS, sessionId: 's1' });

      await state.setPassword('srv-1', SEALED);
      expect(await state.device('srv-1')).toEqual({
        ...CREDENTIALS,
        sessionId: 's1',
        password: SEALED,
      });

      await state.setPassword('srv-1', null);
      expect(await state.device('srv-1')).toEqual({ ...CREDENTIALS, sessionId: 's1' });
    });

    it('is not kept for a server with no device', async () => {
      const files = memoryFiles();
      const state = new DeployState(files.port);

      await state.setPassword('srv-1', SEALED);

      expect(await state.device('srv-1')).toBeNull();
      expect(await state.enrolledServers()).toEqual(new Set());
    });

    it('goes with the device when the server is removed', async () => {
      const state = new DeployState(memoryFiles().port);
      await state.setDevice('srv-1', CREDENTIALS);
      await state.setPassword('srv-1', SEALED);

      await state.remove('srv-1');
      await state.setDevice('srv-1', CREDENTIALS);

      expect((await state.device('srv-1'))?.password).toBeUndefined();
    });

    it('skips a device whose password is not a sealed envelope', async () => {
      const state = new DeployState(
        memoryFiles({
          version: 1,
          cores: {},
          devices: { plain: { ...CREDENTIALS, password: 'hunter2' } },
        }).port,
      );

      expect(await state.device('plain')).toBeNull();
    });

    it('moves with the device key when the passkey changes', async () => {
      const state = new DeployState(memoryFiles().port);
      await state.setDevice('srv-1', CREDENTIALS);
      await state.setPassword('srv-1', SEALED);
      await state.setDevice('srv-2', { ...CREDENTIALS, deviceId: 'd2' });

      const commit = await state.sealedKeys.prepare(async (envelope) => ({
        mode: 'passphrase' as const,
        ciphertext: `moved:${envelope.ciphertext}`,
        iv: 'iv',
        authTag: 'tag',
      }));
      expect((await state.device('srv-1'))?.password).toEqual(SEALED);
      await commit();

      expect((await state.device('srv-1'))?.password).toMatchObject({
        mode: 'passphrase',
        ciphertext: 'moved:cHc=',
      });
      expect((await state.device('srv-2'))?.password).toBeUndefined();
    });
  });
});

describe('DeployState alert marks', () => {
  it('keeps how far the alert watcher got on each server, and what it saw open', async () => {
    const files = memoryFiles();
    const state = new DeployState(files.port);
    expect(await state.alertMark('srv-1')).toBeNull();

    await state.set('srv-1', RECORD);
    await state.setAlertMark('srv-1', { revision: 7, open: { '3': 'warning' } });

    expect(await state.alertMark('srv-1')).toEqual({ revision: 7, open: { '3': 'warning' } });
    expect(await state.get('srv-1')).toEqual(RECORD);
  });

  it('forgets the mark with the core it belongs to', async () => {
    const state = new DeployState(memoryFiles().port);
    await state.set('srv-1', RECORD);
    await state.setAlertMark('srv-1', { revision: 7, open: {} });

    await state.remove('srv-1');

    expect(await state.alertMark('srv-1')).toBeNull();
  });

  it('skips marks it cannot read', async () => {
    const state = new DeployState(
      memoryFiles({
        version: 1,
        cores: {},
        devices: {},
        alerts: {
          good: { revision: 2, open: { '1': 'critical', '2': 'loud' } },
          negative: { revision: -1, open: {} },
          text: 'nope',
        },
      }).port,
    );

    expect(await state.alertMark('good')).toEqual({ revision: 2, open: { '1': 'critical' } });
    expect(await state.alertMark('negative')).toBeNull();
    expect(await state.alertMark('text')).toBeNull();
  });

  it('keeps a direct TLS pin, skips a damaged one and forgets it with the core', async () => {
    const pin = 'q83vEjRWeJq83vEjRWeJq83vEjRWeJq83vEjRWeJq80=';
    const state = new DeployState(
      memoryFiles({
        version: 1,
        cores: { 'srv-1': RECORD },
        devices: {},
        directTls: {
          broken: { enabled: true, port: 7443, pin: 'short', pinnedAt: 1 },
          outOfRange: { enabled: true, port: 70_000, pin, pinnedAt: 1 },
        },
      }).port,
    );
    await state.setDirectTls('srv-1', { enabled: true, port: 7443, pin, pinnedAt: 5 });

    expect(await state.directTls('srv-1')).toEqual({ enabled: true, port: 7443, pin, pinnedAt: 5 });
    expect(await state.directTls('broken')).toBeNull();
    expect(await state.directTls('outOfRange')).toBeNull();

    await state.remove('srv-1');

    expect(await state.directTls('srv-1')).toBeNull();
  });
});

describe('jsonFilePort', () => {
  it('reads nothing before the first write', async () => {
    expect(await jsonFilePort(join(tempDir(), 'deploy.json')).read()).toBeNull();
  });

  it('writes the whole file at once and reads it back', async () => {
    const path = join(tempDir(), 'nested', 'deploy.json');
    const port = jsonFilePort(path);

    await port.write({ version: 1, cores: {}, devices: {} });

    expect(JSON.parse(readFileSync(path, 'utf-8'))).toEqual({ version: 1, cores: {}, devices: {} });
    expect(await port.read()).toEqual({ version: 1, cores: {}, devices: {} });
    if (process.platform !== 'win32') expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it('reads a damaged file as empty', async () => {
    const path = join(tempDir(), 'deploy.json');
    writeFileSync(path, '{ not json');

    expect(await jsonFilePort(path).read()).toBeNull();
  });
});
