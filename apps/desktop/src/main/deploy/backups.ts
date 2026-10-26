import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { rename, rm, stat } from 'node:fs/promises';
import { basename } from 'node:path';
import { LEGACY_CORE_NAMES } from '../../shared/deploy/coreLegacyNames';
import type { ICoreHub } from '../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployBackupFile,
  DeployBackupInput,
  DeployBackupResult,
} from '../../shared/deployHardeningTypes';
import type { CoreHttpClient } from './connection/coreHttp';

/** What backups are saved as. Files saved before the rename end in the old extension and still open. */
export const BACKUP_EXTENSION = 'rnbackup';
export const BACKUP_EXTENSIONS = [BACKUP_EXTENSION, LEGACY_CORE_NAMES.backupExtension];

/**
 * Backups of a server's core (E15). The core encrypts its state with the user's passphrase
 * (PBKDF2-HMAC-SHA256, AES-256-GCM, see the core's BackupCrypto) before anything leaves the
 * server, so this side only ever handles ciphertext: it asks where to save first (a cancelled
 * dialog makes nothing), has the core make the file, streams it to `<path>.partial`, checks its
 * SHA-256 against what the core reported, renames it into place and asks the core to delete its
 * copy. Files to restore are picked here and named to the renderer by a token, never a path.
 */

/** A backup can be large; it comes down within this long or not at all. */
const DOWNLOAD_TIMEOUT_MS = 30 * 60_000;
const MIN_PASSPHRASE = 12;
const MAX_PASSPHRASE = 1024;

export interface DeployBackupsDeps {
  /** A short hub call with this computer's session (DeployService.withHub). */
  withHub: <T>(serverId: string, work: (hub: ICoreHub) => Promise<T>) => Promise<T>;
  /** A REST call with this computer's session (DeployService.withCoreHttp). */
  withCoreHttp: <T>(
    serverId: string,
    work: (client: CoreHttpClient, token: string) => Promise<T>,
  ) => Promise<T>;
  serverName: (serverId: string) => Promise<string>;
  /** The save dialog; null when it was cancelled. */
  pickSavePath: (suggestedName: string) => Promise<string | null>;
  /** The open dialog; null when it was cancelled. */
  pickOpenPath: () => Promise<string | null>;
  now?: () => number;
}

export function passphraseProblem(passphrase: string): string | null {
  if (passphrase.length < MIN_PASSPHRASE) {
    return `A backup passphrase needs at least ${MIN_PASSPHRASE} characters.`;
  }
  if (passphrase.length > MAX_PASSPHRASE) {
    return `A backup passphrase can be at most ${MAX_PASSPHRASE} characters.`;
  }
  if (/[\r\n]/.test(passphrase)) return 'A backup passphrase cannot contain a line break.';
  return null;
}

/** A file name part from anything a user may call a server. */
function fileSafe(name: string): string {
  return name.replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^-+|-+$/g, '') || 'server';
}

async function sha256Of(path: string): Promise<string> {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk as Buffer);
  return hash.digest('hex');
}

export class DeployBackups {
  private readonly picked = new Map<string, string>();
  private readonly now: () => number;

  constructor(private readonly deps: DeployBackupsDeps) {
    this.now = deps.now ?? Date.now;
  }

  async create(input: DeployBackupInput): Promise<DeployBackupResult> {
    const problem = passphraseProblem(input.passphrase);
    if (problem) throw new Error(problem);
    const date = new Date(this.now()).toISOString().slice(0, 16).replace(/[:T]/g, '-');
    const name = `runova-${fileSafe(await this.deps.serverName(input.serverId))}-${date}.${BACKUP_EXTENSION}`;
    const path = await this.deps.pickSavePath(name);
    if (!path) return { saved: false };

    const backup = await this.deps.withHub(input.serverId, (hub) =>
      hub.createBackup({ passphrase: input.passphrase }),
    );
    const partial = `${path}.partial`;
    try {
      await this.deps.withCoreHttp(input.serverId, (client, token) =>
        client.download(
          `/api/v1/backups/${backup.id}`,
          createWriteStream(partial, { mode: 0o600 }),
          {
            token,
            timeoutMs: DOWNLOAD_TIMEOUT_MS,
          },
        ),
      );
      const written = await sha256Of(partial);
      if (written !== backup.sha256) {
        throw new Error('The backup changed on its way here. Nothing was saved; make it again.');
      }
      await rename(partial, path);
    } catch (error) {
      await rm(partial, { force: true });
      throw error;
    } finally {
      // The server's copy goes either way: a backup on the machine it protects is no backup.
      await this.deps
        .withHub(input.serverId, (hub) => hub.deleteBackup(backup.id))
        .catch(() => undefined);
    }
    return {
      saved: true,
      path,
      sizeBytes: backup.sizeBytes,
      sha256: backup.sha256,
      contents: backup.contents,
    };
  }

  /** Lets the user pick a backup file; the renderer gets a token for it, not its path. */
  async pick(): Promise<DeployBackupFile | null> {
    const path = await this.deps.pickOpenPath();
    if (!path) return null;
    const info = await stat(path);
    if (!info.isFile()) throw new Error('That is not a file.');
    const token = randomUUID();
    this.picked.set(token, path);
    return { token, name: basename(path), sizeBytes: info.size };
  }

  /** The path behind a token from `pick`. */
  resolve(token: string): string {
    const path = this.picked.get(token);
    if (!path) throw new Error('Pick the backup file again.');
    return path;
  }
}
