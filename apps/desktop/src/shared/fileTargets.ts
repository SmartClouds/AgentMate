/**
 * The id the file manager opens (E27). A saved SSH server's id stands for its disk over SFTP, as
 * in E25. A container or volume on a Deploy server gets an id of its own, so every part of the
 * file manager (sessions, the queue, the status bar, the dock, the pop-out) keys it the same way:
 * `docker~<serverId>~container~<container id or name>` or `docker~<serverId>~volume~<name>`.
 * `~` cannot appear in a container or volume name, and saved server ids are UUIDs.
 */

export type DockerFileTargetKind = 'container' | 'volume';

export interface DockerFileTarget {
  serverId: string;
  kind: DockerFileTargetKind;
  /** The container's id or name, or the volume's name. */
  id: string;
}

const PREFIX = 'docker';
const SEPARATOR = '~';
/** Docker's own rule for container and volume names, ids included. */
const DOCKER_NAME = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,127}$/;
/** The file manager's ids go through IPC checks capped at this length. */
export const FILE_TARGET_ID_MAX = 128;

export function dockerFileTargetId(target: DockerFileTarget): string {
  return [PREFIX, target.serverId, target.kind, target.id].join(SEPARATOR);
}

/** The Docker target an id names, or null for a saved server's id or anything malformed. */
export function parseDockerFileTargetId(id: string): DockerFileTarget | null {
  if (id.length > FILE_TARGET_ID_MAX) return null;
  const parts = id.split(SEPARATOR);
  if (parts.length !== 4 || parts[0] !== PREFIX) return null;
  const [, serverId, kind, name] = parts;
  if (!serverId || (kind !== 'container' && kind !== 'volume')) return null;
  if (!DOCKER_NAME.test(name)) return null;
  return { serverId, kind, id: name };
}

export function isDockerFileTargetId(id: string): boolean {
  return parseDockerFileTargetId(id) !== null;
}
