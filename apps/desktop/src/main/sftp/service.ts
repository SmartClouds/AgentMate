import { randomUUID } from 'node:crypto';
import { filesError, filesErrorCode } from '../../shared/deployFilesErrors';
import { IPC } from '../../shared/ipcChannels';
import { isValidEntryName } from '../../shared/sftpNames';
import type {
  SftpBatchRef,
  SftpChmodInput,
  SftpConflictDecision,
  SftpDownloadInput,
  SftpListing,
  SftpQueueSnapshot,
  SftpRemoteEntry,
  SftpSessionClosed,
  SftpSessionInfo,
  SftpTarget,
  SftpTextFile,
  SftpUploadInput,
  SftpWriteTextInput,
} from '../../shared/sftpTypes';
import { sshErrorCode } from '../../shared/sshErrors';
import { mapSshConnectError } from '../deploy/files/transport/errors';
import { baseName, joinRemote, parentOf } from '../deploy/files/transport/remotePath';
import { VaultLockedError } from '../ssh/vaultErrors';
import type { ClientLease, SftpDetailedEntry, SftpFileClient, SftpPool } from './client';
import { createTransferEngine, type TransferEngine, type TransferEngineDeps } from './engine';
import { toCodedError } from './errors';
import type { LocalBrowseRegistry } from './localBrowse';
import { parseLongname } from './longname';
import { assertRemoteAbsolute, resolveRemoteInput } from './remotePaths';
import { readText, writeText } from './textFile';
import { remoteEntryOf } from './walk';

/**
 * The SFTP sessions of the file manager (E25). A session is opened by one window (its first
 * owner, the `webContents` id) on one saved server, and every call names both: a session id from
 * a window that does not own it is refused as if it did not exist. More windows can own the same
 * session (`addOwner`, for the pop-out window): they are views of it, and each hears its events.
 * Windows linked that way (the main window and its pop-outs, `peers` on `open`) share one
 * session per server: opening a server a peer has a session on joins that session.
 *
 * Browsing (D1, D2) runs on the server's shared connection, `pool.acquire`, the one the terminal
 * and Deploy use too. `withBrowse` heals it: a lease whose connection has closed is swapped for a
 * new one, and a call that fails because the connection dropped is tried once more. After
 * `idleMs` with no call and no transfer the lease is handed back; the session stays and the next
 * call takes a lease again.
 *
 * Transfers, deletes and chmods go to the session's `TransferEngine`, which opens a connection of
 * its own (`pool.openSeparate`) when it has work and hands it back once idle. Its snapshots and
 * finished events go to every owner. Keep-awake is held while any session's engine is busy.
 *
 * Sessions outlive a reload of the page (D3): `open` from a window that already owns a session on
 * the server answers that session. They end on `close` from any owner (the others are told it
 * was `disconnected`), once the last owner has gone (`dropOwner`, `removeOwner`), when the server
 * is removed (`closeServer`) and at quit (`closeAll`); the last two tell every owner. A window
 * about to go can hand its sessions to another first (`adoptSessions`), which is told.
 *
 * Failures come out coded (`[files:*]`, or `[ssh:*]` for the vault and host key flows).
 */

/** How long the browse connection is kept with nothing to do. */
export const SFTP_BROWSE_IDLE_MS = 10 * 60_000;

/** What a session tells the page about its saved server. */
export interface SftpServerInfo {
  nickname: string;
  host: string;
  port: number;
  username: string;
}

export interface SftpServiceDeps {
  pool: SftpPool;
  /** The saved server, or null when there is none with that id. */
  findServer(serverId: string): Promise<SftpServerInfo | null>;
  /** Sends an event to one window, when it is still there. */
  send(ownerId: number, channel: string, payload: unknown): void;
  /** True while any transfer is running, false once none is. */
  keepAwake(busy: boolean): void;
  /** Where the remote editor writes a save before it is uploaded. */
  tempDir(): string;
  /** The local folders each window may write in (downloads land only there). */
  localBrowse: LocalBrowseRegistry;
  /** How long an idle browse connection is kept. Default `SFTP_BROWSE_IDLE_MS`. */
  idleMs?: number;
  /** Session ids. Default `randomUUID`. */
  randomId?: () => string;
  /** Passed on to every session's engine (tests set the platform and timings). */
  engine?: Partial<
    Pick<
      TransferEngineDeps,
      'now' | 'concurrency' | 'coalesceMs' | 'idleReleaseMs' | 'localStat' | 'platform'
    >
  >;
}

