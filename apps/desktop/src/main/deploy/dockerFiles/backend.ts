import type { DockerFilesBackend } from './client';

/**
 * The Deploy service, as the file manager needs it for containers and volumes (E27). Deploy and
 * the file manager register their IPC separately at start-up, so Deploy hands itself over here
 * and the file manager looks it up when a session opens.
 */

export interface DockerFilesHost extends DockerFilesBackend {
  /** The Deploy server's nickname, or null when there is no such server. */
  serverName(serverId: string): Promise<string | null>;
}

let host: DockerFilesHost | null = null;

export function setDockerFilesHost(next: DockerFilesHost | null): void {
  host = next;
}

/** The Deploy service, or null until Deploy has started. */
export function dockerFilesHost(): DockerFilesHost | null {
  return host;
}
