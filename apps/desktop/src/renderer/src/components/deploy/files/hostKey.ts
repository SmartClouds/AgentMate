import type { FileSite } from '@shared/deployFilesTypes';
import { type HostKeyTrustSource, withHostKeyTrust } from '@/lib/ssh/hostKeyTrust';

/**
 * Host keys for FTP and SFTP sites (E23). A site with a login of its own keeps its trusted key
 * itself, so a changed key is read and trusted through the site's channels rather than Remote's.
 */
export function fileSiteHostKeySource(siteId: string): HostKeyTrustSource {
  return {
    status: () => window.runova.deployFiles.hostKeyStatus(siteId),
    trust: (fingerprint) => window.runova.deployFiles.trustHostKey(siteId, fingerprint),
  };
}

/**
 * Runs a call on a site and, when its SFTP server's host key changed, asks the user the same
 * question every SSH connection asks. FTP and FTPS have no host key, so their calls just run.
 */
export function withFileSiteHostKeyTrust<T>(site: FileSite, attempt: () => Promise<T>): Promise<T> {
  if (site.protocol !== 'sftp') return attempt();
  if (site.connection.kind === 'saved') {
    return withHostKeyTrust(site.connection.sshServerId, attempt);
  }
  return withHostKeyTrust(fileSiteHostKeySource(site.id), attempt);
}