interface Session {
  info: SftpSessionInfo;
  /** The windows that may use the session and hear its events. Never empty while it is open. */
  owners: Set<number>;
  engine: TransferEngine;
  /** The browse lease, or null while none is held. */
  lease: ClientLease | null;
  /** A lease being taken, shared by the calls that need it meanwhile. */
  leasing: Promise<ClientLease> | null;
  /** The engine's own connection, while it has one. */
  transferLease: ClientLease | null;
  /** Browse calls running now. */
  ops: number;
  idleTimer: ReturnType<typeof setTimeout> | null;
  /** The engine says it is moving something. */
  busy: boolean;
  closed: boolean;
}

interface PendingOpen {
  ownerId: number;
  serverId: string;
  /** The window went or the server was removed while it was opening. */
  cancelled: boolean;
  promise: Promise<SftpSessionInfo> | null;
}

/** A connection that has ended, whichever way the failure says so. */
const DROPPED = /connection .*(closed|lost)|is closed|no connection|ECONNRESET|EPIPE/i;

function unknownSession(): Error {
  return filesError('invalidInput', 'Unknown session. Open the server again.');
}

function closedWhileOpening(): Error {
  return filesError('invalidInput', 'The session was closed before it finished opening.');
}

/** A failure to log in, coded so the vault and host key prompts still recognise it. */
function connectError(error: unknown): Error {
  if (sshErrorCode(error) || error instanceof VaultLockedError) return toCodedError(error);
  return mapSshConnectError(error);
}

function isDropped(client: SftpFileClient, error: unknown): boolean {
  if (!client.isOpen) return true;
  if (filesErrorCode(error) === 'unreachable') return true;
  return DROPPED.test(error instanceof Error ? error.message : String(error));
}

function assertName(name: string): void {
  if (!isValidEntryName(name)) {
    throw filesError('invalidInput', 'That name cannot be used for a file or folder.');
  }
}

/** One entry of the remote folder `dir`, as the remote pane shows it. */
export function toRemoteEntry(dir: string, entry: SftpDetailedEntry): SftpRemoteEntry {
  const kind = entry.brokenLink
    ? 'link'
    : entry.isDirectory
      ? 'dir'
      : entry.isFile
        ? 'file'
        : 'other';
  const { owner, group } = parseLongname(entry.longname);
  return {
    name: entry.name,
    path: joinRemote(dir, entry.name),
    kind,
    isDirectory: entry.isDirectory,
    isSymlink: entry.isSymlink,
    size: entry.isDirectory ? 0 : entry.size,
    mtimeMs: entry.mtimeMs,
    mode: entry.mode,
    owner,
    group,
  };
}

export class SftpService {
  private readonly sessions = new Map<string, Session>();
  private readonly pending = new Map<string, PendingOpen>();
  private readonly idleMs: number;
  private readonly randomId: () => string;
  private awake = false;

  constructor(private readonly deps: SftpServiceDeps) {
    this.idleMs = deps.idleMs ?? SFTP_BROWSE_IDLE_MS;
    this.randomId = deps.randomId ?? randomUUID;
  }

  // Sessions.

  /**
   * The window's session on the server, opened now unless it already owns one. With `peers` (the
   * windows linked to this one, itself included or not), a session a peer has on the server is
   * joined instead of opening a second one.
   */
  open(
    ownerId: number,
    serverId: string,
    options: { peers?: readonly number[] } = {},
  ): Promise<SftpSessionInfo> {
    for (const session of this.sessions.values()) {
      if (session.owners.has(ownerId) && session.info.serverId === serverId) {
        return Promise.resolve(session.info);
      }
    }
    const peers = new Set(options.peers);
    for (const session of this.sessions.values()) {
      if (session.info.serverId !== serverId) continue;
      if (![...session.owners].some((owner) => peers.has(owner))) continue;
      session.owners.add(ownerId);
      return Promise.resolve(session.info);
    }
    const key = `${ownerId}\n${serverId}`;
    const existing = this.pending.get(key)?.promise;
    if (existing) return existing;
    const pending: PendingOpen = { ownerId, serverId, cancelled: false, promise: null };
    this.pending.set(key, pending);
    const promise = this.start(pending).finally(() => {
      if (this.pending.get(key) === pending) this.pending.delete(key);
    });
    pending.promise = promise;
    return promise;
  }

