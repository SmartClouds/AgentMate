import { join } from 'node:path';
import { app, type IpcMainInvokeEvent, webContents } from 'electron';
import { isDockerFileTargetId } from '../../shared/fileTargets';
import { dockerFilesHost } from '../deploy/dockerFiles/backend';
import {
  createDockerFilePool,
  type DockerFilePool,
  routeFilePool,
} from '../deploy/dockerFiles/pool';
import { describeDockerTarget, dockerTargetsOn } from '../deploy/dockerFiles/targets';
import { sendToContents } from '../ipc/send';
import { registerSftpHandlers } from '../ipc/sftp';
import { keepAwake } from '../power/keepAwake';
import type { SshLease } from '../ssh/pool';
import { getSshPool } from '../ssh/sharedPool';
import { store } from '../store';
import type { ClientLease, SftpPool } from './client';
import { LocalBrowseRegistry } from './localBrowse';
import { SftpService } from './service';
import {
  closeAllSftpWindows,
  isSftpWindow,
  openSftpWindow,
  sftpBackToMain,
  sftpLinkedOwners,
  sftpWindowControl,
  sftpWindowState,
} from './window';

/**
 * Wires the SFTP file manager (E25) into Electron: sessions lease from the shared SSH pool (the
 * one the terminal and Deploy use, so the vault and host key handling are the same), events go
 * to the windows that own the session (the main window and the session's pop-out), transfers
 * hold keep-awake, and the editor saves through the OS temp folder. Sessions close when their
 * server is removed and at quit, and the pop-outs close at quit too.
 *
 * Containers and volumes on Deploy servers (E27) have file target ids of their own
 * (shared/fileTargets.ts). Those go to the Docker pool, a file session on the server core per
 * lease; every other id is a saved server and goes to the SSH pool as before. Their sessions also
 * close when Deploy removes the container or volume.
 */

let service: SftpService | null = null;
let dockerPool: DockerFilePool | null = null;

/** The pool's leases call their connection `connection`; the file manager calls it `client`. */
function adapt(lease: SshLease): ClientLease {
  return { client: lease.connection, release: lease.release };
}

export function registerSftpIpc(deps: {
  guard: (event: IpcMainInvokeEvent) => boolean;
}): SftpService {
  const shared = getSshPool();
  const ssh: SftpPool = {
    acquire: async (serverId) => adapt(await shared.acquire(serverId)),
    openSeparate: async (serverId) => adapt(await shared.openSeparate(serverId)),
  };
  const docker = createDockerFilePool({ backend: dockerFilesHost });
  dockerPool = docker;
  const localBrowse = new LocalBrowseRegistry();
  const sftp = new SftpService({
    pool: routeFilePool(ssh, docker),
    findServer: async (serverId) => {
      if (isDockerFileTargetId(serverId)) {
        return describeDockerTarget(serverId, {
          backend: dockerFilesHost,
          serverName: async (id) => (await dockerFilesHost()?.serverName(id)) ?? null,
          lastSession: (id) => docker.lastSession(id),
        });
      }
      const server = (await store.getSshServers()).find((one) => one.id === serverId);
      if (!server) return null;
      const { nickname, host, port, username } = server;
      return { nickname, host, port, username };
    },
    send: (ownerId, channel, payload) =>
      sendToContents(webContents.fromId(ownerId), channel, payload),
    keepAwake: (busy) => keepAwake.setBusy('sftp', busy),
    tempDir: () => join(app.getPath('temp'), 'runova-sftp'),
    localBrowse,
  });
  registerSftpHandlers({
    service: sftp,
    localBrowse,
    windows: {
      isSftpWindow,
      linkedOwners: sftpLinkedOwners,
      open: (info, view) => {
        openSftpWindow(sftp, info, view);
      },
      control: sftpWindowControl,
      state: sftpWindowState,
      backToMain: (contents) => sftpBackToMain(sftp, contents),
    },
    guard: deps.guard,
  });
  service = sftp;
  return sftp;
}

/**
 * At quit: every session ends and its windows are told, then the pop-outs close. Not awaited, so
 * quitting never waits.
 */
export function closeAllSftpSessions(): void {
  void service?.closeAll().catch(() => undefined);
  closeAllSftpWindows();
}

/**
 * A saved server was removed: its sessions end, those on its containers and volumes too, and
 * their windows are told why.
 */
export function closeSftpSessionsForServer(serverId: string): void {
  const sftp = service;
  if (!sftp) return;
  for (const id of [serverId, ...dockerTargetsOn(sftp.serverIds(), serverId)]) {
    void sftp.closeServer(id, 'removed').catch(() => undefined);
  }
}

/** Deploy removed a container or volume (E27): the sessions on it end, told it was removed. */
export function closeDockerFileSessions(
  serverId: string,
  kind: 'container' | 'volume',
  idOrName: string,
): void {
  const sftp = service;
  if (!sftp) return;
  const lastSession = (id: string) => dockerPool?.lastSession(id);
  for (const id of dockerTargetsOn(sftp.serverIds(), serverId, { kind, idOrName }, lastSession)) {
    void sftp.closeServer(id, 'removed').catch(() => undefined);
  }
}
