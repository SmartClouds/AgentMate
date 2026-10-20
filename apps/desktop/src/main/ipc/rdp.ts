import { randomUUID } from 'node:crypto';
import { readFile, stat } from 'node:fs/promises';
import { app, dialog, type IpcMainInvokeEvent, ipcMain, shell, type WebContents } from 'electron';
import type {
  RdpCertificateCheckResult,
  RdpCertificateInfo,
  RdpCertificatePrompt,
  RdpClipboardFiles,
  RdpConnectTicket,
  RdpDownloadTarget,
  RdpSavedServer,
  RdpStageResult,
  RdpStageStart,
  SaveRdpServerInput,
  StoredRdpServer,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { orderById } from '../../shared/orderById';
import { withRdpDefaults } from '../../shared/rdpDefaults';
import { stopRdpTask } from '../agents/rdpTaskRunner';
import { resolveTunnelRoute } from '../network/proxy';
import { keepAwake } from '../power/keepAwake';
import { type ClipboardFileSet, rawSignature, readClipboardFiles } from '../rdp/clipboardFiles';
import {
  abandonDownloads,
  beginDownload,
  downloadFolder,
  downloadRoots,
  finishFile,
  forgetDownload,
  prepareEntry,
  writeChunk,
} from '../rdp/downloads';
import {
  directHandshakeDeps,
  fetchServerCertificate,
  type HandshakeDeps,
  toFailureInfo,
} from '../rdp/handshake';
import { RdpProxy, type RdpProxyTarget } from '../rdp/proxy';
import { formatDestination } from '../rdp/rdcleanpath';
import {
  MAX_STAGED_BYTES,
  prepareStagingFolder,
  putFilesOnClipboard,
  stagingSupported,
  sweepStaleStaging,
} from '../rdp/remoteClipboard';
import { closeAllRdpWindows, openRdpWindow } from '../rdp/sessionWindows';
import { decryptSecret, encryptSecret, getVaultStatus } from '../ssh/vault';
import { store } from '../store';
import { sendToContents } from './send';

interface RdpSession {
  sessionId: string;
  serverId: string;
  owner: WebContents;
  /** Files copied on this computer that the server may ask to paste, by entry index. */
  clipboard: ClipboardFileSet | null;
  /** A changed certificate the person has not trusted yet. */
  pendingCertificate: RdpCertificateInfo | null;
}

const sessions = new Map<string, RdpSession>();

/** How long a certificate fetched from a server stays available to be trusted. */
const CHECKED_CERTIFICATE_TTL_MS = 10 * 60_000;

/**
 * The certificate the last "check" of each server saw. Trusting only accepts what is in here, so
 * what gets saved is exactly what the person was shown, never a value the window made up.
 */
const checkedCertificates = new Map<string, { certificate: RdpCertificateInfo; at: number }>();

/** Saves a certificate as the one to expect from a server. */
function pinCertificate(
  certificate: RdpCertificateInfo,
): (server: StoredRdpServer) => StoredRdpServer {
  return (server) => ({
    ...server,
    certFingerprint: certificate.fingerprint,
    certDetails: {
      subject: certificate.subject,
      issuer: certificate.issuer,
      validTo: certificate.validTo,
    },
  });
}

function toPublicServer(server: StoredRdpServer): RdpSavedServer {
  const { secretEnvelope: _secretEnvelope, ...rest } = server;
  return {
    ...rest,
    options: withRdpDefaults(rest.options),
    hasSecret: server.secretEnvelope != null,
  };
}

/** Same reasoning as the SSH handlers: a connect writes twice in quick succession. */
let updateQueue: Promise<void> = Promise.resolve();

function updateServer(
  id: string,
  update: (server: StoredRdpServer) => StoredRdpServer,
): Promise<void> {
  const next = updateQueue.then(async () => {
    const servers = await store.getRdpServers();
    const index = servers.findIndex((s) => s.id === id);
    if (index < 0) return;
    const updated = [...servers];
    updated[index] = update(updated[index]);
    await store.setRdpServers(updated);
  });
  updateQueue = next.catch(() => undefined);
  return next;
}

/** Saves the servers in the order the list was dragged into, on the same queue as `updateServer`. */
function reorderServers(orderedIds: string[]): Promise<StoredRdpServer[]> {
  let reordered: StoredRdpServer[] = [];
  const next = updateQueue.then(async () => {
    reordered = orderById(await store.getRdpServers(), orderedIds);
    await store.setRdpServers(reordered);
  });
  updateQueue = next.catch(() => undefined);
  return next.then(() => reordered);
}

function sessionFor(event: IpcMainInvokeEvent, sessionId: string): RdpSession {
  const session = sessions.get(sessionId);
  if (!session || session.owner !== event.sender) throw new Error('This session has ended.');
  return session;
}

function send(session: RdpSession, channel: string, payload: unknown): void {
  sendToContents(session.owner, channel, payload);
}

/**
 * Sessions and certificate checks both go through the proxy from the Network settings when one
 * is on, so a certificate checked here is the one the session will see.
 */
const handshakeDeps: HandshakeDeps = { ...directHandshakeDeps, route: resolveTunnelRoute };

const proxy = new RdpProxy(
  {
    onCertificateFirstSeen: (target, cert) => {
      const session = sessions.get(target.sessionId);
      if (session) void updateServer(session.serverId, pinCertificate(cert));
    },
    onCertificateMismatch: (target, cert) => {
      const session = sessions.get(target.sessionId);
      if (!session) return;
      session.pendingCertificate = cert;
      const prompt: RdpCertificatePrompt = {
        sessionId: session.sessionId,
        host: target.host,
        expectedFingerprint: target.expectedFingerprint ?? '',
        actualFingerprint: cert.fingerprint,
        subject: cert.subject,
        issuer: cert.issuer,
        validTo: cert.validTo,
      };
      send(session, IPC.rdp.onCertificatePrompt, prompt);
    },
    onConnected: (target) => {
      const session = sessions.get(target.sessionId);
      if (!session) return;
      // Connected, so there is no certificate left to ask about.
      session.pendingCertificate = null;
      void updateServer(session.serverId, (s) => ({ ...s, lastConnectedAt: Date.now() }));
    },
    onError: (target, failure) => {
      const session = sessions.get(target.sessionId);
      if (session)
        send(session, IPC.rdp.onProxyError, { sessionId: session.sessionId, ...failure });
    },
  },
  handshakeDeps,
);

function syncPowerSaveBlocker(): void {
  keepAwake.setBusy('rdp', sessions.size > 0);
}

export function registerRdpHandlers(): void {
  // Files staged for the clipboard by an earlier run stay on disk until now.
  void sweepStaleStaging();

  ipcMain.handle(
    IPC.rdp.listServers,
    async (): Promise<RdpSavedServer[]> => (await store.getRdpServers()).map(toPublicServer),
  );

  ipcMain.handle(
    IPC.rdp.saveServer,
    async (_event, input: SaveRdpServerInput): Promise<RdpSavedServer> => {
      const servers = await store.getRdpServers();
      const index = input.id ? servers.findIndex((s) => s.id === input.id) : -1;
      const existing = index >= 0 ? servers[index] : undefined;
      // A pinned certificate only means something for the endpoint it was seen on.
      const endpointChanged =
        existing && (existing.host !== input.host || existing.port !== input.port);
      if (existing && endpointChanged) checkedCertificates.delete(existing.id);

      const record: StoredRdpServer = {
        id: existing?.id ?? randomUUID(),
        nickname: input.nickname,
        host: input.host,
        port: input.port,
        username: input.username,
        domain: input.domain || undefined,
        secretEnvelope: input.secret ? await encryptSecret(input.secret) : existing?.secretEnvelope,
        certFingerprint: endpointChanged ? undefined : existing?.certFingerprint,
        certDetails: endpointChanged ? undefined : existing?.certDetails,
        options: withRdpDefaults(input.options),
        createdAt: existing?.createdAt ?? Date.now(),
        lastConnectedAt: existing?.lastConnectedAt ?? null,
      };

      const next = [...servers];
      if (index >= 0) next[index] = record;
      else next.push(record);
      await store.setRdpServers(next);
      return toPublicServer(record);
    },
  );

  ipcMain.handle(IPC.rdp.removeServer, async (_event, id: string): Promise<void> => {
    const servers = await store.getRdpServers();
    await store.setRdpServers(servers.filter((s) => s.id !== id));
    checkedCertificates.delete(id);
  });

  ipcMain.handle(
    IPC.rdp.reorderServers,
    async (_event, orderedIds: string[]): Promise<RdpSavedServer[]> =>
      (await reorderServers(orderedIds)).map(toPublicServer),
  );

  ipcMain.handle(IPC.rdp.openSession, async (_event, serverId: string): Promise<string> => {
    const server = (await store.getRdpServers()).find((s) => s.id === serverId);
    if (!server) throw new Error('This saved server no longer exists.');
    if (server.secretEnvelope?.mode === 'passphrase' && !(await getVaultStatus()).unlocked) {
      throw new Error('The vault is locked. Unlock it with your passkey first.');
    }

    const sessionId = randomUUID();
    let ownerId = -1;
    const { fullscreenOnConnect, maximizeOnConnect } = withRdpDefaults(server.options);
    const window = openRdpWindow({
      sessionId,
      title: `${server.nickname} - Remote Desktop`,
      fullScreen: fullscreenOnConnect,
      maximized: maximizeOnConnect,
      onClosed: () => {
        stopRdpTask(sessionId, 'exited');
        sessions.delete(sessionId);
        proxy.closeSession(sessionId);
        void abandonDownloads(ownerId);
        syncPowerSaveBlocker();
      },
    });
    ownerId = window.webContents.id;
    const session: RdpSession = {
      sessionId,
      serverId,
      owner: window.webContents,
      clipboard: null,
      pendingCertificate: null,
    };
    sessions.set(sessionId, session);
    syncPowerSaveBlocker();
    return sessionId;
  });

  // Asked again for every connection attempt, so a reconnect gets a fresh one-time proxy URL
  // and the latest saved details (a password changed or a certificate trusted in between).
  ipcMain.handle(IPC.rdp.getTicket, async (event, sessionId: string): Promise<RdpConnectTicket> => {
    const session = sessionFor(event, sessionId);
    const server = (await store.getRdpServers()).find((s) => s.id === session.serverId);
    if (!server) throw new Error('This saved server no longer exists.');

    const target: RdpProxyTarget = {
      sessionId,
      host: server.host,
      port: server.port,
      expectedFingerprint: server.certFingerprint,
    };
    // `DOMAIN\user` is how people type it on Windows; the engine wants the parts apart.
    // A `user@domain` name is passed through as is, which Windows accepts.
    const slash = server.username.indexOf('\\');
    const username = slash > 0 ? server.username.slice(slash + 1) : server.username;
    const domain = slash > 0 ? server.username.slice(0, slash) : server.domain;

    return {
      sessionId,
      serverId: server.id,
      nickname: server.nickname,
      proxyUrl: await proxy.issueUrl(target),
      destination: formatDestination(server.host, server.port),
      username,
      domain,
      password: server.secretEnvelope ? await decryptSecret(server.secretEnvelope) : '',
      options: withRdpDefaults(server.options),
    };
  });

  ipcMain.handle(
    IPC.rdp.respondCertificate,
    async (event, sessionId: string, trust: boolean): Promise<void> => {
      const session = sessionFor(event, sessionId);
      // Kept after a "no": the failed screen can bring the question back (Review certificate),
      // and the answer to that has to find the certificate it is about.
      const pending = session.pendingCertificate;
      if (!trust || !pending) return;
      session.pendingCertificate = null;
      await updateServer(session.serverId, pinCertificate(pending));
    },
  );

  // Fetches what the server presents now, to compare with the saved certificate. This is the
  // "get the certificate again" of the Windows client, without opening a session.
  ipcMain.handle(
    IPC.rdp.checkCertificate,
    async (_event, serverId: string): Promise<RdpCertificateCheckResult> => {
      const server = (await store.getRdpServers()).find((s) => s.id === serverId);
      if (!server) throw new Error('This saved server no longer exists.');

      let certificate: RdpCertificateInfo;
      try {
        certificate = await fetchServerCertificate(server.host, server.port, handshakeDeps);
      } catch (error) {
        return { ok: false, failure: toFailureInfo(error, server.host, server.port) };
      }
      checkedCertificates.set(serverId, { certificate, at: Date.now() });

      const status = !server.certFingerprint
        ? 'new'
        : server.certFingerprint === certificate.fingerprint
          ? 'same'
          : 'changed';
      // A certificate saved before its details were kept gets them now that it is seen again.
      if (status === 'same' && !server.certDetails) {
        await updateServer(serverId, pinCertificate(certificate));
      }
      return {
        ok: true,
        check: {
          certificate,
          status,
          saved: server.certFingerprint
            ? {
                fingerprint: server.certFingerprint,
                details: server.certDetails ?? (status === 'same' ? certificate : undefined),
              }
            : undefined,
        },
      };
    },
  );

  ipcMain.handle(
    IPC.rdp.trustCertificate,
    async (_event, serverId: string, fingerprint: string): Promise<void> => {
      const checked = checkedCertificates.get(serverId);
      if (
        !checked ||
        checked.certificate.fingerprint !== fingerprint ||
        Date.now() - checked.at > CHECKED_CERTIFICATE_TTL_MS
      ) {
        throw new Error('That certificate is out of date. Get it from the server again.');
      }
      await updateServer(serverId, pinCertificate(checked.certificate));
      checkedCertificates.delete(serverId);
    },
  );

  // After this the next connection accepts whatever certificate the server presents and saves
  // it, as if the server had never been connected to.
  ipcMain.handle(IPC.rdp.forgetCertificate, async (_event, serverId: string): Promise<void> => {
    checkedCertificates.delete(serverId);
    await updateServer(serverId, (s) => ({
      ...s,
      certFingerprint: undefined,
      certDetails: undefined,
    }));
  });

  ipcMain.handle(
    IPC.rdp.readClipboardFiles,
    async (
      event,
      sessionId: string,
      previousSignature: string | null,
    ): Promise<RdpClipboardFiles | 'unchanged' | null> => {
      const session = sessionFor(event, sessionId);
      const result = await readClipboardFiles(previousSignature);
      if (result === 'unchanged') return result;
      session.clipboard = result;
      return result?.files ?? null;
    },
  );

  // Only files from the listing above can be read, by index, so the window can't ask for
  // an arbitrary path.
  ipcMain.handle(
    IPC.rdp.readClipboardFile,
    async (event, sessionId: string, signature: string, index: number): Promise<Uint8Array> => {
      const session = sessionFor(event, sessionId);
      const set = session.clipboard;
      if (!set || set.files.signature !== signature || set.files.tooLarge) {
        throw new Error('The copied files changed. Copy them again.');
      }
      const source = set.sources[index];
      if (!source) throw new Error('That entry is not a file.');
      return new Uint8Array(await readFile(source));
    },
  );

  ipcMain.handle(
    IPC.rdp.beginDownload,
    async (event, sessionId: string): Promise<RdpDownloadTarget | null> => {
      sessionFor(event, sessionId);
      const result = await dialog.showOpenDialog({
        title: 'Save files from the server',
        defaultPath: app.getPath('downloads'),
        buttonLabel: 'Save here',
        properties: ['openDirectory', 'createDirectory'],
      });
      if (result.canceled || result.filePaths.length === 0) return null;
      const folder = result.filePaths[0];
      return { downloadId: beginDownload(event.sender.id, folder), folder };
    },
  );

  ipcMain.handle(
    IPC.rdp.prepareDownloadEntry,
    (
      event,
      downloadId: string,
      index: number,
      entry: { name: string; path?: string; isDirectory: boolean },
    ): Promise<string> => prepareEntry(downloadId, event.sender.id, index, entry),
  );

  ipcMain.handle(
    IPC.rdp.writeDownloadChunk,
    (event, downloadId: string, index: number, bytes: Uint8Array): Promise<void> =>
      writeChunk(downloadId, event.sender.id, index, bytes),
  );

  ipcMain.handle(
    IPC.rdp.finishDownloadFile,
    (event, downloadId: string, index: number, ok: boolean): Promise<void> =>
      finishFile(downloadId, event.sender.id, index, ok),
  );

  ipcMain.handle(IPC.rdp.openDownloadFolder, async (event, downloadId: string): Promise<void> => {
    await shell.openPath(downloadFolder(downloadId, event.sender.id));
  });

  // Files copied on the server are downloaded into a folder of ours as soon as they are copied,
  // then put on this computer's clipboard, so Ctrl+V in Explorer pastes them without a trip
  // through "Save files". The window fills the folder with the download calls above.
  ipcMain.handle(
    IPC.rdp.beginStaging,
    async (event, sessionId: string, totalBytes: number): Promise<RdpStageStart> => {
      sessionFor(event, sessionId);
      if (!stagingSupported()) return { ok: false, reason: 'unsupported' };
      if (!(totalBytes <= MAX_STAGED_BYTES)) {
        return { ok: false, reason: 'tooLarge', limitBytes: MAX_STAGED_BYTES };
      }
      const folder = await prepareStagingFolder(sessionId);
      return { ok: true, downloadId: beginDownload(event.sender.id, folder) };
    },
  );

  ipcMain.handle(
    IPC.rdp.finishStaging,
    async (event, sessionId: string, downloadId: string): Promise<RdpStageResult> => {
      sessionFor(event, sessionId);
      const staged = downloadRoots(downloadId, event.sender.id);
      forgetDownload(downloadId, event.sender.id);
      const present: string[] = [];
      for (const path of staged) {
        if (await stat(path).catch(() => null)) present.push(path);
      }
      if (present.length === 0) return { ok: false, error: 'Nothing was copied from the server.' };
      try {
        await putFilesOnClipboard(present);
      } catch (error) {
        return { ok: false, error: error instanceof Error ? error.message : String(error) };
      }
      return { ok: true, count: present.length, signature: rawSignature() };
    },
  );
}

/** How many Remote Desktop sessions are open, for the confirmation shown before the app closes. */
export function openRdpSessionCount(): number {
  return sessions.size;
}

/** Called from `before-quit`. */
export function closeAllRdpSessions(): void {
  closeAllRdpWindows();
  proxy.shutdown();
  sessions.clear();
  syncPowerSaveBlocker();
}
