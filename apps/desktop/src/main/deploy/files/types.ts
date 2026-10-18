import type { SecretEnvelope } from '../../../shared/apiTypes';
import type { FileSite, FileSiteCustomLogin } from '../../../shared/deployFilesTypes';

/**
 * Main-process-only shapes for FTP and SFTP sites (E23). A stored site is the public `FileSite`
 * plus the sealed secret of a login of its own; `toPublicFileSite` (store.ts) drops the envelope
 * for a `hasSecret` flag before anything reaches the renderer.
 */

export type StoredFileSiteConnection =
  | { kind: 'saved'; sshServerId: string }
  | (FileSiteCustomLogin & { secretEnvelope: SecretEnvelope | null });

export interface StoredFileSite extends Omit<FileSite, 'connection'> {
  connection: StoredFileSiteConnection;
}

/**
 * Everything needed to open a connection, secrets unsealed. Built in main right before a connect
 * and never kept: from a stored site, or from a Test connection input that is not saved yet.
 */
export type FilesConnectTarget =
  | {
      protocol: 'sftp';
      login: { kind: 'saved'; sshServerId: string };
      remoteRoot: string;
    }
  | {
      protocol: FileSite['protocol'];
      login: FileSiteCustomLogin & { secret: string | null };
      remoteRoot: string;
    };
