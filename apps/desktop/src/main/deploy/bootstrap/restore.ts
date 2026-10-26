import { readFile } from 'node:fs/promises';
import { quoteForShell } from '@runova/core';
import type { HealthResponse } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployRestorePhase,
  DeployRestoreProgress,
} from '../../../shared/deployHardeningTypes';
import { sshErrorMessage } from '../../../shared/sshErrors';
import type { ExecResult } from '../../ssh/connection';
import { openRootShell, type RootShell } from '../../ssh/sudo';
import { coreNames, LEGACY_CORE, RUNOVA_CORE } from '../coreLayout';
import { type Enrollment, enrollOverSsh } from './enrollment';
import type { InstallerConnection } from './installer';
import {
  LAYOUT_PROBE,
  type RestoreStep,
  restoreCleanupStep,
  restorePaths,
  restoreRollbackStep,
  stageStep,
  swapSteps,
} from './restorePlan';

/**
 * Restores a backup onto a server's core over SSH, as root (E15). It works where nobody can sign
 * in, and on a new server once the core is installed there:
 *
 * 1. The file goes up into a folder the login user owns, then root copies it where only root can
 *    read it and the core's own `admin restore-stage` decrypts and checks it beside the running
 *    core. The passphrase travels on stdin. A refusal ends the restore with nothing changed.
 * 2. The account to sign in with must be one of the backup's Owners; otherwise nothing changes.
 * 3. Stop, swap the state folder for the staged one, start, and ask for the core's health through
 *    the app's own tunnel. If any of that fails, the old state goes back and the core restarts on
 *    it.
 * 4. This computer enrolls on the restored core as that Owner (the backup knows the old server's
 *    computers, not this server's key for it), and the caller signs in.
 */

const STEP_TIMEOUT_MS = 10 * 60_000;
/** Where the core keeps a backup it fetched from a destination (E28), in either layout, under either extension. */
function isFetched(path: string): boolean {
  return [RUNOVA_CORE, LEGACY_CORE].some((names) => {
    const folder = `${names.dataDirectory}/backups/`;
    return (
      path.startsWith(folder) &&
      /^[0-9a-f]{32}\.(?:rnbackup|ambackup)$/.test(path.slice(folder.length))
    );
  });
}
const OUTPUT_BYTES = 256 * 1024;
const FAILURE_CHARS = 1_500;

const TITLES: Record<'upload' | 'health', string> = {
  upload: 'Upload the backup to the server',
  health: 'Check that the restored core answers',
};

export interface RestoreLease {
  connection: InstallerConnection;
  release: () => void;
}

export interface RestoreDeps {
  connect: (serverId: string) => Promise<RestoreLease>;
  /** Asks the core for its health over the transport the app uses for this server. */
  health: (connection: InstallerConnection) => Promise<HealthResponse>;
}

export interface RestoreRequest {
  serverId: string;
  file: string;
  /**
   * The file is already on the server: a backup the core fetched from a destination (E28), kept
   * root only in its incoming folder. Nothing is uploaded then.
   */
  fileOnServer?: boolean;
  passphrase: string;
  sudoPassword: string | null;
  userName: string;
  password: string;
  deviceName: string;
  onProgress?: (progress: DeployRestoreProgress) => void;
}

/** What `admin restore-stage` prints about the backup it checked. */
export interface StagedBackup {
  coreVersion: string;
  createdAtUnixMs: number;
  hostName: string;
  owners: string[];
}

export interface RestoredCore {
  backup: StagedBackup;
  enrollment: Enrollment;
  previousStateFolder: string;
}

function succeeded(result: ExecResult): boolean {
  return result.exitCode === 0 && !result.timedOut;
}

function failure(result: ExecResult): string {
  if (result.timedOut) return 'no answer in time';
  const text = result.stderr.trim() || result.stdout.trim();
  if (text) return text.length > FAILURE_CHARS ? `...${text.slice(-FAILURE_CHARS)}` : text;
  return `exit code ${result.exitCode}`;
}

function parseStaged(stdout: string): StagedBackup {
  const value = JSON.parse(stdout) as Partial<StagedBackup>;
  if (
    typeof value.coreVersion !== 'string' ||
    typeof value.createdAtUnixMs !== 'number' ||
    typeof value.hostName !== 'string' ||
    !Array.isArray(value.owners)
  ) {
    throw new Error('The core described the backup in a way this app does not understand.');
  }
  return {
    coreVersion: value.coreVersion,
    createdAtUnixMs: value.createdAtUnixMs,
    hostName: value.hostName,
    owners: value.owners.filter((owner): owner is string => typeof owner === 'string'),
  };
}

