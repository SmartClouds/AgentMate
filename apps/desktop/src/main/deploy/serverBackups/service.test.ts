import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Writable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { coreErrorCode } from '../../../shared/coreErrors';
import type {
  BackupFetchInfo,
  BackupRunInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type { CoreHttpClient } from '../connection/coreHttp';
import { ServerBackups, type ServerBackupsDeps } from './service';

/**
 * The Backups section's service (E28): every hub call goes through callCore, so a missing step-up
 * comes back as `[core:stepUpRequired]`; downloads ask where to save first and stream to a partial
 * file; runs and fetches are followed until they end; a cloud drive's refresh token goes to the
 * core and nowhere else.
 */

const UNAUTHORIZED = new Error("Failed to invoke 'SetBackupSecret' because user is unauthorized");
const folders: string[] = [];

afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(): string {
  const path = mkdtempSync(join(tmpdir(), 'server-backups-'));
  folders.push(path);
  return path;
}

function run(state: BackupRunInfo['state'], extra: Partial<BackupRunInfo> = {}): BackupRunInfo {
  return {
    id: 'run-1',
    trigger: 'manual',
    state,
    startedAtUnixMs: 1,
    targets: [],
    ...extra,
  };
}

function setup(
  hubParts: Partial<Record<keyof ICoreHub, unknown>> = {},
  more: Partial<ServerBackupsDeps> = {},
) {
  const body = Buffer.from('AMBACKUP encrypted bytes');
  const hub = hubParts as unknown as ICoreHub;
  const downloads: string[] = [];
  const client = {
    download: vi.fn(
      async (
        path: string,
        destination: Writable,
        options?: { onProgress?: (n: number) => void },
      ) => {
        downloads.push(path);
        options?.onProgress?.(body.length);
        await new Promise<void>((resolve, reject) => {
          destination.on('error', reject);
          destination.end(body, () => resolve());
        });
        return body.length;
      },
    ),
  } as unknown as CoreHttpClient;
  const events: unknown[] = [];
  const deps: ServerBackupsDeps = {
    links: { call: async (_id, work) => work(hub) },
    roles: () => ['owner'],
    withCoreHttp: async (_id, work) => work(client, 'token-1'),
    serverName: async () => 'Web 1',
    pickSavePath: vi.fn(async () => null),
    pickOpenPath: vi.fn(async () => null),
    openExternal: vi.fn(async () => undefined),
    runProgress: (event) => events.push(event),
    sleep: async () => undefined,
    now: () => Date.UTC(2026, 9, 22, 8, 30),
    ...more,
  };
  return { backups: new ServerBackups(deps), hub, client, downloads, events, body, deps };
}

describe('ServerBackups step-up', () => {
  it('turns the core refusing a step-up call into stepUpRequired', async () => {
    const { backups } = setup({
      setBackupSecret: vi.fn(async () => {
        throw UNAUTHORIZED;
      }),
    });
    const error = await backups
      .setSecret({ serverId: 's1', newSecret: 'a long enough secret' })
      .catch((caught: unknown) => caught);
    expect(coreErrorCode(error)).toBe('stepUpRequired');
  });

  it('says when the core is too old for server backups', async () => {
    const { backups } = setup({
      listBackupPlans: vi.fn(async () => {
        throw new Error("Method does not exist 'ListBackupPlans'.");
      }),
    });
    await expect(backups.plans('s1')).rejects.toThrow(/older core/);
  });

  it('keeps a secret key to at least 12 characters and one line', async () => {
    const set = vi.fn(async () => ({ isSet: true }));
    const { backups } = setup({ setBackupSecret: set });
    await expect(backups.setSecret({ serverId: 's1', newSecret: 'short' })).rejects.toThrow(/12/);
    await expect(
      backups.setSecret({ serverId: 's1', newSecret: 'twelve chars\nmore' }),
    ).rejects.toThrow(/line break/);
    await backups.setSecret({
      serverId: 's1',
      newSecret: 'orange tractor lamp',
      currentSecret: 'older secret key',
    });
    expect(set).toHaveBeenCalledWith({
      newSecret: 'orange tractor lamp',
      currentSecret: 'older secret key',
    });
  });
});

describe('ServerBackups runs', () => {
  it('asks where to save before backing up for this computer, and makes nothing when cancelled', async () => {
    const runBackupNow = vi.fn(async () => run('running'));
    const { backups, deps } = setup({ runBackupNow });
    const result = await backups.runNow({ serverId: 's1', destinationIds: [], download: true });
    expect(result).toEqual({ started: false });
    expect(deps.pickSavePath).toHaveBeenCalledWith('runova-Web-1-2026-10-22-08-30.rnbackup');
    expect(runBackupNow).not.toHaveBeenCalled();
  });

  it('follows a run to its end and saves it where the user picked', async () => {
    const dir = folder();
    const path = join(dir, 'web.rnbackup');
    const states = [run('running'), run('running'), run('succeeded', { sizeBytes: 24 })];
    const getBackupRun = vi.fn(async () => states.shift());
    const runBackupNow = vi.fn(async () => run('running'));
    const { backups, downloads, events, body } = setup(
      { runBackupNow, getBackupRun },
      { pickSavePath: vi.fn(async () => path) },
    );

    const started = await backups.runNow({
      serverId: 's1',
      destinationIds: ['d1'],
      download: true,
    });
    expect(runBackupNow).toHaveBeenCalledWith({ destinationIds: ['d1'], keepForDownload: true });
    const watched = await backups.watchRun({ serverId: 's1', runId: started.run?.id ?? '' });

    expect(watched.run.state).toBe('succeeded');
    expect(watched.download).toEqual({ saved: true, path, sizeBytes: body.length });
    expect(downloads).toEqual(['/api/v1/backups/run-1']);
    expect(readFileSync(path)).toEqual(body);
    expect(existsSync(`${path}.partial`)).toBe(false);
    expect(events.length).toBeGreaterThanOrEqual(3);
  });

  it('does not download a run that failed', async () => {
    const dir = folder();
    const { backups, downloads } = setup(
      {
        runBackupNow: vi.fn(async () => run('running')),
        getBackupRun: vi.fn(async () => run('failed', { error: 'No secret key' })),
      },
      { pickSavePath: vi.fn(async () => join(dir, 'x.rnbackup')) },
    );
    await backups.runNow({ serverId: 's1', destinationIds: [], download: true });
    const watched = await backups.watchRun({ serverId: 's1', runId: 'run-1' });
    expect(watched.download?.saved).toBe(false);
    expect(watched.download?.error).toMatch(/No secret key/);
    expect(downloads).toEqual([]);
  });

  it('stops following a run when asked', async () => {
    const { backups } = setup(
      { getBackupRun: vi.fn(async () => run('running')) },
      {
        sleep: (ms, signal) =>
          new Promise((resolve, reject) => {
            const timer = setTimeout(resolve, ms);
            signal?.addEventListener('abort', () => {
              clearTimeout(timer);
              reject(new Error('aborted'));
            });
          }),
        pollMs: 20,
      },
    );
    const watching = backups.watchRun({ serverId: 's1', runId: 'run-1' });
    setTimeout(() => backups.stopWatching({ serverId: 's1', runId: 'run-1' }), 30);
    await expect(watching).rejects.toThrow(/stopped/);
  });

  it('removes a partial file when the stream breaks', async () => {
    const dir = folder();
    const path = join(dir, 'b.rnbackup');
    const { backups, client } = setup({}, { pickSavePath: vi.fn(async () => path) });
    vi.mocked(client.download).mockImplementationOnce(async (_p, destination) => {
      (destination as Writable).write('half');
      throw new Error('connection reset');
    });
    await expect(backups.downloadRun({ serverId: 's1', runId: 'run-1' })).rejects.toThrow(
      /connection reset/,
    );
    expect(existsSync(`${path}.partial`)).toBe(false);
    expect(existsSync(path)).toBe(false);
  });
});

describe('ServerBackups stored backups', () => {
  it('fetches a stored backup onto the server, then streams it here', async () => {
    const dir = folder();
    const path = join(dir, 'stored.rnbackup');
    const fetchInfo = (state: BackupFetchInfo['state'], done: number): BackupFetchInfo => ({
      id: 'f1',
      backupId: 'b9',
      state,
      sizeBytes: 100,
      bytesDone: done,
    });
    const fetches = [fetchInfo('running', 50), fetchInfo('succeeded', 100)];
    const fetchStoredBackup = vi.fn(async () => fetchInfo('running', 0));
    const { backups, downloads } = setup(
      { fetchStoredBackup, getBackupFetch: vi.fn(async () => fetches.shift()) },
      { pickSavePath: vi.fn(async () => path) },
    );
    const result = await backups.downloadStored({
      serverId: 's1',
      destinationId: 'd1',
      backupId: 'b9',
    });
    expect(fetchStoredBackup).toHaveBeenCalledWith('d1', 'b9');
    expect(downloads).toEqual(['/api/v1/backups/b9']);
    expect(result.saved).toBe(true);
  });

  it('reports a fetch that failed in the core own words', async () => {
    const { backups } = setup({
      fetchStoredBackup: vi.fn(async () => ({
        id: 'f1',
        backupId: 'b9',
        state: 'failed',
        sizeBytes: 0,
        bytesDone: 0,
        error: 'Part 2 is missing',
      })),
    });
    await expect(backups.fetchToServer('s1', 'd1', 'b9')).rejects.toThrow(/Part 2 is missing/);
  });
});

describe('ServerBackups cloud drives', () => {
  it('signs in, then saves the destination with the refresh token and client secret', async () => {
    const saveBackupDestination = vi.fn(async (_request: unknown) => ({ id: 'd7' }));
    const signIn = vi.fn(async () => ({ refreshToken: 'refresh-1' }));
    const { backups } = setup({ saveBackupDestination }, { signIn });
    const saved = await backups.connectCloudDrive({
      serverId: 's1',
      name: 'Drive',
      kind: 'googleDrive',
      clientId: 'client-1',
      clientSecret: 'secret-1',
      folderName: 'Runova backups',
    });
    expect(signIn).toHaveBeenCalledWith(
      { kind: 'googleDrive', clientId: 'client-1', clientSecret: 'secret-1' },
      expect.any(AbortSignal),
    );
    expect(saveBackupDestination).toHaveBeenCalledWith({
      name: 'Drive',
      kind: 'googleDrive',
      settings: { clientId: 'client-1', folderName: 'Runova backups' },
      secret: { refreshToken: 'refresh-1', clientSecret: 'secret-1' },
    });
    // What goes back to the renderer is the core's answer, which never holds the token.
    expect(saved).toEqual({ id: 'd7' });
  });

  it('keeps the token for the retry after a step-up, so the browser does not open twice', async () => {
    let refuse = true;
    const saveBackupDestination = vi.fn(async () => {
      if (refuse) {
        refuse = false;
        throw new Error("Failed to invoke 'SaveBackupDestination' because user is unauthorized");
      }
      return { id: 'd7' };
    });
    const signIn = vi.fn(async () => ({ refreshToken: 'refresh-1' }));
    const { backups } = setup({ saveBackupDestination }, { signIn });
    const input = {
      serverId: 's1',
      name: 'OneDrive',
      kind: 'oneDrive' as const,
      clientId: 'client-2',
      folderName: 'Backups',
    };
    const first = await backups.connectCloudDrive(input).catch((error: unknown) => error);
    expect(coreErrorCode(first)).toBe('stepUpRequired');
    await backups.connectCloudDrive(input);
    expect(signIn).toHaveBeenCalledTimes(1);
    expect(saveBackupDestination).toHaveBeenCalledTimes(2);
  });
});

describe('ServerBackups picked files', () => {
  it('names a picked file by token only', async () => {
    const dir = folder();
    const path = join(dir, 'pick.rnbackup');
    writeFileSync(path, 'AMBACKUP');
    const { backups } = setup({}, { pickOpenPath: vi.fn(async () => path) });
    const picked = await backups.pick();
    expect(picked?.name).toBe('pick.rnbackup');
    expect(picked?.sizeBytes).toBe(8);
    expect(backups.resolve(picked?.token ?? '')).toBe(path);
    expect(() => backups.resolve('00000000-0000-4000-8000-000000000000')).toThrow(/again/);
  });
});
