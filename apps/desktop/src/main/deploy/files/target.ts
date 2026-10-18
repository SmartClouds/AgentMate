import type { SecretEnvelope } from '../../../shared/apiTypes';
import { filesError } from '../../../shared/deployFilesErrors';
import type { FileSiteInput } from '../../../shared/deployFilesTypes';
import { decryptSecret } from '../../ssh/vault';
import { VaultLockedError } from '../../ssh/vaultErrors';
import { cleanFileSiteConnection, cleanRemoteRoot, keepsTrust, reusesStoredSecret } from './store';
import type { FilesConnectTarget, StoredFileSite } from './types';

/**
 * What a connect to an FTP or SFTP site needs, built right before the connect and never kept:
 * the login with its secret unsealed. A server saved in Remote is only named here, since the
 * Remote list unseals its own login.
 */

async function unseal(envelope: SecretEnvelope): Promise<string> {
  try {
    return await decryptSecret(envelope);
  } catch (error) {
    if (error instanceof VaultLockedError || (error as Error)?.name === 'VaultLockedError') {
      throw filesError(
        'vaultLocked',
        'The Servers vault is locked. Unlock it with your passkey to connect to this site.',
      );
    }
    throw error;
  }
}

/** The connect target of a saved site. A locked vault fails with `vaultLocked`. */
export async function connectTargetOf(stored: StoredFileSite): Promise<FilesConnectTarget> {
  const { connection } = stored;
  if (connection.kind === 'saved') {
    return {
      protocol: 'sftp',
      login: { kind: 'saved', sshServerId: connection.sshServerId },
      remoteRoot: stored.remoteRoot,
    };
  }
  const { secretEnvelope, ...login } = connection;
  return {
    protocol: stored.protocol,
    login: { ...login, secret: secretEnvelope ? await unseal(secretEnvelope) : null },
    remoteRoot: stored.remoteRoot,
  };
}

/**
 * The connect target for Test connection or the remote folder browser, from what the dialog holds
 * now, which may not be saved. With `existing`, a left-out secret is the stored one, but only
 * while the login is the same one it was stored for (the same rule a save follows), and the
 * trusted host key or certificate is kept only while the host and port are. Only the parts a
 * connect needs are checked, so the dialog can test before the local folder is picked.
 */
export async function connectTargetOfInput(
  input: FileSiteInput,
  existing: StoredFileSite | null,
): Promise<FilesConnectTarget> {
  const protocol = input?.protocol;
  if (protocol !== 'sftp' && protocol !== 'ftps' && protocol !== 'ftp') {
    throw filesError('invalidInput', 'Pick SFTP, FTPS or FTP as the protocol.');
  }
  const connection = await cleanFileSiteConnection(protocol, input.connection);
  const remoteRoot = cleanRemoteRoot(input.remoteRoot);
  if (connection.kind === 'saved') {
    return { protocol: 'sftp', login: connection, remoteRoot };
  }
  const prior = existing?.connection.kind === 'custom' ? existing.connection : null;
  let secret = connection.secret;
  if (
    !secret &&
    prior?.secretEnvelope &&
    existing &&
    reusesStoredSecret(existing, protocol, connection)
  ) {
    secret = await unseal(prior.secretEnvelope);
  }
  const trusted = prior && existing && keepsTrust(existing, protocol, connection) ? prior : null;
  return {
    protocol,
    login: {
      kind: 'custom',
      host: connection.host,
      port: connection.port,
      username: connection.username,
      authMethod: connection.authMethod,
      privateKeyPath: connection.privateKeyPath,
      hostKeyFingerprint: trusted?.hostKeyFingerprint ?? null,
      tlsPin: trusted?.tlsPin ?? null,
      tlsServername: connection.tlsServername,
      secret,
    },
    remoteRoot,
  };
}