export async function restoreCore(
  deps: RestoreDeps,
  request: RestoreRequest,
): Promise<RestoredCore> {
  const emit = (progress: DeployRestoreProgress) => request.onProgress?.(progress);
  const phase = async <T>(
    id: DeployRestorePhase,
    title: string,
    work: () => Promise<T>,
  ): Promise<T> => {
    emit({ phase: id, title, status: 'running' });
    try {
      const result = await work();
      emit({ phase: id, title, status: 'done' });
      return result;
    } catch (error) {
      emit({ phase: id, title, status: 'failed', detail: sshErrorMessage(error) });
      throw error;
    }
  };
  const run = async (shell: RootShell, step: RestoreStep, stdin?: string): Promise<ExecResult> =>
    phase(step.id, step.title, async () => {
      const result = await shell.run(step.command, {
        timeoutMs: STEP_TIMEOUT_MS,
        maxOutputBytes: OUTPUT_BYTES,
        ...(stdin === undefined ? {} : { stdin }),
      });
      if (!succeeded(result)) throw new Error(failure(result));
      return result;
    });

  if (request.fileOnServer && (!isFetched(request.file) || request.file.includes('..'))) {
    throw new Error('The fetched backup is not where the core keeps fetched backups.');
  }
  const lease = await deps.connect(request.serverId);
  let staging = null as string | null;
  try {
    const password = request.sudoPassword ?? lease.connection.endpoint.password ?? null;
    const shell = await openRootShell(lease.connection, password);
    // A server set up before the rename keeps the old names until its core migrates it.
    const probe = await shell.run(LAYOUT_PROBE, { timeoutMs: 30_000, maxOutputBytes: 1_024 });
    const names = coreNames(probe.stdout.trim() === 'legacy' ? 'legacy' : 'runova');

    const uploaded = request.fileOnServer
      ? request.file
      : await phase('upload', TITLES.upload, async () => {
          const content = await readFile(request.file);
          staging = await lease.connection.createStagingDirectory();
          const path = `${staging}/backup.rnbackup`;
          let reported = -1;
          await lease.connection.upload(content, path, {
            mode: 0o600,
            onProgress: (sent, total) => {
              const percent = total > 0 ? Math.floor((sent / total) * 100) : 100;
              if (percent === reported) return;
              reported = percent;
              emit({ phase: 'upload', title: TITLES.upload, status: 'running', percent });
            },
          });
          return path;
        });

    const staged = parseStaged(
      (await run(shell, stageStep(uploaded, names), `${request.passphrase}\n`)).stdout,
    );
    const owner = staged.owners.find(
      (name) => name.toLowerCase() === request.userName.toLowerCase(),
    );
    if (!owner) {
      const named = staged.owners.length > 0 ? ` Its Owners: ${staged.owners.join(', ')}.` : '';
      throw new Error(
        `${request.userName} is not an Owner in this backup, so nothing was changed.${named}`,
      );
    }

    try {
      for (const step of swapSteps(names)) await run(shell, step);
      await phase('health', TITLES.health, () => deps.health(lease.connection));
    } catch (error) {
      const reason = sshErrorMessage(error);
      try {
        await run(shell, restoreRollbackStep(names));
      } catch (rollbackError) {
        throw new Error(
          `${reason} Going back to the state from before failed too: ${sshErrorMessage(rollbackError)}`,
        );
      }
      throw new Error(`${reason} The server went back to the state it had before.`);
    }

    const enrollment = await enrollOverSsh(
      shell,
      { userName: owner, password: request.password, deviceName: request.deviceName },
      (event) =>
        emit({
          phase: 'enroll',
          title: event.title,
          status: event.status,
          ...(event.detail ? { detail: event.detail } : {}),
        }),
    );
    await run(shell, restoreCleanupStep(names)).catch(() => undefined);
    return { backup: staged, enrollment, previousStateFolder: restorePaths(names).previous };
  } finally {
    if (staging) {
      await lease.connection
        .exec(`rm -rf ${quoteForShell(staging, 'posix')}`, { timeoutMs: 30_000 })
        .catch(() => undefined);
    }
    lease.release();
  }
}
