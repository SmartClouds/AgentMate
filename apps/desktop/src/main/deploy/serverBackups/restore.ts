import { randomUUID } from 'node:crypto';
import { rm } from 'node:fs/promises';
import { join } from 'node:path';
import type {
  DeployRestoreProgress,
  DeployRestoreResult,
} from '../../../shared/deployHardeningTypes';
import type {
  DeployBringUpInput,
  DeployBringUpResult,
  DeployMovedRecord,
  DeployServerRestoreEvent,
  DeployServerRestoreInput,
  DeployServerRestoreProgress,
  DeployServerRestoreResult,
} from '../../../shared/deployServerBackupsTypes';
import { type AddressRecordPorts, addressMap, moveAddressRecords } from './addressMoves';
import { FETCH_FOLDER, type ServerBackups } from './service';

/**
 * A restore from the Backups section (E28), in two halves the wizard runs one after the other.
 *
 * 1. The core's own state, the E15 way over SSH as root (stage with the secret on stdin, swap,
 *    start, check, roll back on failure, enroll this computer as the backup's Owner and sign in).
 *    A backup on one of this server's destinations is fetched onto the server by the core and
 *    staged where it put it, so nothing large crosses this computer. One on another server's
 *    destination is fetched there and comes through this computer, as does a file from here.
 * 2. Once the restored core answers, the server itself: volumes, images, containers and the
 *    stacks come back, and on a new server the core moves what named the old address. This
 *    computer then moves its own records (saved servers, health checks, FTP and WordPress sites).
 */

export interface ServerRestoresDeps {
  backups: Pick<
    ServerBackups,
    | 'resolve'
    | 'fetchToServer'
    | 'stream'
    | 'pendingRestore'
    | 'runServerRestore'
    | 'waitForServerRestore'
  >;
  /** DeployService.restore: the E15 flow over SSH, then sign in. */
  restoreCore: (
    request: {
      serverId: string;
      file: string;
      fileOnServer?: boolean;
      passphrase: string;
      sudoPassword: string | null;
      userName: string;
      password: string;
    },
    onProgress: (progress: DeployRestoreProgress) => void,
  ) => Promise<DeployRestoreResult>;
  records: AddressRecordPorts;
  /** The address this computer reaches a server at, for an old address with no new one beside it. */
  serverHost: (serverId: string) => Promise<string>;
  /** A folder of this computer's own for a backup passing through. */
  tempFolder: () => string;
  progress: (event: DeployServerRestoreEvent) => void;
}

const TITLES = {
  fetch: 'Fetch the backup from its destination onto the server',
  download: 'Bring the backup through this computer',
} as const;

function percent(done: number, total: number): number {
  return total > 0 ? Math.min(100, Math.floor((done / total) * 100)) : 0;
}

export class ServerRestores {
  constructor(private readonly deps: ServerRestoresDeps) {}

  async restore(input: DeployServerRestoreInput): Promise<DeployServerRestoreResult> {
    const target = input.serverId;
    const emit = (progress: DeployServerRestoreProgress) =>
      this.deps.progress({ serverId: target, kind: 'step', progress });
    const onCoreProgress = (progress: DeployRestoreProgress) => emit(progress);
    const base = {
      serverId: target,
      passphrase: input.secret,
      sudoPassword: input.sudoPassword,
      userName: input.userName,
      password: input.password,
    };

    if (input.source.kind === 'file') {
      const file = this.deps.backups.resolve(input.source.fileToken);
      return this.deps.restoreCore({ ...base, file }, onCoreProgress);
    }

    const source = input.source;
    const step = async <T>(
      phase: 'fetch' | 'download',
      work: (report: (value: number) => void) => Promise<T>,
    ): Promise<T> => {
      emit({ phase, title: TITLES[phase], status: 'running' });
      try {
        const result = await work((value) =>
          emit({ phase, title: TITLES[phase], status: 'running', percent: value }),
        );
        emit({ phase, title: TITLES[phase], status: 'done' });
        return result;
      } catch (error) {
        emit({
          phase,
          title: TITLES[phase],
          status: 'failed',
          detail: error instanceof Error ? error.message : String(error),
        });
        throw error;
      }
    };

    const fetched = await step('fetch', (report) =>
      this.deps.backups.fetchToServer(
        source.serverId,
        source.destinationId,
        source.backupId,
        (fetch) => report(percent(fetch.bytesDone, fetch.sizeBytes)),
      ),
    );

    if (source.serverId === target) {
      const path = fetched.path ?? '';
      if (!path.startsWith(FETCH_FOLDER) || path.includes('..')) {
        throw new Error('The fetched backup is not where the core keeps fetched backups.');
      }
      return this.deps.restoreCore({ ...base, file: path, fileOnServer: true }, onCoreProgress);
    }

    // Another server's destination: the backup comes through this computer, then goes up.
    const relay = join(this.deps.tempFolder(), `agentmate-restore-${randomUUID()}.ambackup`);
    try {
      await step('download', (report) =>
        this.deps.backups.stream(source.serverId, fetched.backupId, relay, (bytes) =>
          report(percent(bytes, fetched.sizeBytes)),
        ),
      );
      return await this.deps.restoreCore({ ...base, file: relay }, onCoreProgress);
    } finally {
      await rm(relay, { force: true }).catch(() => undefined);
    }
  }

  /** Brings the restored server up, then moves this computer's records when the address moved. */
  async bringUp(input: DeployBringUpInput): Promise<DeployBringUpResult> {
    const pending = await this.deps.backups.pendingRestore(input.serverId);
    if (!pending) {
      throw new Error('Nothing from a backup waits to be brought up on this server.');
    }
    const proof = {
      ...(input.password ? { password: input.password } : {}),
      ...(input.totpCode ? { totpCode: input.totpCode } : {}),
    };
    const first = await this.deps.backups.runServerRestore(
      input.serverId,
      input.moveAddresses,
      proof,
    );
    const status = await this.deps.backups.waitForServerRestore(input.serverId, first, (next) =>
      this.deps.progress({ serverId: input.serverId, kind: 'bringUp', status: next }),
    );
    let moved: DeployMovedRecord[] = [];
    let movedError: string | undefined;
    if (input.moveAddresses && status.state !== 'failed') {
      try {
        const map = addressMap(pending, await this.deps.serverHost(input.serverId));
        moved = await moveAddressRecords(this.deps.records, {
          targetServerId: input.serverId,
          map,
        });
      } catch (error) {
        movedError = error instanceof Error ? error.message : String(error);
      }
    }
    return { status, moved, ...(movedError ? { movedError } : {}) };
  }
}
