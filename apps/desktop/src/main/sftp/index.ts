import { join } from 'node:path';
import { app, type IpcMainInvokeEvent, webContents } from 'electron';
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
 */

let service: SftpService | null = null;

/** The pool's leases call their connection `connection`; the file manager calls it `client`. */
function adapt(lease: SshLease): ClientLease {
  return { client: lease.connection, release: lease.release };
}

export function registerSftpIpc(deps: {
  guard: (event: IpcMainInvokeEvent) => boolean;
}): SftpService {
  const shared = getSshPool();
  const pool: SftpPool = {
    acquire: async (serverId) => adapt(await shared.acquire(serverId)),
    openSeparate: async (serverId) => adapt(await shared.openSeparate(serverId)),
  };
  const localBrowse = new LocalBrowseRegistry();
  const sftp = new SftpService({
    pool,
    findServer: async (serverId) => {
      const server = (await store.getSshServers()).find((one) => one.id === serverId);
      if (!server) return null;
      const { nickname, host, port, username } = server;
      return { nickname, host, port, username };
    },
    send: (ownerId, channel, payload) =>
      sendToContents(webContents.fromId(ownerId), channel, payload),
    keepAwake: (busy) => keepAwake.setBusy('sftp', busy),
    tempDir: () => join(app.getPath('temp'), 'agentmate-sftp'),
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

/** A saved server was removed: its sessions end and their windows are told why. */
export function closeSftpSessionsForServer(serverId: string): void {
  void service?.closeServer(serverId, 'removed').catch(() => undefined);
}
