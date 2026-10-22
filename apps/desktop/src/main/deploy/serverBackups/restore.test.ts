import { existsSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import type {
  PendingServerRestore,
  ServerRestoreStatus,
} from '../../../shared/deploy/protocol/generated/AgentMate.ServerCore.Contracts';
import type {
  DeployServerRestoreEvent,
  DeployServerRestoreInput,
} from '../../../shared/deployServerBackupsTypes';
import { tempDir } from '../../../test/main/fixtures';
import type { AddressRecordPorts } from './addressMoves';
import { ServerRestores, type ServerRestoresDeps } from './restore';
import type { ServerBackups } from './service';

/**
 * The restore wizard's two halves (E28). First the core's state: a backup on a destination is
 * fetched onto the server and staged from there (from another server's destination it comes
 * through this computer), a file from this computer goes up as in E15. Then the server: the core
 * brings back volumes, images and containers, moves the address when asked, and this computer
 * moves its own records.
 */

const RESULT = {
  backupCoreVersion: '1.60.0',
  backupHostName: 'old-web',
  backupCreatedAtUnixMs: 1,
  previousStateFolder: '/var/lib/agentmate-core-restore/previous',
};

const PENDING: PendingServerRestore = {
  hostName: 'old-web',
  createdAtUnixMs: 1,
  oldAddresses: ['203.0.113.10'],
  newAddresses: ['198.51.100.7'],
  volumes: 3,
  savedImages: 1,
  pulledImages: 4,
  containers: 5,
  projects: ['shop'],
  firewallRules: [],
  addressChanges: [],
  liveCopy: true,
};

function status(state: ServerRestoreStatus['state']): ServerRestoreStatus {
  return { state, steps: [{ name: 'Volumes', state: 'succeeded' }], applied: [], manualDns: [] };
}

const INPUT = {
  secret: 'orange tractor lamp',
  sudoPassword: null,
  userName: 'maria',
  password: 'pw',
};

function setup(more: Partial<Record<keyof ServerBackups, unknown>> = {}) {
  const events: DeployServerRestoreEvent[] = [];
  const backups = {
    resolve: vi.fn(() => 'C:/backups/web.ambackup'),
    fetchToServer: vi.fn(async (_s, _d, backupId, onProgress) => {
      onProgress?.({ id: 'f1', backupId, state: 'running', sizeBytes: 100, bytesDone: 50 });
      return {
        id: 'f1',
        backupId,
        state: 'succeeded',
        sizeBytes: 100,
        bytesDone: 100,
        path: '/var/lib/agentmate-core/backups/f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1.ambackup',
      };
    }),
    stream: vi.fn(async (_s, _b, _path, onBytes) => {
      onBytes?.(100);
      return 100;
    }),
    pendingRestore: vi.fn(async () => PENDING),
    runServerRestore: vi.fn(async () => status('running')),
    waitForServerRestore: vi.fn(async (_s, _first, onStatus) => {
      onStatus(status('succeeded'));
      return status('succeeded');
    }),
    ...more,
  } as unknown as ServerBackups;
  const restoreCore = vi.fn(async (_request: unknown, _onProgress: unknown) => RESULT);
  const records: AddressRecordPorts = {
    sshServers: { list: async () => [], save: async () => undefined },
    healthTargets: {
      mutate: async (change) =>
        change([{ id: 'h1', name: 'API', url: 'http://203.0.113.10/' } as never]),
      changed: () => undefined,
    },
    fileSites: { mutate: async (change) => change([]) },
    wordpressSites: null,
  };
  const deps: ServerRestoresDeps = {
    backups,
    restoreCore,
    records,
    serverHost: async () => 'new.example',
    tempFolder: () => tempDir(),
    progress: (event) => events.push(event),
  };
  return { restores: new ServerRestores(deps), backups, restoreCore, events };
}

describe('ServerRestores.restore', () => {
  it('stages a file from this computer the E15 way', async () => {
    const { restores, restoreCore } = setup();
    const input: DeployServerRestoreInput = {
      serverId: 'srv-1',
      source: { kind: 'file', fileToken: 't' },
      ...INPUT,
    };
    expect(await restores.restore(input)).toEqual(RESULT);
    expect(restoreCore).toHaveBeenCalledWith(
      expect.objectContaining({
        serverId: 'srv-1',
        file: 'C:/backups/web.ambackup',
        passphrase: INPUT.secret,
        userName: 'maria',
      }),
      expect.any(Function),
    );
  });

  it('fetches a backup on this server destination and stages it where the core put it', async () => {
    const { restores, restoreCore, backups, events } = setup();
    await restores.restore({
      serverId: 'srv-1',
      source: { kind: 'destination', serverId: 'srv-1', destinationId: 'd1', backupId: 'b1' },
      ...INPUT,
    });
    expect(backups.fetchToServer).toHaveBeenCalledWith('srv-1', 'd1', 'b1', expect.any(Function));
    expect(backups.stream).not.toHaveBeenCalled();
    expect(restoreCore).toHaveBeenCalledWith(
      expect.objectContaining({
        file: '/var/lib/agentmate-core/backups/f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1f1.ambackup',
        fileOnServer: true,
        passphrase: INPUT.secret,
      }),
      expect.any(Function),
    );
    expect(events).toContainEqual({
      serverId: 'srv-1',
      kind: 'step',
      progress: expect.objectContaining({ phase: 'fetch', status: 'running', percent: 50 }),
    });
  });

  it('brings a backup from another server destination through this computer', async () => {
    const { restores, restoreCore, backups } = setup();
    await restores.restore({
      serverId: 'srv-new',
      source: { kind: 'destination', serverId: 'srv-old', destinationId: 'd1', backupId: 'b1' },
      ...INPUT,
    });
    expect(backups.fetchToServer).toHaveBeenCalledWith('srv-old', 'd1', 'b1', expect.any(Function));
    const relay = (vi.mocked(backups.stream).mock.calls[0] as unknown[] | undefined)?.[2];
    expect(restoreCore).toHaveBeenCalledWith(
      expect.objectContaining({ serverId: 'srv-new', file: relay }),
      expect.any(Function),
    );
    expect(vi.mocked(restoreCore).mock.calls[0]?.[0]).not.toHaveProperty('fileOnServer');
    // The copy that passed through here is gone afterwards.
    expect(existsSync(String(relay))).toBe(false);
  });

  it('refuses a fetched path outside the core incoming folder', async () => {
    const { restores, restoreCore } = setup({
      fetchToServer: vi.fn(async () => ({
        id: 'f1',
        backupId: 'b1',
        state: 'succeeded',
        sizeBytes: 1,
        bytesDone: 1,
        path: '/root/elsewhere.ambackup',
      })),
    });
    await expect(
      restores.restore({
        serverId: 'srv-1',
        source: { kind: 'destination', serverId: 'srv-1', destinationId: 'd1', backupId: 'b1' },
        ...INPUT,
      }),
    ).rejects.toThrow(/not where/);
    expect(restoreCore).not.toHaveBeenCalled();
  });
});

describe('ServerRestores.bringUp', () => {
  it('runs the core restore, follows it, then moves this computer records to the new address', async () => {
    const { restores, backups, events } = setup();
    const result = await restores.bringUp({
      serverId: 'srv-new',
      moveAddresses: true,
      password: 'pw',
    });
    expect(backups.runServerRestore).toHaveBeenCalledWith('srv-new', true, { password: 'pw' });
    expect(result.status.state).toBe('succeeded');
    expect(result.moved).toEqual([
      {
        area: 'healthCheck',
        name: 'API',
        from: 'http://203.0.113.10/',
        to: 'http://198.51.100.7/',
      },
    ]);
    expect(events.some((event) => event.kind === 'bringUp')).toBe(true);
  });

  it('moves nothing of its own on the same server', async () => {
    const { restores } = setup();
    const result = await restores.bringUp({ serverId: 'srv-1', moveAddresses: false });
    expect(result.moved).toEqual([]);
  });

  it('says so when nothing waits to be brought up', async () => {
    const { restores } = setup({ pendingRestore: vi.fn(async () => null) });
    await expect(restores.bringUp({ serverId: 'srv-1', moveAddresses: false })).rejects.toThrow(
      /Nothing from a backup/,
    );
  });
});
