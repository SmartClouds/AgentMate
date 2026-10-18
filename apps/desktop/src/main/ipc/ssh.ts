import { randomUUID } from 'node:crypto';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { dialog, type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import type {
  CreateSshSessionOptions,
  SaveSshServerInput,
  SshAttachResult,
  SshConversationsResult,
  SshSavedServer,
  SshVaultStatus,
  StoredSshServer,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { encodeSshError } from '../../shared/sshErrors';
import { isHostKeyFingerprint, type SshHostKeyStatus } from '../../shared/sshHostKey';
import { listRemoteAgentHistory } from '../agents/remoteSessionHistory';
import { keepAwake } from '../power/keepAwake';
import { probeHostKey } from '../ssh/connectConfig';
import { findSavedServer, updateSshServer } from '../ssh/savedServers';
import { SshSessionManager } from '../ssh/sessionManager';
import {
  decryptSecret,
  encryptSecret,
  getVaultStatus,
  setPasskey,
  unlockVault,
} from '../ssh/vault';
import { VaultLockedError } from '../ssh/vaultErrors';
import { store } from '../store';
import { sendToContents } from './send';

const SESSION_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;

const manager = new SshSessionManager();
/** The session id -> saved server it belongs to, for the last-connected/host-key writebacks. */
const sessions = new Map<string, { serverId: string }>();
/** The window currently showing each session. Output goes there. */
const owners = new Map<string, WebContents>();

/**
 * Lets other main-process code (the SSH AI task runner) watch a session's raw output or learn
 * it ended, without a second `ssh2` listener or a duplicate session registry.
 */
const outputSubscribers = new Map<string, Set<(data: string) => void>>();
const exitSubscribers = new Map<string, Set<() => void>>();
/** Sessions whose output the AI task runner draws itself, through `writeToSshDisplay`. */
const capturedDisplays = new Set<string>();

function syncPowerSaveBlocker(): void {
  keepAwake.setBusy('ssh', sessions.size > 0);
}

function sendToOwner(sessionId: string, data: string): void {
  sendToContents(owners.get(sessionId), IPC.ssh.onData, { sessionId, data });
}

function forwardData(sessionId: string, data: string): void {
  if (!capturedDisplays.has(sessionId)) sendToOwner(sessionId, data);
  for (const listener of outputSubscribers.get(sessionId) ?? []) listener(data);
}

function forwardExit(sessionId: string, error?: string): void {
  sendToContents(owners.get(sessionId), IPC.ssh.onExit, { sessionId, error });
  owners.delete(sessionId);
  sessions.delete(sessionId);
  capturedDisplays.delete(sessionId);
  syncPowerSaveBlocker();
  for (const listener of exitSubscribers.get(sessionId) ?? []) listener();
  outputSubscribers.delete(sessionId);
  exitSubscribers.delete(sessionId);
}

/** The saved server a live session is connected to, or null once it has closed. */
export function sshSessionServerId(sessionId: string): string | null {
  return sessions.get(sessionId)?.serverId ?? null;
}

/** True while `sessionId` has a live shell channel to write into. */
export function hasSshSession(sessionId: string): boolean {
  return sessions.has(sessionId);
}

/** Sends raw bytes into a session's shell, exactly as if the user had typed them. */
export function writeToSshSession(sessionId: string, data: string): void {
  manager.write(sessionId, data);
}

/** Fires with every chunk of raw output a session produces, until the returned function is called. */
export function subscribeSshOutput(
  sessionId: string,
  listener: (data: string) => void,
): () => void {
  let set = outputSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    outputSubscribers.set(sessionId, set);
  }
  set.add(listener);
  return () => set?.delete(listener);
}

/**
 * While captured, output still reaches subscribers but no longer goes to the terminal pane on its
 * own. The AI task runner uses this to keep its bookkeeping (the marker it types after each
 * command) out of sight, drawing what the user should see with `writeToSshDisplay` instead.
 */
export function setSshDisplayCaptured(sessionId: string, captured: boolean): void {
  if (captured) capturedDisplays.add(sessionId);
  else capturedDisplays.delete(sessionId);
}

/** Draws text in a session's terminal pane without sending anything to the server. */
export function writeToSshDisplay(sessionId: string, data: string): void {
  if (data) sendToOwner(sessionId, data);
}

/** Fires once when a session closes, however that happens (remote exit, kill, or app quit). */
export function subscribeSshExit(sessionId: string, listener: () => void): () => void {
  let set = exitSubscribers.get(sessionId);
  if (!set) {
    set = new Set();
    exitSubscribers.set(sessionId, set);
  }
  set.add(listener);
  return () => set?.delete(listener);
}

/**
 * The login password saved for the server a live session belongs to, or null when there isn't
 * one (key auth, nothing saved, or a locked vault). Used to answer a sudo prompt the user has
 * approved; the value must never be sent to the renderer or an AI.
 */
export async function getSshSessionPassword(sessionId: string): Promise<string | null> {
  const info = sessions.get(sessionId);
  if (!info) return null;
  const server = (await store.getSshServers()).find((s) => s.id === info.serverId);
  if (!server?.secretEnvelope || server.authMethod !== 'password') return null;
  try {
    return await decryptSecret(server.secretEnvelope);
  } catch {
    return null;
  }
}

function toPublicServer(server: StoredSshServer): SshSavedServer {
  const { secretEnvelope: _secretEnvelope, ...rest } = server;
  return { ...rest, hasSecret: server.secretEnvelope != null };
}

export function registerSshHandlers(): void {
  ipcMain.handle(
    IPC.ssh.listServers,
    async (): Promise<SshSavedServer[]> => (await store.getSshServers()).map(toPublicServer),
  );

  ipcMain.handle(
    IPC.ssh.saveServer,
    async (_event, input: SaveSshServerInput): Promise<SshSavedServer> => {
      const servers = await store.getSshServers();
      const index = input.id ? servers.findIndex((s) => s.id === input.id) : -1;
      const existing = index >= 0 ? servers[index] : undefined;

      // A stored secret means something different under each auth method (a login password vs.
      // a key passphrase), so switching methods without typing a new one drops it rather than
      // silently reusing the old value for the new meaning.
      const secretEnvelope = input.secret
        ? await encryptSecret(input.secret)
        : existing && existing.authMethod === input.authMethod
          ? existing.secretEnvelope
          : undefined;
      // The trusted host key is only meaningful for the endpoint it was recorded against.
      const hostChanged =
        existing && (existing.host !== input.host || existing.port !== input.port);

      const record: StoredSshServer = {
        id: existing?.id ?? randomUUID(),
        nickname: input.nickname,
        host: input.host,
        port: input.port,
        username: input.username,
        authMethod: input.authMethod,
        privateKeyPath: input.authMethod === 'privateKey' ? input.privateKeyPath : undefined,
        secretEnvelope,
        hostKeyFingerprint: hostChanged ? undefined : existing?.hostKeyFingerprint,
        createdAt: existing?.createdAt ?? Date.now(),
        lastConnectedAt: existing?.lastConnectedAt ?? null,
      };

      const next = [...servers];
      if (index >= 0) next[index] = record;
      else next.push(record);
      await store.setSshServers(next);
      return toPublicServer(record);
    },
  );

  ipcMain.handle(IPC.ssh.removeServer, async (_event, id: string): Promise<void> => {
    for (const [sessionId, info] of sessions) {
      if (info.serverId === id) manager.kill(sessionId);
    }
    const servers = await store.getSshServers();
    await store.setSshServers(servers.filter((s) => s.id !== id));
  });

  ipcMain.handle(IPC.ssh.pickPrivateKeyFile, async (): Promise<string | null> => {
    const result = await dialog.showOpenDialog({
      title: 'Choose a private key',
      defaultPath: join(homedir(), '.ssh'),
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0];
  });

  ipcMain.handle(IPC.ssh.vaultStatus, (): Promise<SshVaultStatus> => getVaultStatus());

  ipcMain.handle(
    IPC.ssh.unlockVault,
    (_event, passphrase: string): Promise<boolean> => unlockVault(passphrase),
  );

  ipcMain.handle(
    IPC.ssh.setPasskey,
    (_event, passphrase: string | null): Promise<{ ok: boolean; error?: string }> =>
      setPasskey(passphrase),
  );

  ipcMain.handle(
    IPC.ssh.create,
    async (
      event: IpcMainInvokeEvent,
      options: CreateSshSessionOptions,
    ): Promise<SshAttachResult> => {
      const sessionId =
        options.sessionId && SESSION_ID_PATTERN.test(options.sessionId)
          ? options.sessionId
          : randomUUID();

      const servers = await store.getSshServers();
      const server = servers.find((s) => s.id === options.savedServerId);
      if (!server) throw new Error('This saved server no longer exists.');

      owners.set(sessionId, event.sender);

      let password: string | undefined;
      let passphrase: string | undefined;
      if (server.secretEnvelope) {
        const secret = await decryptSecret(server.secretEnvelope);
        if (server.authMethod === 'password') password = secret;
        else passphrase = secret;
      }

      try {
        await manager.create(
          sessionId,
          {
            host: server.host,
            port: server.port,
            username: server.username,
            authMethod: server.authMethod,
            password,
            privateKeyPath: server.privateKeyPath,
            passphrase,
            storedFingerprint: server.hostKeyFingerprint,
            cols: options.cols,
            rows: options.rows,
            initialInput: options.initialInput,
          },
          {
            onData: forwardData,
            onExit: forwardExit,
            onHostKeyTrusted: (_id, fingerprint) => {
              void updateSshServer(server.id, (s) => ({ ...s, hostKeyFingerprint: fingerprint }));
            },
          },
        );
      } catch (error) {
        owners.delete(sessionId);
        throw error;
      }

      sessions.set(sessionId, { serverId: server.id });
      syncPowerSaveBlocker();
      void updateSshServer(server.id, (s) => ({ ...s, lastConnectedAt: Date.now() }));
      return { sessionId };
    },
  );

  ipcMain.handle(
    IPC.ssh.hostKeyStatus,
    async (_event, serverId: unknown): Promise<SshHostKeyStatus> => {
      const server = await findSavedServer(String(serverId));
      const presented = await probeHostKey(server.host, server.port);
      return {
        serverId: server.id,
        nickname: server.nickname,
        host: server.host,
        port: server.port,
        stored: server.hostKeyFingerprint ?? null,
        presented,
      };
    },
  );

  ipcMain.handle(
    IPC.ssh.trustHostKey,
    async (_event, serverId: unknown, fingerprint: unknown): Promise<void> => {
      if (!isHostKeyFingerprint(fingerprint)) {
        throw new Error('That is not a host key fingerprint.');
      }
      const server = await findSavedServer(String(serverId));
      // Read the key again, so what gets stored is what the server presents right now and the
      // user saw, not whatever was passed in.
      const presented = await probeHostKey(server.host, server.port);
      if (presented !== fingerprint) {
        throw new Error(
          `${server.nickname} presented a different key just now. Check it again before trusting it.`,
        );
      }
      await updateSshServer(server.id, (s) => ({ ...s, hostKeyFingerprint: fingerprint }));
    },
  );

  ipcMain.handle(
    IPC.ssh.conversations,
    async (_event, serverId: unknown): Promise<SshConversationsResult> => {
      if (typeof serverId !== 'string' || !serverId) {
        throw new Error('That is not a saved server.');
      }
      try {
        return await listRemoteAgentHistory(serverId);
      } catch (error) {
        // A changed host key already carries its code; a locked vault gets one here, so the
        // renderer can ask for the passkey instead of just showing the message.
        if (error instanceof VaultLockedError) {
          throw new Error(encodeSshError('vault-locked', error.message));
        }
        throw error;
      }
    },
  );

  ipcMain.handle(IPC.ssh.write, (_event, sessionId: string, data: string): void => {
    manager.write(sessionId, data);
  });

  ipcMain.handle(IPC.ssh.resize, (_event, sessionId: string, cols: number, rows: number): void => {
    manager.resize(sessionId, cols, rows);
  });

  ipcMain.handle(IPC.ssh.kill, (_event, sessionId: string): void => {
    manager.kill(sessionId);
    owners.delete(sessionId);
    sessions.delete(sessionId);
    syncPowerSaveBlocker();
  });
}

/** How many SSH connections are open, for the confirmation shown before the app closes. */
export function openSshSessionCount(): number {
  return sessions.size;
}

/** Called from `before-quit`; SSH sessions never outlive the app (no host process for them). */
export function killAllSshSessions(): void {
  manager.killAll();
  sessions.clear();
  owners.clear();
  syncPowerSaveBlocker();
}
