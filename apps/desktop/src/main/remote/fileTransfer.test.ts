import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { open } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import type { RemoteFileProgress, RemoteLogLevel } from '../../shared/apiTypes';
import {
  BIN_SCREEN_TILE,
  encodeFileChunk,
  FILE_CHUNK_BYTES,
  PART_BYTES,
  type RemoteControlMessage,
  transferKeyFromId,
} from '../../shared/remoteProtocol';
import { setElectronPath } from '../../test/main/electronMock';
import { tempDir } from '../../test/main/fixtures';
import { FileTransferManager } from './fileTransfer';

/**
 * Every byte this class moves goes through the injected `sendControl`/`sendBinary` callbacks, so
 * the socket itself is never read or written. Only `readyState` is consulted, to decide whether a
 * part can go out now or has to wait for a reconnect.
 */
const OPEN = 1 as const;
const CLOSED = 3 as const;

function fakeSocket(readyState: number = OPEN): WebSocket {
  return { readyState } as WebSocket;
}

interface Recorder {
  manager: FileTransferManager;
  control: RemoteControlMessage[];
  binary: Uint8Array[];
  logs: { level: RemoteLogLevel; message: string }[];
  progress: RemoteFileProgress[];
}

function recorder(): Recorder {
  const control: RemoteControlMessage[] = [];
  const binary: Uint8Array[] = [];
  const logs: { level: RemoteLogLevel; message: string }[] = [];
  const progress: RemoteFileProgress[] = [];
  const manager = new FileTransferManager({
    sendControl: (_ws: WebSocket, msg: RemoteControlMessage) => {
      control.push(msg);
    },
    sendBinary: async (_ws: WebSocket, data: Uint8Array) => {
      binary.push(data);
    },
    log: (level: RemoteLogLevel, message: string) => {
      logs.push({ level, message });
    },
    emitProgress: (value: RemoteFileProgress) => {
      progress.push(value);
    },
  });
  return { manager, control, binary, logs, progress };
}

type ControlOf<T extends RemoteControlMessage['t']> = Extract<RemoteControlMessage, { t: T }>;

function allOf<T extends RemoteControlMessage['t']>(
  msgs: RemoteControlMessage[],
  t: T,
): ControlOf<T>[] {
  return msgs.filter((msg): msg is ControlOf<T> => msg.t === t);
}

function lastOf<T extends RemoteControlMessage['t']>(
  msgs: RemoteControlMessage[],
  t: T,
): ControlOf<T> {
  const found = allOf(msgs, t);
  if (found.length === 0) throw new Error(`no "${t}" message was sent`);
  return found[found.length - 1];
}

function sha256(bytes: Uint8Array): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Deterministic bytes, so a hash mismatch always means the assembly really went wrong. */
function payload(size: number): Buffer {
  const out = Buffer.alloc(size);
  for (let i = 0; i < size; i++) out[i] = (i * 31 + 7) & 0xff;
  return out;
}

let downloads = '';
let work = '';

beforeEach(() => {
  work = tempDir('runova-transfer-');
  downloads = join(work, 'Downloads');
  mkdirSync(downloads, { recursive: true });
  // Everything the receiver writes, temp part file included, hangs off this path.
  setElectronPath('downloads', downloads);
});

afterEach(() => {
  vi.useRealTimers();
});

// --- Receiving -----------------------------------------------------------------

interface OfferOptions {
  transferId?: string;
  name?: string;
  size: number;
  partSize: number;
  destDir?: string;
}

async function offer(rec: Recorder, ws: WebSocket, options: OfferOptions) {
  const transferId = options.transferId ?? 'transfer-0001';
  const partCount = Math.max(1, Math.ceil(options.size / options.partSize));
  const before = allOf(rec.control, 'file-resume').length;
  rec.manager.handleControl(ws, {
    t: 'file-offer',
    transferId,
    name: options.name ?? 'report.bin',
    size: options.size,
    partSize: options.partSize,
    partCount,
    destDir: options.destDir,
  });
  await vi.waitFor(() => expect(allOf(rec.control, 'file-resume').length).toBeGreaterThan(before));
  return { transferId, partCount, key: transferKeyFromId(transferId) };
}

/**
 * Streams one part in as the sender would, waiting for each frame to be written before the next
 * goes out. `handlePartData` is fired without being awaited, so back-to-back frames would race on
 * the shared byte counter and land at the wrong offsets.
 */
