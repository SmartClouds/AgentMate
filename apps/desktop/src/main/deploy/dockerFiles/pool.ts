import type { FileSessionInfo } from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { filesError } from '../../../shared/deployFilesErrors';
import { isDockerFileTargetId, parseDockerFileTargetId } from '../../../shared/fileTargets';
import type { ClientLease, SftpPool } from '../../sftp/client';
import { coreFilesFailure, DockerFileClient, type DockerFilesBackend } from './client';

/**
 * Leases for the file manager on containers and volumes (E27). Each lease is a file session of
 * its own on the server core (`filesOpen`), the browse lease and the engine's transfer lease
 * alike, and releasing it closes the session (`filesClose`, a failure ignored: the core forgets
 * idle sessions by itself).
 *
 * Opening is refused in the words the connect step of the file manager understands: a target
 * that is not there is `siteUnknown`, a role that is not Admin `permissionDenied`.
 */

const UNAUTHORIZED = /because user is unauthorized/;
const ONLY_ADMINS = 'Only Admins can browse files in containers and volumes.';

export interface DockerFilePoolDeps {
  /** The Deploy service's ways to a core, or null before Deploy has started. */
  backend: () => DockerFilesBackend | null;
  /** How long a transfer may go without a byte moving (tests). */
  stallTimeoutMs?: number;
}

export interface DockerFilePool extends SftpPool {
  /** What the core said when it last opened a session on the target, for the page's header. */
  lastSession(targetId: string): FileSessionInfo | undefined;
}

function openFailure(error: unknown): Error {
  const coded = coreFilesFailure(error);
  if (coded?.code === 'notFound' || coded?.code === 'targetGone') {
    return filesError('siteUnknown', coded.sentence);
  }
  if (coded?.code === 'permissionDenied') return filesError('permissionDenied', coded.sentence);
  if (coded) return filesError('server', coded.sentence);
  if (UNAUTHORIZED.test(error instanceof Error ? error.message : String(error))) {
    return filesError('permissionDenied', ONLY_ADMINS);
  }
  return error instanceof Error ? error : new Error(String(error));
}

export function createDockerFilePool(deps: DockerFilePoolDeps): DockerFilePool {
  const sessions = new Map<string, FileSessionInfo>();

  const open = async (targetId: string): Promise<ClientLease> => {
    const target = parseDockerFileTargetId(targetId);
    if (!target) throw filesError('invalidInput', 'That is not a container or a volume.');
    const backend = deps.backend();
    if (!backend) throw filesError('server', 'Deploy is still starting. Try again in a moment.');
    let session: FileSessionInfo;
    try {
      session = await backend.withHub(target.serverId, (hub) =>
        hub.filesOpen({ kind: target.kind, id: target.id }),
      );
    } catch (error) {
      throw openFailure(error);
    }
    sessions.set(targetId, session);
    const client = new DockerFileClient({
      serverId: target.serverId,
      session,
      backend,
      ...(deps.stallTimeoutMs ? { stallTimeoutMs: deps.stallTimeoutMs } : {}),
    });
    return {
      client,
      release: () => {
        void client.close();
      },
    };
  };

  return {
    acquire: open,
    openSeparate: open,
    lastSession: (targetId) => sessions.get(targetId),
  };
}

/** Docker target ids to the Docker pool, every other id (a saved server's) to the SSH pool. */
export function routeFilePool(ssh: SftpPool, docker: SftpPool): SftpPool {
  const pick = (id: string): SftpPool => (isDockerFileTargetId(id) ? docker : ssh);
  return {
    acquire: (id) => pick(id).acquire(id),
    openSeparate: (id) => pick(id).openSeparate(id),
  };
}
