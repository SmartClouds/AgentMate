import { dockerFileTargetId, parseDockerFileTargetId } from '@shared/fileTargets';

/**
 * Where a Deploy server's Files section points (E27), kept in the page address next to the
 * server and the section: `source=server|container|volume` and, for Docker, `target=<name>`.
 */

export type FilesSource = 'server' | 'container' | 'volume';

export interface FilesChoice {
  source: FilesSource;
  /** The container's or volume's name; null for the server disk or before one is picked. */
  target: string | null;
}

const SOURCES: readonly FilesSource[] = ['server', 'container', 'volume'];

function isSource(value: string | null): value is FilesSource {
  return SOURCES.includes(value as FilesSource);
}

/**
 * The choice the address holds. The server disk is the default where the server is reached over
 * SSH; elsewhere (the DevHost) there is no disk to offer, so it falls back to containers.
 */
export function filesChoice(params: URLSearchParams, options: { sshDisk: boolean }): FilesChoice {
  const asked = params.get('source');
  let source: FilesSource = isSource(asked) ? asked : options.sshDisk ? 'server' : 'container';
  if (source === 'server' && !options.sshDisk) source = 'container';
  if (source === 'server') return { source, target: null };
  return { source, target: params.get('target') || null };
}

/** The address of a choice, for `setSearchParams`. */
export function filesParams(serverId: string, choice: FilesChoice): Record<string, string> {
  const params: Record<string, string> = { server: serverId, view: 'files', source: choice.source };
  if (choice.source !== 'server' && choice.target) params.target = choice.target;
  return params;
}

/** A link to the Files section on a choice, from anywhere in the app. */
export function serverFilesHref(serverId: string, choice: FilesChoice): string {
  return `/deploy?${new URLSearchParams(filesParams(serverId, choice)).toString()}`;
}

/**
 * The id the file manager opens for a choice: the server's own id for its disk, a Docker target
 * id for a container or volume. Null while no target is picked, or for a name Docker never gives
 * (one typed into the address by hand).
 */
export function fileManagerId(serverId: string, choice: FilesChoice): string | null {
  if (choice.source === 'server') return serverId;
  if (!choice.target) return null;
  const id = dockerFileTargetId({ serverId, kind: choice.source, id: choice.target });
  const parsed = parseDockerFileTargetId(id);
  return parsed && parsed.id === choice.target && parsed.serverId === serverId ? id : null;
}