async function streamPart(
  rec: Recorder,
  key: number,
  partIndex: number,
  bytes: Buffer,
  chunkSize = FILE_CHUNK_BYTES,
): Promise<void> {
  let seq = 0;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    const slice = bytes.subarray(offset, Math.min(bytes.length, offset + chunkSize));
    const before = rec.progress.length;
    rec.manager.handleBinary(
      encodeFileChunk({ transferKey: key, partIndex, seq: seq++, bytes: slice }),
    );
    await vi.waitFor(() => expect(rec.progress.length).toBeGreaterThan(before));
  }
}

/** Runs a whole incoming transfer and returns where the file ended up. */
async function receiveWhole(
  rec: Recorder,
  ws: WebSocket,
  options: OfferOptions & { bytes: Buffer; wholeHash?: string },
): Promise<ControlOf<'file-done'>> {
  const { transferId, partCount, key } = await offer(rec, ws, options);
  for (let part = 0; part < partCount; part++) {
    const slice = options.bytes.subarray(part * options.partSize, (part + 1) * options.partSize);
    await streamPart(rec, key, part, slice);
    rec.manager.handleControl(ws, {
      t: 'file-part-done',
      transferId,
      partIndex: part,
      hash: sha256(slice),
      size: slice.length,
    });
  }
  const done = allOf(rec.control, 'file-done').length;
  rec.manager.handleControl(ws, {
    t: 'file-complete',
    transferId,
    hash: options.wholeHash ?? sha256(options.bytes),
  });
  await vi.waitFor(() => expect(allOf(rec.control, 'file-done').length).toBeGreaterThan(done));
  return lastOf(rec.control, 'file-done');
}

