import { createHash, type Hash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync } from 'node:fs';
import { type FileHandle, mkdir, open, rename, rm, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { app } from 'electron';
import { WebSocket } from 'ws';
import type {
  RemoteFileDirection,
  RemoteFileProgress,
  RemoteLogLevel,
} from '../../shared/apiTypes';
import {
  BIN_FILE_CHUNK,
  decodeFileChunk,
  encodeFileChunk,
  FILE_CHUNK_BYTES,
  type FileChunk,
  formatBytes,
  PART_BYTES,
  type RemoteControlMessage,
  transferKeyFromId,
} from '../../shared/remoteProtocol';

/** A part is retried this many times (hash mismatch or ack timeout) before the whole transfer is failed. */
const MAX_PART_RETRIES = 5;
/** How long we wait for a `file-part-ack` before treating it as a timeout and retrying the part. */
const PART_ACK_TIMEOUT_MS = 30_000;
/** Transfers stuck `awaiting-reconnect` longer than this are abandoned and their temp files cleaned up. */
const RECONNECT_ABANDON_MS = 5 * 60 * 1000;

export type TransferStatus = 'active' | 'awaiting-reconnect' | 'done' | 'error' | 'cancelled';

interface UploadState {
  direction: 'upload';
  transferId: string;
  transferKey: number;
  name: string;
  size: number;
  partSize: number;
  partCount: number;
  filePath: string;
  ws: WebSocket | null;
  status: TransferStatus;
  lastActivityAt: number;
  completedParts: Set<number>;
  wholeHash: Hash;
  pendingPart: { partIndex: number; hash: string; buffered: Buffer[] } | null;
  retries: number;
  ackTimer: NodeJS.Timeout | null;
  error?: string;
}

interface DownloadState {
  direction: 'download';
  transferId: string;
  transferKey: number;
  name: string;
  size: number;
  partSize: number;
  partCount: number;
  destDir?: string;
  tmpPath: string;
  /** Final path the file was renamed to once verified (set on completion). */
  savedPath?: string;
  fh: FileHandle;
  ws: WebSocket | null;
  status: TransferStatus;
  lastActivityAt: number;
  completedParts: Set<number>;
  currentPartIndex: number | null;
  partHash: Hash | null;
  partBytesReceived: number;
  error?: string;
}

type TransferState = UploadState | DownloadState;

export interface FileTransferCallbacks {
  sendControl(ws: WebSocket, msg: RemoteControlMessage): void;
  sendBinary(ws: WebSocket, data: Uint8Array): Promise<void>;
  log(level: RemoteLogLevel, message: string): void;
  emitProgress(progress: RemoteFileProgress): void;
}

/**
 * Resumable, hash-verified file transfer over the remote-control WebSocket.
 *
 * Files are split into fixed-size parts (`PART_BYTES`, 10MB). Each part is
 * streamed as 64KB `BIN_FILE_CHUNK` frames, independently SHA-256 hashed and
 * acked before the next part starts (stop-and-wait, see protocol comment on
 * `file-offer`), so a dropped connection or a corrupted part only costs a
 * resend of that one part, never the whole file. The whole file is verified
 * again at the end: the receiver re-reads the fully assembled temp file in
 * one pass and compares its SHA-256 against the sender's, which is the only
 * way to catch a bug anywhere in the part-by-part pipeline without trusting
 * that the parts summed to the same bytes the sender started with.
 *
 * State is keyed by `transferId`, not by connection, on purpose: when the
 * dialing side (always the controller, since the host never dials) reconnects
 * after a drop, it re-sends the message that drives its role in the
 * transfer (`file-offer` if it's the sender, `file-resume` if it's the
 * receiver) for the *same* `transferId`. Both handlers below recognize an
 * existing transfer by that id and just rebind `ws`/resume, instead of
 * starting over. That's the entire resume mechanism.
 */
export class FileTransferManager {
  private readonly transfers = new Map<string, TransferState>();
  private readonly byKey = new Map<number, string>();
  private sweepTimer: NodeJS.Timeout | null = null;

  constructor(private readonly callbacks: FileTransferCallbacks) {}

  hasActiveTransfers(): boolean {
    for (const t of this.transfers.values()) {
      if (t.status === 'active' || t.status === 'awaiting-reconnect') return true;
    }
    return false;
  }

  /** Snapshot of all transfers, for the initial state pushed to a newly-opened renderer window. */
  listProgress(): RemoteFileProgress[] {
    return [...this.transfers.values()].map((t) => this.progressFor(t));
  }

  // --- Sending -------------------------------------------------------------

  async startUpload(ws: WebSocket, filePath: string, destDir?: string): Promise<void> {
    const info = await stat(filePath);
    const name = basename(filePath);
    const transferId = this.freshTransferId();
    const partCount = Math.max(1, Math.ceil(info.size / PART_BYTES));
    const state: UploadState = {
      direction: 'upload',
      transferId,
      transferKey: transferKeyFromId(transferId),
      name,
      size: info.size,
      partSize: PART_BYTES,
      partCount,
      filePath,
      ws,
      status: 'active',
      lastActivityAt: Date.now(),
      completedParts: new Set(),
      wholeHash: createHash('sha256'),
      pendingPart: null,
      retries: 0,
      ackTimer: null,
    };
    this.transfers.set(transferId, state);
    this.byKey.set(state.transferKey, transferId);
    this.callbacks.sendControl(ws, {
      t: 'file-offer',
      transferId,
      name,
      size: info.size,
      partSize: PART_BYTES,
      partCount,
      destDir,
    });
    this.callbacks.log('info', `Sending "${name}" (${formatBytes(info.size)})…`);
    this.emit(state);
    this.ensureSweep();
  }

  /** Peer asked us to push a file from our own filesystem (the download half of the remote file manager). */
  async handleFileRequest(
    ws: WebSocket,
    msg: Extract<RemoteControlMessage, { t: 'file-request' }>,
  ): Promise<void> {
    try {
      const info = await stat(msg.path);
      if (!info.isFile()) throw new Error('Not a file.');
      this.callbacks.sendControl(ws, { t: 'file-request-ack', reqId: msg.reqId, ok: true });
      await this.startUpload(ws, msg.path);
    } catch (err) {
      this.callbacks.sendControl(ws, {
        t: 'file-request-ack',
        reqId: msg.reqId,
        ok: false,
        error: (err as Error).message,
      });
    }
  }

  private async sendPart(state: UploadState, partIndex: number): Promise<void> {
    if (state.ws?.readyState !== WebSocket.OPEN) return; // will resume once reconnected
    const start = partIndex * state.partSize;
    const end = Math.min(state.size, start + state.partSize) - 1;
    const partHash = createHash('sha256');
    const buffered: Buffer[] = [];
    let seq = 0;
    try {
      const stream = createReadStream(state.filePath, {
        start,
        end,
        highWaterMark: FILE_CHUNK_BYTES,
      });
      for await (const chunkUnknown of stream) {
        const bytes = chunkUnknown as Buffer;
        partHash.update(bytes);
        buffered.push(bytes);
        await this.callbacks.sendBinary(
          state.ws,
          encodeFileChunk({ transferKey: state.transferKey, partIndex, seq: seq++, bytes }),
        );
        state.lastActivityAt = Date.now();
        this.emit(
          state,
          partIndex,
          buffered.reduce((n, b) => n + b.byteLength, 0),
        );
      }
      const hash = partHash.digest('hex');
      state.pendingPart = { partIndex, hash, buffered };
      this.callbacks.sendControl(state.ws, {
        t: 'file-part-done',
        transferId: state.transferId,
        partIndex,
        hash,
        size: end - start + 1,
      });
      this.armAckTimeout(state, partIndex);
    } catch (err) {
      this.failUpload(state, (err as Error).message);
    }
  }

  private armAckTimeout(state: UploadState, partIndex: number): void {
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.ackTimer = setTimeout(() => {
      if (state.pendingPart?.partIndex !== partIndex || state.status !== 'active') return;
      this.retryOrFail(state, partIndex);
    }, PART_ACK_TIMEOUT_MS);
  }

  private handlePartAck(
    state: UploadState,
    msg: Extract<RemoteControlMessage, { t: 'file-part-ack' }>,
  ): void {
    if (state.pendingPart?.partIndex !== msg.partIndex) return; // stale ack, ignore
    if (state.ackTimer) clearTimeout(state.ackTimer);
    state.lastActivityAt = Date.now();
    if (!msg.ok) {
      this.retryOrFail(state, msg.partIndex);
      return;
    }
    for (const bytes of state.pendingPart.buffered) state.wholeHash.update(bytes);
    state.completedParts.add(msg.partIndex);
    state.pendingPart = null;
    state.retries = 0;
    this.emit(state);
    const next = this.nextMissingPart(state);
    if (next === null) {
      if (state.ws) {
        this.callbacks.sendControl(state.ws, {
          t: 'file-complete',
          transferId: state.transferId,
          hash: state.wholeHash.digest('hex'),
        });
      }
      return;
    }
    void this.sendPart(state, next);
  }

  private retryOrFail(state: UploadState, partIndex: number): void {
    state.pendingPart = null;
    state.retries++;
    if (state.retries > MAX_PART_RETRIES) {
      this.failUpload(state, `Part ${partIndex + 1}/${state.partCount} failed too many times.`);
      return;
    }
    void this.sendPart(state, partIndex);
  }

  private failUpload(state: UploadState, message: string): void {
    state.status = 'error';
    state.error = message;
    if (state.ackTimer) clearTimeout(state.ackTimer);
    this.callbacks.log('error', `Failed to send "${state.name}": ${message}`);
    if (state.ws)
      this.callbacks.sendControl(state.ws, {
        t: 'file-error',
        transferId: state.transferId,
        message,
      });
    this.emit(state);
    this.forget(state);
  }

  private handleFileDone(
    state: UploadState,
    msg: Extract<RemoteControlMessage, { t: 'file-done' }>,
  ): void {
    state.status = msg.verified ? 'done' : 'error';
    if (!msg.verified) state.error = 'Receiver could not verify the whole-file hash.';
    this.callbacks.log(
      msg.verified ? 'success' : 'error',
      msg.verified
        ? `Sent "${state.name}".`
        : `Sent "${state.name}" but the receiver's hash check failed.`,
    );
    this.emit(state);
    this.forget(state);
  }

  // --- Receiving -------------------------------------------------------------

  private async handleFileOffer(
    ws: WebSocket,
    msg: Extract<RemoteControlMessage, { t: 'file-offer' }>,
  ): Promise<void> {
    let state = this.transfers.get(msg.transferId) as DownloadState | undefined;
    if (state) {
      // Rebind after a reconnect: keep the temp file and completed parts, just point at the new socket.
      state.ws = ws;
      state.status = 'active';
      state.lastActivityAt = Date.now();
      this.emit(state);
    } else {
      const destDir =
        msg.destDir && existsSync(msg.destDir) ? msg.destDir : app.getPath('downloads');
      await mkdir(destDir, { recursive: true });
      const tmpDir = join(app.getPath('downloads'), '.runova-tmp');
      await mkdir(tmpDir, { recursive: true });
      const tmpPath = join(tmpDir, `${msg.transferId}.part`);
      const fh = await open(tmpPath, 'w+');
      await fh.truncate(msg.size);
      state = {
        direction: 'download',
        transferId: msg.transferId,
        transferKey: transferKeyFromId(msg.transferId),
        name: msg.name,
        size: msg.size,
        partSize: msg.partSize,
        partCount: msg.partCount,
        destDir,
        tmpPath,
        fh,
        ws,
        status: 'active',
        lastActivityAt: Date.now(),
        completedParts: new Set(),
        currentPartIndex: null,
        partHash: null,
        partBytesReceived: 0,
      };
      this.transfers.set(state.transferId, state);
      this.byKey.set(state.transferKey, state.transferId);
      this.callbacks.log('info', `Receiving "${msg.name}" (${formatBytes(msg.size)})…`);
      this.emit(state);
      this.ensureSweep();
    }
    this.callbacks.sendControl(ws, {
      t: 'file-resume',
      transferId: state.transferId,
      missingParts: this.missingPartsOf(state),
    });
  }

  /** We're the sender for this transfer; the peer told us which parts it still needs. */
  private handleFileResume(
    state: UploadState,
    ws: WebSocket,
    msg: Extract<RemoteControlMessage, { t: 'file-resume' }>,
  ): void {
    state.ws = ws;
    state.status = 'active';
    state.lastActivityAt = Date.now();
    state.pendingPart = null;
    if (state.ackTimer) clearTimeout(state.ackTimer);
    for (let i = 0; i < state.partCount; i++) {
      if (!msg.missingParts.includes(i)) state.completedParts.add(i);
    }
    this.emit(state);
    const next = msg.missingParts[0] ?? this.nextMissingPart(state);
    if (next == null) return;
    void this.sendPart(state, next);
  }

  private async handlePartData(state: DownloadState, chunk: FileChunk): Promise<void> {
    if (chunk.seq === 0) {
      state.currentPartIndex = chunk.partIndex;
      state.partHash = createHash('sha256');
      state.partBytesReceived = 0;
    }
    if (state.currentPartIndex !== chunk.partIndex || !state.partHash) return; // stray/late frame
    const offset = chunk.partIndex * state.partSize + state.partBytesReceived;
    await state.fh.write(chunk.bytes, 0, chunk.bytes.byteLength, offset);
    state.partHash.update(chunk.bytes);
    state.partBytesReceived += chunk.bytes.byteLength;
    state.lastActivityAt = Date.now();
    this.emit(state, chunk.partIndex, state.partBytesReceived);
  }

  private handlePartDone(
    state: DownloadState,
    msg: Extract<RemoteControlMessage, { t: 'file-part-done' }>,
  ): void {
    const ok =
      state.currentPartIndex === msg.partIndex &&
      !!state.partHash &&
      state.partHash.digest('hex') === msg.hash;
    if (state.ws) {
      this.callbacks.sendControl(state.ws, {
        t: 'file-part-ack',
        transferId: state.transferId,
        partIndex: msg.partIndex,
        ok,
      });
    }
    if (ok) {
      state.completedParts.add(msg.partIndex);
      state.partHash = null;
      this.emit(state);
    }
    // On failure the sender will resend the same part from seq 0, which naturally resets our accumulator above.
  }

  private async handleFileComplete(
    state: DownloadState,
    msg: Extract<RemoteControlMessage, { t: 'file-complete' }>,
  ): Promise<void> {
    const actual = await hashFile(state.tmpPath);
    const verified = actual === msg.hash;
    const savedPath = verified
      ? uniquePath(join(state.destDir ?? app.getPath('downloads'), sanitizeName(state.name)))
      : state.tmpPath;
    try {
      await state.fh.close();
      if (verified) await rename(state.tmpPath, savedPath);
    } catch (err) {
      this.callbacks.log('error', `Failed to finalize "${state.name}": ${(err as Error).message}`);
    }
    state.status = verified ? 'done' : 'error';
    if (verified) state.savedPath = savedPath;
    else state.error = "Whole-file hash didn't match after reassembly.";
    if (state.ws) {
      this.callbacks.sendControl(state.ws, {
        t: 'file-done',
        transferId: state.transferId,
        savedPath,
        verified,
      });
    }
    this.callbacks.log(
      verified ? 'success' : 'error',
      verified
        ? `Saved "${state.name}" to ${savedPath}.`
        : `Saved "${state.name}" but its hash didn't verify.`,
    );
    this.emit(state);
    this.forget(state);
  }

  // --- Dispatch ----------------------------------------------------------------

  /** Route a control-plane message into whichever transfer it belongs to. Returns false if this message isn't ours. */
  handleControl(ws: WebSocket, msg: RemoteControlMessage): boolean {
    switch (msg.t) {
      case 'file-offer':
        void this.handleFileOffer(ws, msg);
        return true;
      case 'file-resume': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'upload') this.handleFileResume(state, ws, msg);
        return true;
      }
      case 'file-part-done': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'download') this.handlePartDone(state, msg);
        return true;
      }
      case 'file-part-ack': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'upload') this.handlePartAck(state, msg);
        return true;
      }
      case 'file-complete': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'download') void this.handleFileComplete(state, msg);
        return true;
      }
      case 'file-done': {
        const state = this.transfers.get(msg.transferId);
        if (state?.direction === 'upload') this.handleFileDone(state, msg);
        return true;
      }
      case 'file-error': {
        const state = this.transfers.get(msg.transferId);
        if (state) this.cancel(state, msg.message);
        return true;
      }
      case 'file-cancel': {
        const state = this.transfers.get(msg.transferId);
        if (state) this.cancel(state, 'Cancelled by peer.');
        return true;
      }
      case 'file-request':
        void this.handleFileRequest(ws, msg);
        return true;
      default:
        return false;
    }
  }

  handleBinary(buf: Uint8Array): boolean {
    if (buf[0] !== BIN_FILE_CHUNK) return false;
    const chunk = decodeFileChunk(buf);
    const transferId = this.byKey.get(chunk.transferKey);
    const state = transferId ? this.transfers.get(transferId) : undefined;
    if (state?.direction === 'download') void this.handlePartData(state, chunk);
    return true;
  }

  // --- Reconnect lifecycle -------------------------------------------------

  /** Connection to `ws` was lost; mark any transfer using it as awaiting-reconnect instead of tearing it down. */
  onConnectionLost(ws: WebSocket): void {
    for (const state of this.transfers.values()) {
      if (state.ws !== ws) continue;
      state.ws = null;
      if (state.status === 'active') {
        state.status = 'awaiting-reconnect';
        this.emit(state);
      }
      if (state.direction === 'upload' && state.ackTimer) {
        clearTimeout(state.ackTimer);
        state.ackTimer = null;
      }
    }
  }

  /** The dialing side reconnected; re-drive whichever message resumes our role in each pending transfer. */
  resumeAfterReconnect(ws: WebSocket): void {
    for (const state of this.transfers.values()) {
      if (state.status !== 'awaiting-reconnect') continue;
      state.ws = ws;
      state.status = 'active';
      state.lastActivityAt = Date.now();
      if (state.direction === 'upload') {
        this.callbacks.sendControl(ws, {
          t: 'file-offer',
          transferId: state.transferId,
          name: state.name,
          size: state.size,
          partSize: state.partSize,
          partCount: state.partCount,
        });
      } else {
        this.callbacks.sendControl(ws, {
          t: 'file-resume',
          transferId: state.transferId,
          missingParts: this.missingPartsOf(state),
        });
      }
      this.emit(state);
    }
  }

  /** User explicitly disconnected, so cancel everything cleanly rather than waiting to see if it reconnects. */
  cancelAll(reason: string): void {
    for (const state of [...this.transfers.values()]) this.cancel(state, reason);
  }

  private cancel(state: TransferState, reason: string): void {
    if (state.status === 'done') return;
    state.status = 'cancelled';
    state.error = reason;
    if (state.direction === 'upload' && state.ackTimer) clearTimeout(state.ackTimer);
    this.emit(state);
    this.forget(state);
  }

  private ensureSweep(): void {
    if (this.sweepTimer) return;
    this.sweepTimer = setInterval(() => this.sweepAbandoned(), 30_000);
  }

  private sweepAbandoned(): void {
    const now = Date.now();
    for (const state of [...this.transfers.values()]) {
      if (
        state.status === 'awaiting-reconnect' &&
        now - state.lastActivityAt > RECONNECT_ABANDON_MS
      ) {
        this.cancel(state, 'Gave up waiting for the connection to resume.');
      }
    }
    if (this.transfers.size === 0 && this.sweepTimer) {
      clearInterval(this.sweepTimer);
      this.sweepTimer = null;
    }
  }

  // --- Helpers ---------------------------------------------------------------

  private missingPartsOf(state: TransferState): number[] {
    const missing: number[] = [];
    for (let i = 0; i < state.partCount; i++) if (!state.completedParts.has(i)) missing.push(i);
    return missing;
  }

  private nextMissingPart(state: TransferState): number | null {
    for (let i = 0; i < state.partCount; i++) if (!state.completedParts.has(i)) return i;
    return null;
  }

  private freshTransferId(): string {
    for (;;) {
      const id = randomUUID();
      if (!this.byKey.has(transferKeyFromId(id))) return id;
    }
  }

  private forget(state: TransferState): void {
    setTimeout(() => {
      this.transfers.delete(state.transferId);
      this.byKey.delete(state.transferKey);
      if (state.direction === 'download' && state.status !== 'done' && existsSync(state.tmpPath)) {
        void rm(state.tmpPath, { force: true });
      }
    }, 5_000); // brief grace period so a last progress event still finds the state if in flight
  }

  private progressFor(
    state: TransferState,
    partIndexInFlight?: number,
    bytesInFlight?: number,
  ): RemoteFileProgress {
    const direction: RemoteFileDirection = state.direction === 'upload' ? 'outgoing' : 'incoming';
    const transferred =
      state.completedParts.size * state.partSize +
      (partIndexInFlight !== undefined && !state.completedParts.has(partIndexInFlight)
        ? (bytesInFlight ?? 0)
        : 0);
    return {
      transferId: state.transferId,
      name: state.name,
      direction,
      transferred: Math.min(transferred, state.size),
      total: state.size,
      done: state.status === 'done' || state.status === 'error' || state.status === 'cancelled',
      error: state.status === 'error' || state.status === 'cancelled' ? state.error : undefined,
      savedPath: state.direction === 'download' ? state.savedPath : undefined,
      partsTotal: state.partCount,
      partsCompleted: state.completedParts.size,
      verified: state.status === 'done' ? true : state.status === 'error' ? false : undefined,
      resuming: state.status === 'awaiting-reconnect',
      currentPartRetry: state.direction === 'upload' ? state.retries : undefined,
    };
  }

  private emit(state: TransferState, partIndexInFlight?: number, bytesInFlight?: number): void {
    this.callbacks.emitProgress(this.progressFor(state, partIndexInFlight, bytesInFlight));
  }
}

function sanitizeName(name: string): string {
  return name.replace(/[/\\?%*:|"<>]/g, '_') || 'received-file';
}

function uniquePath(path: string): string {
  const dot = basename(path).lastIndexOf('.');
  const dir = path.slice(0, path.length - basename(path).length);
  const stem = dot > 0 ? basename(path).slice(0, dot) : basename(path);
  const ext = dot > 0 ? basename(path).slice(dot) : '';
  let candidate = path;
  let n = 0;
  while (existsSync(candidate)) {
    n++;
    candidate = join(dir, `${stem} (${n})${ext}`);
  }
  return candidate;
}

async function hashFile(path: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const hash = createHash('sha256');
    const stream = createReadStream(path);
    stream.on('data', (chunk) => hash.update(chunk as Buffer));
    stream.on('end', () => resolve(hash.digest('hex')));
    stream.on('error', reject);
  });
}
