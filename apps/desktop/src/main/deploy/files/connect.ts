import { probeHostKey as probeSshHostKey, type SshEndpoint } from '../../ssh/connectConfig';
import { SshConnection } from '../../ssh/connection';
import type { SshConnectionPool, SshLease, SshOpener } from '../../ssh/pool';
import { getSshPool } from '../../ssh/sharedPool';
import { FilesTransportError, mapSshConnectError } from './transport/errors';
import { type FtpOpenOptions, openFtpRemote } from './transport/ftpRemote';
import { createSftpRemote } from './transport/sftpRemote';
import type { OpenRemoteFiles, RemoteFiles } from './transport/types';
import type { FilesConnectTarget } from './types';

/**
 * Opens the files of an FTP or SFTP site (E23), whatever its login:
 * - a server saved in Remote goes through the shared pool: a connection of its own for a deploy
 *   run, so a long upload never blocks Deploy's other work, and the pooled one for browsing. The
 *   pool trusts a saved server's first host key, as Remote does when a person connects; with
 *   nobody there to look (`unattended`, Deploy on save), a server with no trusted key is refused;
 * - an SFTP login of the site's own opens its own connection, checked against the host key the
 *   user trusted for this site. A key nobody trusted yet is refused before the login is sent;
 *   trusting it is a separate, explicit step;
 * - FTP and FTPS go to the FTP transport.
 */

export interface ConnectDeps {
  pool?: () => Pick<SshConnectionPool, 'acquire' | 'openSeparate'>;
  openSsh?: SshOpener;
  probeHostKey?: (host: string, port: number) => Promise<string>;
  openFtp?: (target: FilesConnectTarget, options: FtpOpenOptions) => Promise<RemoteFiles>;
  /** The host key Remote trusted for a saved server, null when none was yet. */
  savedHostKey?: (sshServerId: string) => Promise<string | null>;
}

async function storedHostKey(sshServerId: string): Promise<string | null> {
  const { store } = await import('../../store');
  const server = (await store.getSshServers()).find((one) => one.id === sshServerId);
  return server?.hostKeyFingerprint ?? null;
}

function cancelled(target: FilesConnectTarget): FilesTransportError {
  const where = target.login.kind === 'saved' ? 'the server' : target.login.host;
  return new FilesTransportError('cancelled', `Connecting to ${where} was cancelled.`);
}

export function createOpenRemoteFiles(deps: ConnectDeps = {}): OpenRemoteFiles {
  const probe = deps.probeHostKey ?? probeSshHostKey;
  return async (target, { purpose, signal, unattended }) => {
    if (signal?.aborted) throw cancelled(target);
    const { login } = target;

    if (login.kind === 'saved') {
      if (unattended && !(await (deps.savedHostKey ?? storedHostKey)(login.sshServerId))) {
        throw new FilesTransportError(
          'hostKeyUnknown',
          'The saved server has no trusted host key yet. Connect to it once yourself (Test ' +
            'connection, or a deploy by hand) to check and trust it.',
        );
      }
      const pool = deps.pool?.() ?? getSshPool();
      let lease: SshLease;
      try {
        lease =
          purpose === 'run'
            ? await pool.openSeparate(login.sshServerId)
            : await pool.acquire(login.sshServerId);
      } catch (error) {
        throw mapSshConnectError(error);
      }
      if (signal?.aborted) {
        lease.release();
        throw cancelled(target);
      }
      return createSftpRemote(lease.connection, lease.release);
    }

    if (target.protocol !== 'sftp') return (deps.openFtp ?? openFtpRemote)(target, { signal });

    if (!login.hostKeyFingerprint) {
      let presented: string;
      try {
        presented = await probe(login.host, login.port);
      } catch (error) {
        throw mapSshConnectError(error);
      }
      throw new FilesTransportError(
        'hostKeyUnknown',
        `${login.host} presented a host key you have not trusted yet. Check its fingerprint ` +
          'and trust it before Runova sends the login.',
        { hostKey: { presented, stored: null } },
      );
    }

    const endpoint: SshEndpoint = {
      host: login.host,
      port: login.port,
      username: login.username,
      authMethod: login.authMethod,
      password: login.authMethod === 'password' ? (login.secret ?? undefined) : undefined,
      passphrase: login.authMethod === 'privateKey' ? (login.secret ?? undefined) : undefined,
      privateKeyPath: login.privateKeyPath ?? undefined,
      storedFingerprint: login.hostKeyFingerprint,
    };
    let connection: SshConnection;
    try {
      // No onHostKeyTrusted: with a stored fingerprint a different key is refused, never stored.
      connection = await (deps.openSsh ?? SshConnection.open)(endpoint, {});
    } catch (error) {
      throw mapSshConnectError(error);
    }
    if (signal?.aborted) {
      connection.close();
      throw cancelled(target);
    }
    return createSftpRemote(connection, () => connection.close());
  };
}

export const openRemoteFiles: OpenRemoteFiles = createOpenRemoteFiles();

/**
 * The host key an SFTP login of the site's own presents, read from the handshake alone, for the
 * user to compare before trusting it. A saved server's key is trusted in Remote, not here.
 */
export async function readHostKey(
  target: FilesConnectTarget,
  deps: Pick<ConnectDeps, 'probeHostKey'> = {},
): Promise<string> {
  if (target.protocol !== 'sftp' || target.login.kind !== 'custom') {
    throw new FilesTransportError(
      'invalidInput',
      'Only an SFTP site with a login of its own has a host key to trust here.',
    );
  }
  try {
    return await (deps.probeHostKey ?? probeSshHostKey)(target.login.host, target.login.port);
  } catch (error) {
    throw mapSshConnectError(error);
  }
}