describe('receiving a file', () => {
  it('opens a temp part file and asks for every part', async () => {
    const rec = recorder();
    const ws = fakeSocket();

    const { transferId } = await offer(rec, ws, { size: 40, partSize: 16 });

    const resume = lastOf(rec.control, 'file-resume');
    expect(resume).toMatchObject({ transferId, missingParts: [0, 1, 2] });
    // The part file is preallocated so parts can be written at their real offsets out of order.
    const tmpDir = join(downloads, '.runova-tmp');
    expect(readdirSync(tmpDir)).toEqual([`${transferId}.part`]);
    expect(rec.logs[0].level).toBe('info');
    expect(rec.progress[0]).toMatchObject({ direction: 'incoming', total: 40, partsTotal: 3 });
  });

  it('assembles the parts into the original bytes', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(40);

    const done = await receiveWhole(rec, ws, {
      size: 40,
      partSize: 16,
      bytes,
      name: 'report.bin',
    });

    expect(done.verified).toBe(true);
    expect(done.savedPath).toBe(join(downloads, 'report.bin'));
    expect(readFileSync(done.savedPath)).toEqual(bytes);
    // Each part gets its own positive ack, which is what lets a bad one be resent alone.
    expect(allOf(rec.control, 'file-part-ack').map((msg) => [msg.partIndex, msg.ok])).toEqual([
      [0, true],
      [1, true],
      [2, true],
    ]);
  });

  it('writes into the destDir the sender picked when it exists', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const dest = join(work, 'Chosen');
    mkdirSync(dest);
    const bytes = payload(20);

    const done = await receiveWhole(rec, ws, { size: 20, partSize: 20, bytes, destDir: dest });

    expect(done.savedPath).toBe(join(dest, 'report.bin'));
  });

  it('falls back to Downloads when the sender names a folder we do not have', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(20);

    const done = await receiveWhole(rec, ws, {
      size: 20,
      partSize: 20,
      bytes,
      destDir: join(work, 'not-on-this-machine'),
    });

    expect(done.savedPath).toBe(join(downloads, 'report.bin'));
  });

  describe('part boundaries', () => {
    it('handles a file that is exactly one part long', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(64);

      const { partCount } = await offer(rec, ws, { size: 64, partSize: 64 });
      expect(partCount).toBe(1);

      const done = await receiveWhole(rec, ws, {
        transferId: 'transfer-exact',
        size: 64,
        partSize: 64,
        bytes,
      });
      expect(done.verified).toBe(true);
      expect(readFileSync(done.savedPath)).toEqual(bytes);
    });

    it('handles a file one byte past a part boundary', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(65);

      const done = await receiveWhole(rec, ws, { size: 65, partSize: 64, bytes });

      // The trailing 1 byte part is the case an off-by-one in the offset maths destroys.
      expect(allOf(rec.control, 'file-part-ack')).toHaveLength(2);
      expect(readFileSync(done.savedPath)).toEqual(bytes);
    });

    it('handles a part split across several wire frames', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(70);
      const ws2 = ws;

      const { transferId, key } = await offer(rec, ws2, { size: 70, partSize: 70 });
      // 7 byte frames inside one 70 byte part: seq must keep advancing the write offset.
      await streamPart(rec, key, 0, bytes, 7);
      rec.manager.handleControl(ws2, {
        t: 'file-part-done',
        transferId,
        partIndex: 0,
        hash: sha256(bytes),
        size: 70,
      });
      rec.manager.handleControl(ws2, { t: 'file-complete', transferId, hash: sha256(bytes) });
      await vi.waitFor(() => expect(allOf(rec.control, 'file-done')).toHaveLength(1));

      const done = lastOf(rec.control, 'file-done');
      expect(done.verified).toBe(true);
      expect(readFileSync(done.savedPath)).toEqual(bytes);
    });
  });

  describe('verification', () => {
    it('nacks a part whose hash does not match', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(16);

      const { transferId, key } = await offer(rec, ws, { size: 16, partSize: 16 });
      await streamPart(rec, key, 0, bytes);
      rec.manager.handleControl(ws, {
        t: 'file-part-done',
        transferId,
        partIndex: 0,
        hash: sha256(payload(16).map((b) => b ^ 0xff)),
        size: 16,
      });

      const ack = lastOf(rec.control, 'file-part-ack');
      expect(ack).toMatchObject({ partIndex: 0, ok: false });
      // A nacked part must not count as received, or the transfer would finish short.
      expect(lastOf(rec.control, 'file-resume').missingParts).toEqual([0]);
    });

    it('nacks a part-done for a part it was not receiving', async () => {
      const rec = recorder();
      const ws = fakeSocket();

      const { transferId } = await offer(rec, ws, { size: 32, partSize: 16 });
      rec.manager.handleControl(ws, {
        t: 'file-part-done',
        transferId,
        partIndex: 1,
        hash: sha256(payload(16)),
        size: 16,
      });

      expect(lastOf(rec.control, 'file-part-ack')).toMatchObject({ partIndex: 1, ok: false });
    });

    it('keeps the temp file and reports failure when the whole-file hash is wrong', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(32);

      const done = await receiveWhole(rec, ws, {
        size: 32,
        partSize: 16,
        bytes,
        wholeHash: 'f'.repeat(64),
      });

      expect(done.verified).toBe(false);
      // Not renamed into Downloads: a file that failed its end-to-end check must not look saved.
      expect(done.savedPath).toBe(join(downloads, '.runova-tmp', 'transfer-0001.part'));
      expect(existsSync(join(downloads, 'report.bin'))).toBe(false);
      expect(rec.logs.some((entry) => entry.level === 'error')).toBe(true);
      const last = rec.progress[rec.progress.length - 1];
      expect(last).toMatchObject({ verified: false, done: true });
      expect(last.error).toMatch(/hash/i);
    });
  });

  describe('naming the saved file', () => {
    it('numbers a name that is already taken', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, 'report.bin'), 'already here');
      const bytes = payload(16);

      const done = await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes });

      // Overwriting someone's existing download would be silent data loss.
      expect(done.savedPath).toBe(join(downloads, 'report (1).bin'));
      expect(readFileSync(join(downloads, 'report.bin'), 'utf-8')).toBe('already here');
    });

    it('keeps counting past the first collision', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, 'report.bin'), 'a');
      writeFileSync(join(downloads, 'report (1).bin'), 'b');

      const done = await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes: payload(16) });

      expect(done.savedPath).toBe(join(downloads, 'report (2).bin'));
    });

    it('numbers an extensionless name without inventing an extension', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, 'README'), 'a');

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name: 'README',
      });

      expect(done.savedPath).toBe(join(downloads, 'README (1)'));
    });

    it('treats a leading dot as part of the name, not an extension', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      writeFileSync(join(downloads, '.env'), 'a');

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name: '.env',
      });

      expect(done.savedPath).toBe(join(downloads, '.env (1)'));
    });

    it.each([
      ['../../escape.txt', '.._.._escape.txt'],
      ['C:\\Windows\\evil.dll', 'C__Windows_evil.dll'],
      ['re<port>:|?*.bin', 're_port_____.bin'],
    ])('sanitizes %s into a plain filename', async (name, expected) => {
      const rec = recorder();
      const ws = fakeSocket();

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name,
      });

      // A peer-supplied name must never steer the write outside the chosen folder.
      expect(done.savedPath).toBe(join(downloads, expected));
      expect(existsSync(done.savedPath)).toBe(true);
    });

    it('falls back to a placeholder when the peer sends an empty name', async () => {
      const rec = recorder();
      const ws = fakeSocket();

      const done = await receiveWhole(rec, ws, {
        size: 16,
        partSize: 16,
        bytes: payload(16),
        name: '',
      });

      expect(done.savedPath).toBe(join(downloads, 'received-file'));
    });
  });

  describe('binary routing', () => {
    it('leaves a frame that is not a file chunk to another handler', () => {
      const rec = recorder();
      const tile = new Uint8Array([BIN_SCREEN_TILE, 0, 0, 0]);
      expect(rec.manager.handleBinary(tile)).toBe(false);
    });

    it('claims a file chunk for a transfer it does not know, without crashing', () => {
      const rec = recorder();
      const frame = encodeFileChunk({
        transferKey: transferKeyFromId('never-offered'),
        partIndex: 0,
        seq: 0,
        bytes: new Uint8Array([1, 2, 3]),
      });
      // Claimed so the socket layer does not try to parse it as something else.
      expect(rec.manager.handleBinary(frame)).toBe(true);
    });

    it('ignores a stray frame for a part it is not currently receiving', async () => {
      const rec = recorder();
      const ws = fakeSocket();
      const bytes = payload(32);

      const { transferId, key } = await offer(rec, ws, { size: 32, partSize: 16 });
      await streamPart(rec, key, 0, bytes.subarray(0, 16));

      const before = rec.progress.length;
      // seq > 0 for a different part: a late frame from a part that was already abandoned.
      rec.manager.handleBinary(
        encodeFileChunk({ transferKey: key, partIndex: 1, seq: 4, bytes: payload(8) }),
      );
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(rec.progress.length).toBe(before);

      rec.manager.handleControl(ws, {
        t: 'file-part-done',
        transferId,
        partIndex: 0,
        hash: sha256(bytes.subarray(0, 16)),
        size: 16,
      });
      expect(lastOf(rec.control, 'file-part-ack').ok).toBe(true);
    });
  });

  it('rebinds an existing transfer instead of starting over on a re-offer', async () => {
    const rec = recorder();
    const first = fakeSocket();
    const bytes = payload(32);

    const { transferId, key } = await offer(rec, first, { size: 32, partSize: 16 });
    await streamPart(rec, key, 0, bytes.subarray(0, 16));
    rec.manager.handleControl(first, {
      t: 'file-part-done',
      transferId,
      partIndex: 0,
      hash: sha256(bytes.subarray(0, 16)),
      size: 16,
    });

    const second = fakeSocket();
    await offer(rec, second, { transferId, size: 32, partSize: 16 });

    // The part already on disk must not be asked for again, that is the whole resume mechanism.
    expect(lastOf(rec.control, 'file-resume').missingParts).toEqual([1]);
    expect(readdirSync(join(downloads, '.runova-tmp'))).toEqual([`${transferId}.part`]);
  });
});