  private async start(pending: PendingOpen): Promise<SftpSessionInfo> {
    const { ownerId, serverId } = pending;
    const server = await this.deps.findServer(serverId);
    if (!server) throw serverGone();
    let lease: ClientLease;
    try {
      lease = await this.deps.pool.acquire(serverId);
    } catch (error) {
      throw connectError(error);
    }
    let home: string;
    try {
      if (pending.cancelled) throw closedWhileOpening();
      home = await lease.client.sftpRealpath('.');
      if (pending.cancelled) throw closedWhileOpening();
      // The server may have been removed while this logged in; its sessions are already closed.
      if (!(await this.deps.findServer(serverId))) throw serverGone();
      // And the window may have gone during that last look.
      if (pending.cancelled) throw closedWhileOpening();
    } catch (error) {
      lease.release();
      throw toCodedError(error, 'the home folder');
    }

    const sessionId = this.randomId();
    const info: SftpSessionInfo = {
      sessionId,
      serverId,
      nickname: server.nickname,
      host: server.host,
      port: server.port,
      username: server.username,
      home,
    };
    // The engine only calls back once it has work, by when `session` below is set.
    const engine = createTransferEngine({
      ...this.deps.engine,
      sessionId,
      transferClient: async () => {
        const separate = await this.deps.pool.openSeparate(serverId);
        session.transferLease?.release();
        session.transferLease = separate;
        return separate.client;
      },
      releaseTransferClient: () => {
        session.transferLease?.release();
        session.transferLease = null;
      },
      emit: (snapshot) => this.sendAll(session, IPC.sftp.onQueue, snapshot),
      finished: (event) => this.sendAll(session, IPC.sftp.onBatchFinished, event),
      busy: (running) => {
        session.busy = running;
        this.updateAwake();
      },
    });
    const session: Session = {
      info,
      owners: new Set([ownerId]),
      engine,
      lease,
      leasing: null,
      transferLease: null,
      ops: 0,
      idleTimer: null,
      busy: false,
      closed: false,
    };
    this.sessions.set(sessionId, session);
    this.armIdle(session);
    return info;
  }

