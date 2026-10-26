import type {
  ContainerSummary,
  FileSessionInfo,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { parseDockerFileTargetId } from '../../../shared/fileTargets';
import type { SftpServerInfo } from '../../sftp/service';
import type { DockerFilesBackend } from './client';

/**
 * A container or volume as the file manager's header shows it (E27): `web-1 (container)` on the
 * Deploy server's nickname, port 0 (there is no SSH port), as the user the core works as (root
 * until a session says otherwise). A server, container or volume that is not there answers null,
 * which the file manager reports as gone. When the core cannot be asked, the target is still
 * described from its id, so opening it goes on and fails with the real reason.
 */

/** Docker's shortest id prefix that still names one container. */
const SHORT_ID = 12;

export interface DockerTargetLookups {
  backend: () => DockerFilesBackend | null;
  /** The Deploy server's nickname, or null when there is no such server. */
  serverName: (serverId: string) => Promise<string | null>;
  lastSession: (targetId: string) => FileSessionInfo | undefined;
}

/** Whether a container named or id'd `idOrName` is the target (by name, id or id prefix). */
export function sameDockerTarget(
  target: { id: string; displayName?: string },
  idOrName: string,
): boolean {
  if (target.id === idOrName || target.displayName === idOrName) return true;
  const [shorter, longer] =
    target.id.length <= idOrName.length ? [target.id, idOrName] : [idOrName, target.id];
  return shorter.length >= SHORT_ID && /^[0-9a-f]+$/.test(longer) && longer.startsWith(shorter);
}

function findContainer(containers: ContainerSummary[], id: string): ContainerSummary | undefined {
  return containers.find((one) => sameDockerTarget({ id: one.id, displayName: one.name }, id));
}

export async function describeDockerTarget(
  targetId: string,
  lookups: DockerTargetLookups,
): Promise<SftpServerInfo | null> {
  const target = parseDockerFileTargetId(targetId);
  if (!target) return null;
  const host = await lookups.serverName(target.serverId);
  if (host === null) return null;
  let name = target.id;
  const backend = lookups.backend();
  if (backend) {
    try {
      if (target.kind === 'container') {
        const list = await backend.withHub(target.serverId, (hub) => hub.listContainers());
        const found = findContainer(
          list.groups.flatMap((group) => group.containers),
          target.id,
        );
        if (!found) return null;
        name = found.name;
      } else {
        const volumes = await backend.withHub(target.serverId, (hub) => hub.listVolumes());
        if (!volumes.some((volume) => volume.name === target.id)) return null;
      }
    } catch {
      // Not reachable or not signed in: opening the session will say so.
    }
  }
  const session = lookups.lastSession(targetId);
  return {
    nickname: `${session?.displayName ?? name} (${target.kind})`,
    host,
    port: 0,
    username: session?.user || 'root',
  };
}

/**
 * The Docker target ids among `ids` that are on `serverId`: all of them when the server goes, or
 * only those naming one container or volume when it is removed (by name, id or id prefix, or the
 * name the core gave when the session opened).
 */
export function dockerTargetsOn(
  ids: readonly string[],
  serverId: string,
  which?: { kind: 'container' | 'volume'; idOrName: string },
  lastSession: (targetId: string) => Pick<FileSessionInfo, 'displayName'> | undefined = () =>
    undefined,
): string[] {
  return ids.filter((id) => {
    const target = parseDockerFileTargetId(id);
    if (target?.serverId !== serverId) return false;
    if (!which) return true;
    if (target.kind !== which.kind) return false;
    if (which.kind === 'volume') return target.id === which.idOrName;
    return sameDockerTarget(
      { id: target.id, displayName: lastSession(id)?.displayName },
      which.idOrName,
    );
  });
}