// --- Sending -------------------------------------------------------------------

describe('sending a file', () => {
  it('offers the file with a part count derived from its size', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(1234));

    await rec.manager.startUpload(ws, source);

    expect(lastOf(rec.control, 'file-offer')).toMatchObject({
      name: 'payload.bin',
      size: 1234,
      partSize: PART_BYTES,
      partCount: 1,
    });
    expect(rec.logs[0]).toMatchObject({ level: 'info' });
    expect(rec.progress[0]).toMatchObject({ direction: 'outgoing', total: 1234, partsTotal: 1 });
    expect(rec.manager.hasActiveTransfers()).toBe(true);
  });

  it('passes the requested destination folder along in the offer', async () => {
    const rec = recorder();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(8));

    await rec.manager.startUpload(fakeSocket(), source, '/peer/Desktop');

    expect(lastOf(rec.control, 'file-offer').destDir).toBe('/peer/Desktop');
  });

  it('rejects rather than inventing a transfer when the file is missing', async () => {
    const rec = recorder();
    await expect(rec.manager.startUpload(fakeSocket(), join(work, 'nope.bin'))).rejects.toThrow();
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  describe('part count at the boundary', () => {
    it.each([
      ['empty', 0, 1],
      ['one byte', 1, 1],
      ['exactly one part', PART_BYTES, 1],
      ['one byte over a part', PART_BYTES + 1, 2],
      ['exactly two parts', PART_BYTES * 2, 2],
    ])('reports %s as %i byte(s) in the right number of parts', async (_label, size, expected) => {
      const rec = recorder();
      const source = join(work, 'sized.bin');
      // Preallocated rather than written byte by byte, so a 20MB case stays fast.
      const handle = await open(source, 'w');
      await handle.truncate(size);
      await handle.close();

      await rec.manager.startUpload(fakeSocket(), source);

      expect(lastOf(rec.control, 'file-offer')).toMatchObject({ size, partCount: expected });
    });
  });

  it('streams the requested part and announces its hash', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(FILE_CHUNK_BYTES + 100);
    const source = join(work, 'payload.bin');
    writeFileSync(source, bytes);
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));

    // Two frames, because the part is one 64KB chunk plus a remainder.
    expect(rec.binary).toHaveLength(2);
    expect(lastOf(rec.control, 'file-part-done')).toMatchObject({
      partIndex: 0,
      hash: sha256(bytes),
      size: bytes.length,
    });
  });

  it('completes with the whole-file hash once the last part is acked', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(512);
    const source = join(work, 'payload.bin');
    writeFileSync(source, bytes);
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 0, ok: true });

    // The end-to-end hash is recomputed from the acked parts, not read off the file again.
    expect(lastOf(rec.control, 'file-complete')).toMatchObject({ hash: sha256(bytes) });
  });

  it('ignores a stale ack for a part it is no longer waiting on', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 7, ok: true });

    expect(allOf(rec.control, 'file-complete')).toHaveLength(0);
  });

  it('resends a part the receiver rejected', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 0, ok: false });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(2));

    expect(rec.binary).toHaveLength(2);
    expect(rec.progress[rec.progress.length - 1].currentPartRetry).toBe(1);
  });

  it('gives up after too many rejected retries of the same part', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    for (let attempt = 0; attempt <= 6; attempt++) {
      await vi.waitFor(() =>
        expect(allOf(rec.control, 'file-part-done').length).toBeGreaterThanOrEqual(attempt + 1),
      );
      rec.manager.handleControl(ws, { t: 'file-part-ack', transferId, partIndex: 0, ok: false });
      if (allOf(rec.control, 'file-error').length > 0) break;
    }

    // Five retries is the cap; without it a broken link would resend forever.
    expect(lastOf(rec.control, 'file-error').message).toMatch(/failed too many times/i);
    expect(rec.logs.some((entry) => entry.level === 'error')).toBe(true);
    expect(rec.progress[rec.progress.length - 1]).toMatchObject({ done: true, verified: false });
  });

  it('holds the part back while the socket is closed', async () => {
    const rec = recorder();
    const ws = fakeSocket(CLOSED);
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Writing into a dead socket would burn the retry budget for nothing.
    expect(rec.binary).toHaveLength(0);
    expect(allOf(rec.control, 'file-part-done')).toHaveLength(0);
  });

  it('marks the parts the receiver already has as done on resume', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    const handle = await open(source, 'w');
    await handle.truncate(PART_BYTES * 2 + 1);
    await handle.close();
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [2] });

    // Parts 0 and 1 are credited without being resent, which is what resume is for.
    const progress = rec.progress[rec.progress.length - 1];
    expect(progress.partsCompleted).toBe(2);
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));
    expect(lastOf(rec.control, 'file-part-done').partIndex).toBe(2);
  });

  it('records a successful receipt', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(16));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, {
      t: 'file-done',
      transferId,
      savedPath: '/peer/Downloads/payload.bin',
      verified: true,
    });

    expect(rec.logs[rec.logs.length - 1]).toMatchObject({ level: 'success' });
    expect(rec.progress[rec.progress.length - 1]).toMatchObject({ done: true, verified: true });
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  it('records a receipt the peer could not verify as a failure', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(16));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, {
      t: 'file-done',
      transferId,
      savedPath: '/peer/tmp/x.part',
      verified: false,
    });

    const last = rec.progress[rec.progress.length - 1];
    expect(last).toMatchObject({ done: true, verified: false });
    expect(last.error).toMatch(/hash/i);
  });
});