  /**
   * Ends the session for every owner (Disconnect, from any view of it). The other owners are told
   * with reason `disconnected`; the caller asked for it. A session that is already gone is fine.
   */
  async close(ownerId: number, sessionId: string): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session) return;
    if (!session.owners.has(ownerId)) throw unknownSession();
    const event: SftpSessionClosed = {
      sessionId,
      serverId: session.info.serverId,
      reason: 'disconnected',
    };
    for (const other of session.owners) {
      if (other !== ownerId) this.deps.send(other, IPC.sftp.onSessionClosed, event);
    }
    await this.dispose(session);
  }

  /** The session as `open` answered it, for a window that owns it. */
  info(ownerId: number, sessionId: string): SftpSessionInfo {
    return this.own(ownerId, sessionId).info;
  }

  /** Lets another window into the session (the pop-out): it may use it and hears its events. */
  addOwner(sessionId: string, ownerId: number): void {
    const session = this.sessions.get(sessionId);
    if (!session) throw unknownSession();
    session.owners.add(ownerId);
  }

  /**
   * Makes `toOwner` an owner of every session `fromOwner` has, for a pop-out about to close: its
   * sessions carry on, transfers included, and `toOwner` is sent `onSessionAdopted` for each so
   * its page shows it. Linked windows share one session per server (`open` with `peers`), so
   * `toOwner` should have none of its own on those servers. Should it have one anyway, its own
   * stays the one `open` answers: an idle session of `fromOwner` there is left to end, and a
   * busy one is kept quietly so nothing running is lost.
   */
  adoptSessions(fromOwner: number, toOwner: number): void {
    const served = new Set<string>();
    for (const session of this.sessions.values()) {
      if (session.owners.has(toOwner)) served.add(session.info.serverId);
    }
    for (const session of this.sessions.values()) {
      if (!session.owners.has(fromOwner) || session.owners.has(toOwner)) continue;
      if (served.has(session.info.serverId)) {
        if (session.engine.activeCount() > 0) session.owners.add(toOwner);
        continue;
      }
      session.owners.add(toOwner);
      served.add(session.info.serverId);
      this.deps.send(toOwner, IPC.sftp.onSessionAdopted, session.info);
    }
  }

  /**
   * Takes a window out of the session without telling anyone, and ends the session when it was
   * the last owner. A session that is already gone, or a window that was not in it, is fine.
   */
  async removeOwner(sessionId: string, ownerId: number): Promise<void> {
    const session = this.sessions.get(sessionId);
    if (!session?.owners.delete(ownerId)) return;
    if (session.owners.size === 0) await this.dispose(session);
  }

  /**
   * Takes a window that has gone out of every session it owned, ending those it was the last
   * owner of, and drops what it was still opening. Nobody is told.
   */
  async dropOwner(ownerId: number): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.ownerId === ownerId) pending.cancelled = true;
    }
    const mine = [...this.sessions.values()].filter((session) => session.owners.has(ownerId));
    await Promise.all(mine.map((session) => this.removeOwner(session.info.sessionId, ownerId)));
  }

  /** Ends every session on the server and tells each window why. */
  async closeServer(serverId: string, reason: SftpSessionClosed['reason']): Promise<void> {
    for (const pending of this.pending.values()) {
      if (pending.serverId === serverId) pending.cancelled = true;
    }
    const matching = [...this.sessions.values()].filter(
      (session) => session.info.serverId === serverId,
    );
    await Promise.all(matching.map((session) => this.closeWithEvent(session, reason)));
  }

  /** Ends every session, at quit. */
  async closeAll(): Promise<void> {
    for (const pending of this.pending.values()) pending.cancelled = true;
    await Promise.all(
      [...this.sessions.values()].map((session) => this.closeWithEvent(session, 'quit')),
    );
  }

  /** Batches not over yet, across every session. */
  runningTransfers(): number {
    let count = 0;
    for (const session of this.sessions.values()) count += session.engine.activeCount();
    return count;
  }

  private closeWithEvent(session: Session, reason: SftpSessionClosed['reason']): Promise<void> {
    const event: SftpSessionClosed = {
      sessionId: session.info.sessionId,
      serverId: session.info.serverId,
      reason,
    };
    this.sendAll(session, IPC.sftp.onSessionClosed, event);
    return this.dispose(session);
  }

  private sendAll(session: Session, channel: string, payload: unknown): void {
    for (const ownerId of session.owners) this.deps.send(ownerId, channel, payload);
  }

  private async dispose(session: Session): Promise<void> {
    if (session.closed) return;
    session.closed = true;
    this.sessions.delete(session.info.sessionId);
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    session.lease?.release();
    session.lease = null;
    await session.engine.dispose();
    session.busy = false;
    this.updateAwake();
  }

  private own(ownerId: number, sessionId: string): Session {
    const session = this.sessions.get(sessionId);
    if (!session?.owners.has(ownerId)) throw unknownSession();
    return session;
  }

  private updateAwake(): void {
    const busy = [...this.sessions.values()].some((session) => session.busy);
    if (busy === this.awake) return;
    this.awake = busy;
    this.deps.keepAwake(busy);
  }

  // The browse connection.

  private async browseClient(session: Session): Promise<SftpFileClient> {
    if (session.lease?.client.isOpen) return session.lease.client;
    session.lease?.release();
    session.lease = null;
    if (!session.leasing) {
      session.leasing = this.deps.pool
        .acquire(session.info.serverId)
        .catch((error: unknown) => {
          throw connectError(error);
        })
        .then((lease) => {
          if (session.closed) {
            lease.release();
            throw unknownSession();
          }
          session.lease = lease;
          return lease;
        })
        .finally(() => {
          session.leasing = null;
        });
    }
    return (await session.leasing).client;
  }

  /**
   * Runs `work` on the browse connection and codes its failure about `path`. When the connection
   * dropped, the dead lease goes so the next call logs in again, and a `read` is tried once more
   * on a fresh one. A `change` is not: it may have happened with only the answer lost, and doing
   * it again would report `exists` or `changedOnServer` for a change that was made. It fails
   * with `unreachable` instead.
   */
  private async withBrowse<T>(
    session: Session,
    path: string,
    kind: 'read' | 'change',
    work: (client: SftpFileClient) => Promise<T>,
  ): Promise<T> {
    session.ops += 1;
    if (session.idleTimer) clearTimeout(session.idleTimer);
    session.idleTimer = null;
    try {
      const client = await this.browseClient(session);
      try {
        return await work(client);
      } catch (error) {
        if (!isDropped(client, error)) throw error;
        if (session.lease?.client === client) {
          session.lease.release();
          session.lease = null;
        }
        if (kind === 'change') {
          throw filesError(
            'unreachable',
            `The connection dropped while working on ${path}. Look whether the change was made before trying again.`,
          );
        }
        return await work(await this.browseClient(session));
      }
    } catch (error) {
      throw toCodedError(error, path);
    } finally {
      session.ops -= 1;
      this.armIdle(session);
    }
  }

  private armIdle(session: Session): void {
    if (session.closed || session.ops > 0 || session.idleTimer) return;
    session.idleTimer = setTimeout(() => {
      session.idleTimer = null;
      if (session.closed || session.ops > 0) return;
      // Transfers still going keep the session's view of the server warm.
      if (session.engine.activeCount() > 0) {
        this.armIdle(session);
        return;
      }
      session.lease?.release();
      session.lease = null;
    }, this.idleMs);
  }

  // Browsing and changes.

  /** A remote folder; `input` may be absolute, `~`, `~/x` or relative to home. */
  async list(
    ownerId: number,
    sessionId: string,
    input: string,
  ): Promise<SftpListing<SftpRemoteEntry>> {
    const session = this.own(ownerId, sessionId);
    const { home } = session.info;
    const path = resolveRemoteInput(input, home, home);
    const entries = await this.withBrowse(session, path, 'read', async (client) => {
      try {
        return await client.sftpListDetailed(path);
      } catch (error) {
        if (isDropped(client, error)) throw error;
        // Listing a file fails like a missing folder would; say which it was.
        const info = await client.sftpStat(path).catch(() => null);
        if (info && !info.isDirectory) {
          throw filesError('invalidInput', `${path} is a file, not a folder.`);
        }
        throw error;
      }
    });
    return {
      path,
      parent: parentOf(path),
      entries: entries.map((entry) => toRemoteEntry(path, entry)),
    };
  }

  /**
   * One entry as its folder lists it (owner and group included), or null when nothing is there.
   * When the folder cannot be listed, a stat still answers, without owner and group.
   */
  async stat(ownerId: number, sessionId: string, rawPath: string): Promise<SftpRemoteEntry | null> {
    const session = this.own(ownerId, sessionId);
    const path = assertRemoteAbsolute(rawPath);
    return this.withBrowse(session, path, 'read', async (client) => {
      let entry: SftpDetailedEntry | null;
      try {
        entry = await remoteEntryOf(client, path);
      } catch (error) {
        if (isDropped(client, error)) throw error;
        const info = await client.sftpStat(path);
        if (!info) return null;
        entry = {
          name: baseName(path),
          ...info,
          isSymlink: false,
          brokenLink: false,
          longname: '',
        };
      }
      if (!entry) return null;
      return { ...toRemoteEntry(parentOf(path) ?? '/', entry), name: entry.name, path };
    });
  }

  /** Makes `name` in `parentDir` and answers its path; `exists` when the name is taken. */
  async mkdir(
    ownerId: number,
    sessionId: string,
    parentDir: string,
    name: string,
  ): Promise<string> {
    const session = this.own(ownerId, sessionId);
    assertName(name);
    const path = joinRemote(assertRemoteAbsolute(parentDir), name);
    return this.withBrowse(session, path, 'change', async (client) => {
      // SFTP answers a plain failure for a name that is taken, so look first (and after).
      if (await isTaken(client, path)) throw taken(path);
      try {
        await client.sftpMkdir(path);
      } catch (error) {
        if (!isDropped(client, error) && (await isTaken(client, path))) throw taken(path);
        throw error;
      }
      return path;
    });
  }

  /** Renames in place and answers the new path; `exists` when the new name is taken. */
  async rename(
    ownerId: number,
    sessionId: string,
    rawPath: string,
    newName: string,
  ): Promise<string> {
    const session = this.own(ownerId, sessionId);
    assertName(newName);
    const source = assertRemoteAbsolute(rawPath);
    const folder = parentOf(source);
    if (folder === null) throw filesError('invalidInput', 'The root folder cannot be renamed.');
    const target = joinRemote(folder, newName);
    if (target === source) return target;
    return this.withBrowse(session, source, 'change', async (client) => {
      // A plain SFTP rename fails onto a taken name, but only with a generic failure.
      if (await isTaken(client, target)) throw taken(target);
      try {
        await client.sftpRename(source, target);
      } catch (error) {
        if (!isDropped(client, error) && (await isTaken(client, target))) throw taken(target);
        throw error;
      }
      return target;
    });
  }

  /** Queues a delete of the paths, folders with everything inside. */
  async remove(ownerId: number, sessionId: string, paths: string[]): Promise<SftpBatchRef> {
    const session = this.own(ownerId, sessionId);
    return {
      batchId: session.engine.enqueueDelete(paths.map((path) => assertRemoteAbsolute(path))),
    };
  }

  async chmod(ownerId: number, sessionId: string, input: SftpChmodInput): Promise<SftpBatchRef> {
    const session = this.own(ownerId, sessionId);
    const paths = input.paths.map((path) => assertRemoteAbsolute(path));
    return { batchId: session.engine.enqueueChmod({ ...input, paths }) };
  }

  /** Queues an upload. Sources may be anywhere on this computer (the OS can drop any file). */
  async upload(ownerId: number, sessionId: string, input: SftpUploadInput): Promise<SftpBatchRef> {
    const session = this.own(ownerId, sessionId);
    const remoteDir = assertRemoteAbsolute(input.remoteDir);
    return { batchId: session.engine.enqueueUpload({ ...input, remoteDir }) };
  }

  /** Queues a download into a folder the window's local pane listed (D13). */
  async download(
    ownerId: number,
    sessionId: string,
    input: SftpDownloadInput,
  ): Promise<SftpBatchRef> {
    const session = this.own(ownerId, sessionId);
    const remotePaths = input.remotePaths.map((path) => assertRemoteAbsolute(path));
    const localDir = await this.deps.localBrowse.assertWritable(ownerId, input.localDir);
    // The session may have closed while the folder was checked.
    const current = this.own(ownerId, sessionId);
    if (current !== session) throw unknownSession();
    return { batchId: session.engine.enqueueDownload({ ...input, remotePaths, localDir }) };
  }

  // The queue.

  async resolveConflict(
    ownerId: number,
    sessionId: string,
    conflictId: string,
    decision: SftpConflictDecision,
  ): Promise<void> {
    this.own(ownerId, sessionId).engine.resolveConflict(conflictId, decision);
  }

  async cancel(ownerId: number, sessionId: string, target?: SftpTarget): Promise<void> {
    this.own(ownerId, sessionId).engine.cancel(target);
  }

  async retry(ownerId: number, sessionId: string, target?: SftpTarget): Promise<void> {
    this.own(ownerId, sessionId).engine.retry(target);
  }

  async clearFinished(ownerId: number, sessionId: string): Promise<void> {
    this.own(ownerId, sessionId).engine.clearFinished();
  }

  async queue(ownerId: number, sessionId: string): Promise<SftpQueueSnapshot> {
    return this.own(ownerId, sessionId).engine.snapshot();
  }

  // The remote editor.

  async readText(ownerId: number, sessionId: string, rawPath: string): Promise<SftpTextFile> {
    const session = this.own(ownerId, sessionId);
    const path = assertRemoteAbsolute(rawPath);
    return this.withBrowse(session, path, 'read', (client) => readText(client, path));
  }

  /** Saves the editor's text and answers the entry, owner and group read back when the folder lists. */
  async writeText(
    ownerId: number,
    sessionId: string,
    input: SftpWriteTextInput,
  ): Promise<SftpRemoteEntry> {
    const session = this.own(ownerId, sessionId);
    const path = assertRemoteAbsolute(input.path);
    return this.withBrowse(session, path, 'change', async (client) => {
      const saved = await writeText(client, { ...input, path }, this.deps.tempDir());
      const listed = await remoteEntryOf(client, path).catch(() => null);
      if (!listed) return saved;
      return { ...saved, ...parseLongname(listed.longname) };
    });
  }
}

function serverGone(): Error {
  return filesError('siteUnknown', 'This saved server no longer exists.');
}

function taken(path: string): Error {
  return filesError('exists', `${path} is already there.`);
}

/**
 * Whether something is at `path`, a broken link included. A folder that cannot be listed counts
 * as free, so the change itself decides; only a dropped connection is passed on.
 */
async function isTaken(client: SftpFileClient, path: string): Promise<boolean> {
  try {
    return (await remoteEntryOf(client, path)) !== null;
  } catch (error) {
    if (isDropped(client, error)) throw error;
    return false;
  }
}
