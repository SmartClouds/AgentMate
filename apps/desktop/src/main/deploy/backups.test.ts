import { createHash } from 'node:crypto';
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BackupInfo } from '../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import { DeployBackups, passphraseProblem } from './backups';
import type { CoreHttpClient } from './connection/coreHttp';

/**
 * Saving a backup: the place is asked for first, the encrypted file streams down to a partial
 * file, its checksum is checked, and the server's copy is deleted whatever happens. Picked files
 * are known to the renderer by a token only.
 */

const PASSPHRASE = 'orange tractor bicycle lamp';
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'backups-'));
  folders.push(path);
  return path;
}

function setup(
  options: { body?: Buffer; sha?: string; save?: string | null; open?: string | null } = {},
) {
  const body = options.body ?? Buffer.from('AMBACKUP encrypted bytes');
  const info: BackupInfo = {
    id: 'b1',
    fileName: 'runova-backup.rnbackup',
    sizeBytes: body.length,
    sha256: options.sha ?? createHash('sha256').update(body).digest('hex'),
    createdAtUnixMs: 1,
    expiresAtUnixMs: 2,
    coreVersion: '1.0.0',
    contents: {
      users: 1,
      devices: 1,
      stacks: 0,
      sites: 0,
      certificates: 0,
      databaseBytes: 10,
      files: 1,
    },
  };
  const hub = {
    createBackup: vi.fn(async () => info),
    deleteBackup: vi.fn(async () => true),
  } as unknown as ICoreHub;
  const downloads: string[] = [];
  const client = {
    download: vi.fn(async (path: string, destination: Writable) => {
      downloads.push(path);
      await new Promise<void>((resolve, reject) => {
        destination.on('error', reject);
        destination.end(body, () => resolve());
      });
      return body.length;
    }),
  } as unknown as CoreHttpClient;
  const pickSavePath = vi.fn(async () => (options.save === undefined ? null : options.save));
  const backups = new DeployBackups({
    withHub: async (_id, work) => work(hub),
    withCoreHttp: async (_id, work) => work(client, 'tok'),
    serverName: async () => 'Web 01',
    pickSavePath,
    pickOpenPath: async () => (options.open === undefined ? null : options.open),
    now: () => Date.UTC(2026, 9, 2, 12, 30),
  });
  return { backups, hub, client, downloads, pickSavePath, body };
}

describe('DeployBackups', () => {
  it('checks the passphrase the way the core does', () => {
    expect(passphraseProblem('short')).toMatch(/at least 12/);
    expect(passphraseProblem(`${'a'.repeat(12)}\n`)).toMatch(/line break/);
    expect(passphraseProblem('a'.repeat(1025))).toMatch(/at most 1024/);
    expect(passphraseProblem(PASSPHRASE)).toBeNull();
  });

  it('makes nothing when the save dialog is cancelled', async () => {
    const { backups, hub, pickSavePath } = setup({ save: null });

    expect(await backups.create({ serverId: 'srv', passphrase: PASSPHRASE })).toEqual({
      saved: false,
    });
    expect(pickSavePath).toHaveBeenCalledWith('runova-Web-01-2026-10-02-12-30.rnbackup');
    expect(hub.createBackup).not.toHaveBeenCalled();
  });

  it('saves the encrypted file and deletes the server copy', async () => {
    const path = join(folder(), 'web.rnbackup');
    const { backups, hub, downloads, body } = setup({ save: path });

    const result = await backups.create({ serverId: 'srv', passphrase: PASSPHRASE });

    expect(hub.createBackup).toHaveBeenCalledWith({ passphrase: PASSPHRASE });
    expect(downloads).toEqual(['/api/v1/backups/b1']);
    expect(readFileSync(path)).toEqual(body);
    expect(existsSync(`${path}.partial`)).toBe(false);
    expect(hub.deleteBackup).toHaveBeenCalledWith('b1');
    expect(result).toMatchObject({ saved: true, path, sizeBytes: body.length });
  });

  it('keeps nothing when the checksum does not match, and still deletes the server copy', async () => {
    const path = join(folder(), 'web.rnbackup');
    const { backups, hub } = setup({ save: path, sha: 'f'.repeat(64) });

    await expect(backups.create({ serverId: 'srv', passphrase: PASSPHRASE })).rejects.toThrow(
      /changed on its way/,
    );
    expect(existsSync(path)).toBe(false);
    expect(existsSync(`${path}.partial`)).toBe(false);
    expect(hub.deleteBackup).toHaveBeenCalled();
  });

  it('refuses a weak passphrase before asking anything', async () => {
    const { backups, pickSavePath } = setup({ save: 'x' });

    await expect(backups.create({ serverId: 'srv', passphrase: 'short' })).rejects.toThrow(
      /at least/,
    );
    expect(pickSavePath).not.toHaveBeenCalled();
  });

  it('names a picked file by a token only', async () => {
    const path = join(folder(), 'old.rnbackup');
    writeFileSync(path, 'AMBACKUP');
    const { backups } = setup({ open: path });

    const picked = await backups.pick();

    expect(picked).toMatchObject({ name: 'old.rnbackup', sizeBytes: 8 });
    expect(JSON.stringify(picked)).not.toContain(folders[0]);
    expect(backups.resolve(picked?.token ?? '')).toBe(path);
    expect(() => backups.resolve('made-up')).toThrow(/Pick the backup file again/);
    expect(await setup({ open: null }).backups.pick()).toBeNull();
  });
});