describe('file-request from the peer', () => {
  it('accepts and immediately offers the file', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'shared.bin');
    writeFileSync(source, payload(24));

    rec.manager.handleControl(ws, { t: 'file-request', reqId: 'r1', path: source });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-offer')).toHaveLength(1));

    expect(lastOf(rec.control, 'file-request-ack')).toMatchObject({ reqId: 'r1', ok: true });
    expect(lastOf(rec.control, 'file-offer')).toMatchObject({ name: 'shared.bin', size: 24 });
  });

  it('declines a directory', async () => {
    const rec = recorder();
    const ws = fakeSocket();

    rec.manager.handleControl(ws, { t: 'file-request', reqId: 'r1', path: work });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-request-ack')).toHaveLength(1));

    expect(lastOf(rec.control, 'file-request-ack')).toMatchObject({
      ok: false,
      error: 'Not a file.',
    });
    expect(allOf(rec.control, 'file-offer')).toHaveLength(0);
  });

  it('declines a path that is not there', async () => {
    const rec = recorder();
    const ws = fakeSocket();

    rec.manager.handleControl(ws, { t: 'file-request', reqId: 'r1', path: join(work, 'ghost') });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-request-ack')).toHaveLength(1));

    const ack = lastOf(rec.control, 'file-request-ack');
    expect(ack.ok).toBe(false);
    expect(ack.error).toMatch(/ENOENT|no such file/i);
  });
});

// --- Lifecycle -----------------------------------------------------------------

describe('reconnect handling', () => {
  it('parks a transfer instead of failing it when the socket drops', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);

    rec.manager.onConnectionLost(ws);

    const last = rec.progress[rec.progress.length - 1];
    expect(last.resuming).toBe(true);
    expect(last.done).toBe(false);
    // Still "active" as far as quitting is concerned, so the app warns before closing.
    expect(rec.manager.hasActiveTransfers()).toBe(true);
  });

  it('leaves a transfer bound to another socket alone', async () => {
    const rec = recorder();
    const mine = fakeSocket();
    const other = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(mine, source);

    const before = rec.progress.length;
    rec.manager.onConnectionLost(other);

    expect(rec.progress.length).toBe(before);
  });

  it('re-offers an upload when the peer comes back', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;
    rec.manager.onConnectionLost(ws);

    rec.manager.resumeAfterReconnect(fakeSocket());

    // The same transferId is what tells the peer to keep the bytes it already has.
    expect(lastOf(rec.control, 'file-offer')).toMatchObject({ transferId, partCount: 1 });
    expect(rec.progress[rec.progress.length - 1].resuming).toBe(false);
  });

  it('re-asks for the missing parts of a download when the peer comes back', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(32);
    const { transferId, key } = await offer(rec, ws, { size: 32, partSize: 16 });
    await streamPart(rec, key, 0, bytes.subarray(0, 16));
    rec.manager.handleControl(ws, {
      t: 'file-part-done',
      transferId,
      partIndex: 0,
      hash: sha256(bytes.subarray(0, 16)),
      size: 16,
    });
    rec.manager.onConnectionLost(ws);

    rec.manager.resumeAfterReconnect(fakeSocket());

    expect(lastOf(rec.control, 'file-resume')).toMatchObject({ transferId, missingParts: [1] });
  });

  it('leaves a finished transfer out of the resume sweep', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes: payload(16) });

    const before = rec.control.length;
    rec.manager.resumeAfterReconnect(fakeSocket());

    expect(rec.control.length).toBe(before);
  });
});

describe('cancellation', () => {
  it('cancels every transfer when the user disconnects', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    await offer(rec, ws, { transferId: 'incoming-1', size: 16, partSize: 16 });

    rec.manager.cancelAll('Disconnected.');

    const finals = rec.progress.slice(-2);
    expect(finals.every((entry) => entry.done)).toBe(true);
    expect(finals.every((entry) => entry.error === 'Disconnected.')).toBe(true);
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  it('honours a cancel from the peer', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });

    rec.manager.handleControl(ws, { t: 'file-cancel', transferId });

    expect(rec.progress[rec.progress.length - 1]).toMatchObject({
      done: true,
      error: 'Cancelled by peer.',
    });
  });

  it('honours an error from the peer', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });

    rec.manager.handleControl(ws, { t: 'file-error', transferId, message: 'Disk full.' });

    expect(rec.progress[rec.progress.length - 1].error).toBe('Disk full.');
  });

  it('does not un-finish a transfer that already completed', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    await receiveWhole(rec, ws, { size: 16, partSize: 16, bytes: payload(16) });

    const before = rec.progress.length;
    rec.manager.cancelAll('Disconnected.');

    expect(rec.progress.length).toBe(before);
  });

  it('claims a control message for a transfer it has never heard of', () => {
    const rec = recorder();
    // Claimed rather than passed on: another handler would only log it as unknown.
    expect(rec.manager.handleControl(fakeSocket(), { t: 'file-cancel', transferId: 'x' })).toBe(
      true,
    );
    expect(rec.manager.handleControl(fakeSocket(), { t: 'ping' })).toBe(false);
  });
});

describe('progress snapshots', () => {
  it('reports every live transfer for a freshly opened window', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    await offer(rec, ws, { transferId: 'incoming-1', size: 32, partSize: 16, name: 'in.bin' });

    const snapshot = rec.manager.listProgress();

    expect(snapshot.map((entry) => entry.direction).sort()).toEqual(['incoming', 'outgoing']);
    expect(snapshot.find((entry) => entry.direction === 'incoming')).toMatchObject({
      name: 'in.bin',
      total: 32,
      partsTotal: 2,
      partsCompleted: 0,
    });
  });

  it('never reports more transferred than the file holds', async () => {
    const rec = recorder();
    const ws = fakeSocket();
    const bytes = payload(20);

    await receiveWhole(rec, ws, { size: 20, partSize: 16, bytes });

    // The last part is 4 bytes, but completedParts * partSize would claim 32.
    for (const entry of rec.progress) expect(entry.transferred).toBeLessThanOrEqual(20);
  });
});

describe('cleanup', () => {
  it('deletes the temp part file shortly after a cancelled download', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });
    const tmpPath = join(downloads, '.runova-tmp', `${transferId}.part`);
    expect(existsSync(tmpPath)).toBe(true);

    rec.manager.handleControl(ws, { t: 'file-cancel', transferId });
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(existsSync(tmpPath)).toBe(false));

    // Half-received files must not pile up in Downloads/.runova-tmp forever.
    expect(rec.manager.listProgress()).toEqual([]);
  });

  it('keeps the temp file of a transfer that is only waiting to reconnect', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });
    const tmpPath = join(downloads, '.runova-tmp', `${transferId}.part`);

    rec.manager.onConnectionLost(ws);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(existsSync(tmpPath)).toBe(true);
    expect(rec.manager.hasActiveTransfers()).toBe(true);
  });

  it('abandons a transfer that never reconnects', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const { transferId } = await offer(rec, ws, { size: 16, partSize: 16 });
    const tmpPath = join(downloads, '.runova-tmp', `${transferId}.part`);
    rec.manager.onConnectionLost(ws);

    // Five minutes of silence is the point where waiting stops being worth the disk space.
    await vi.advanceTimersByTimeAsync(5 * 60_000 + 30_000);

    expect(rec.progress[rec.progress.length - 1].error).toMatch(/Gave up waiting/);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(existsSync(tmpPath)).toBe(false));
    expect(rec.manager.hasActiveTransfers()).toBe(false);
  });

  it('retries a part the receiver never acked', async () => {
    vi.useFakeTimers();
    const rec = recorder();
    const ws = fakeSocket();
    const source = join(work, 'payload.bin');
    writeFileSync(source, payload(64));
    await rec.manager.startUpload(ws, source);
    const transferId = lastOf(rec.control, 'file-offer').transferId;

    rec.manager.handleControl(ws, { t: 'file-resume', transferId, missingParts: [0] });
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(1));

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(allOf(rec.control, 'file-part-done')).toHaveLength(2));

    // A silently dropped ack should cost one part, not the whole transfer.
    expect(rec.progress[rec.progress.length - 1].currentPartRetry).toBe(1);
  });
});
