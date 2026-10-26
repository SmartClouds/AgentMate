import { describe, expect, it } from 'vitest';
import {
  BIN_CURSOR,
  BIN_FILE_CHUNK,
  BIN_SCREEN_TILE,
  base64ToBytes,
  binaryKind,
  bytesToBase64,
  CURSOR_SHAPES,
  DC_CURSOR,
  DC_INPUT,
  DC_UNRELIABLE,
  decodeCursorState,
  decodeFileChunk,
  decodePairingCode,
  decodeScreenTile,
  encodeCursorState,
  encodeFileChunk,
  encodePairingCode,
  encodeScreenTile,
  FILE_CHUNK_BYTES,
  formatBytes,
  jpegToDataUri,
  PART_BYTES,
  type PairingPayload,
  REMOTE_PROTOCOL_VERSION,
  type RemoteCursorState,
  transferKeyFromId,
} from './index.js';

/**
 * The wire protocol is the one thing the desktop host and the Expo controller
 * both compile against, so a silent change here breaks a shipped mobile build
 * rather than failing a build. These tests pin the byte layouts, the lenient
 * paths (truncated frames, tampered pairing codes) and the version constant.
 */

/**
 * This package deliberately has no dependencies (it compiles for Hermes), so
 * `@types/node` is not available here. Node's Buffer, the reference base64
 * implementation for these tests, is reached through a narrow local shape
 * instead of the global Node types.
 */
interface NodeBufferLike {
  toString(encoding: string): string;
}
interface NodeBufferFactory {
  from(input: Uint8Array | number[]): NodeBufferLike;
}
const NodeBuffer = (globalThis as unknown as { Buffer: NodeBufferFactory }).Buffer;

/** These payloads are ASCII-only, so this stands in for TextEncoder (not in lib ES2022). */
function asciiBytes(text: string): Uint8Array {
  const out = new Uint8Array(text.length);
  for (let i = 0; i < text.length; i++) out[i] = text.charCodeAt(i);
  return out;
}

/** Seeded PRNG so a payload that trips an encoder is reproducible on a rerun. */
function seededBytes(length: number, seed: number): Uint8Array {
  const out = new Uint8Array(length);
  let state = seed >>> 0;
  for (let i = 0; i < length; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    out[i] = (state >>> 24) & 0xff;
  }
  return out;
}

describe('REMOTE_PROTOCOL_VERSION', () => {
  it('is pinned, because the mobile client has to move in step', () => {
    // apps/mobile sends this number in its `hello` frame and the host refuses a
    // mismatch, so bumping it here without shipping a new controller build
    // locks every phone out. Update this expectation and apps/mobile together.
    expect(REMOTE_PROTOCOL_VERSION).toBe(4);
  });
});

describe('binary frame kinds', () => {
  it('keeps the three kind bytes distinct', () => {
    // binaryKind() dispatches on this byte, so a collision would route tiles
    // into the file-chunk path.
    expect(new Set([BIN_SCREEN_TILE, BIN_FILE_CHUNK, BIN_CURSOR]).size).toBe(3);
  });

  it('reads the kind out of each encoder output', () => {
    expect(
      binaryKind(encodeScreenTile({ frameId: 1, x: 0, y: 0, w: 1, h: 1, jpeg: bytes(1) })),
    ).toBe(BIN_SCREEN_TILE);
    expect(
      binaryKind(encodeFileChunk({ transferKey: 1, partIndex: 0, seq: 0, bytes: bytes(1) })),
    ).toBe(BIN_FILE_CHUNK);
    expect(binaryKind(encodeCursorState(cursor()))).toBe(BIN_CURSOR);
  });

  it('reports undefined for an empty frame instead of a kind byte', () => {
    // A zero-length WebSocket frame is reachable from a hostile peer. The
    // declared return type is `number`, so callers must not compare the result
    // straight against BIN_* without checking byteLength first.
    expect(binaryKind(new Uint8Array(0))).toBeUndefined();
  });
});

function bytes(length: number, seed = 1): Uint8Array {
  return seededBytes(length, seed);
}

function cursor(over: Partial<RemoteCursorState> = {}): RemoteCursorState {
  return { x: 0.25, y: 0.75, visible: true, baked: false, shape: 'default', ...over };
}

/** Copies a frame into the middle of a bigger buffer, the way a socket read hands it over. */
function asViewWithOffset(frame: Uint8Array): Uint8Array {
  const backing = new Uint8Array(frame.byteLength + 11);
  backing.set(frame, 7);
  return backing.subarray(7, 7 + frame.byteLength);
}

describe('cursor frames', () => {
  it('round trips position, flags and shape', () => {
    const state = cursor({ x: 0.5, y: 0.125, visible: true, baked: true, shape: 'grabbing' });
    const decoded = decodeCursorState(encodeCursorState(state));
    expect(decoded).not.toBeNull();
    if (!decoded) return;
    // x/y are quantized to 16 bits, so compare within one step of 1/65535.
    expect(decoded.x).toBeCloseTo(state.x, 4);
    expect(decoded.y).toBeCloseTo(state.y, 4);
    expect(decoded.visible).toBe(true);
    expect(decoded.baked).toBe(true);
    expect(decoded.shape).toBe('grabbing');
  });

  it('is exactly 7 bytes whatever the state', () => {
    // The cursor channel is unreliable and sent per sampled frame, so the
    // fixed size is part of why it is cheap.
    expect(encodeCursorState(cursor()).byteLength).toBe(7);
    expect(encodeCursorState(cursor({ shape: 'nesw-resize' })).byteLength).toBe(7);
  });

  it('carries both flags independently', () => {
    for (const visible of [false, true]) {
      for (const baked of [false, true]) {
        const decoded = decodeCursorState(encodeCursorState(cursor({ visible, baked })));
        expect(decoded?.visible).toBe(visible);
        expect(decoded?.baked).toBe(baked);
      }
    }
  });

  it('clamps out-of-range coordinates instead of wrapping them', () => {
    // A negative or >1 normalized position would wrap through setUint16 and
    // teleport the overlay cursor to the opposite edge.
    expect(decodeCursorState(encodeCursorState(cursor({ x: -3, y: 9 })))).toMatchObject({
      x: 0,
      y: 1,
    });
  });

  it('keeps the endpoints exact', () => {
    const decoded = decodeCursorState(encodeCursorState(cursor({ x: 0, y: 1 })));
    expect(decoded?.x).toBe(0);
    expect(decoded?.y).toBe(1);
  });

  it('round trips every named shape', () => {
    for (const shape of CURSOR_SHAPES) {
      expect(decodeCursorState(encodeCursorState(cursor({ shape })))?.shape).toBe(shape);
    }
  });

  it('falls back to default for a shape index this build does not know', () => {
    // A newer host may add shapes to the end of CURSOR_SHAPES; an older
    // controller has to render something rather than crash.
    const frame = encodeCursorState(cursor());
    frame[6] = 250;
    expect(decodeCursorState(frame)?.shape).toBe('default');
  });

  it('rejects a truncated frame rather than reading past the end', () => {
    const frame = encodeCursorState(cursor());
    for (let length = 0; length < 7; length++) {
      expect(decodeCursorState(frame.subarray(0, length))).toBeNull();
    }
  });

  it('rejects a frame tagged as another kind', () => {
    const frame = encodeCursorState(cursor());
    frame[0] = BIN_SCREEN_TILE;
    expect(decodeCursorState(frame)).toBeNull();
  });

  it('decodes a view that starts partway into a larger buffer', () => {
    // Decoders take a byteOffset into account; forgetting that reads the
    // neighbouring frame's bytes instead.
    const state = cursor({ x: 0.3, y: 0.6, visible: false, baked: true, shape: 'text' });
    const decoded = decodeCursorState(asViewWithOffset(encodeCursorState(state)));
    expect(decoded?.shape).toBe('text');
    expect(decoded?.visible).toBe(false);
    expect(decoded?.baked).toBe(true);
    expect(decoded?.x).toBeCloseTo(0.3, 4);
  });
});

describe('screen tile frames', () => {
  it('round trips the header and the JPEG payload', () => {
    const jpeg = bytes(3000, 7);
    const encoded = encodeScreenTile({ frameId: 123456, x: 64, y: 128, w: 256, h: 192, jpeg });
    expect(encoded.byteLength).toBe(13 + jpeg.byteLength);
    const tile = decodeScreenTile(encoded);
    expect(tile).toMatchObject({ frameId: 123456, x: 64, y: 128, w: 256, h: 192 });
    expect(Array.from(tile.jpeg)).toEqual(Array.from(jpeg));
  });

  it('handles a zero-length payload', () => {
    // The capture provider can emit an empty tile for an unchanged region; it
    // must decode to an empty payload, not to a header read as pixels.
    const tile = decodeScreenTile(
      encodeScreenTile({ frameId: 0, x: 0, y: 0, w: 0, h: 0, jpeg: new Uint8Array(0) }),
    );
    expect(tile.jpeg.byteLength).toBe(0);
    expect(tile.frameId).toBe(0);
  });

  it('carries the largest coordinates the uint16 fields allow', () => {
    const tile = decodeScreenTile(
      encodeScreenTile({ frameId: 1, x: 0xffff, y: 0xffff, w: 0xffff, h: 0xffff, jpeg: bytes(4) }),
    );
    expect(tile).toMatchObject({ x: 0xffff, y: 0xffff, w: 0xffff, h: 0xffff });
  });

  it('keeps frameId unsigned across the 32-bit wrap', () => {
    // frameId is a monotonic counter; once it passes 2^31 a signed read would
    // make the controller think frames went backwards and drop them.
    expect(decodeScreenTile(encodeScreenTile(tile(0xffffffff))).frameId).toBe(0xffffffff);
    expect(decodeScreenTile(encodeScreenTile(tile(-1))).frameId).toBe(0xffffffff);
  });

  it('decodes a view that starts partway into a larger buffer', () => {
    const jpeg = bytes(64, 3);
    const frame = asViewWithOffset(encodeScreenTile({ frameId: 42, x: 1, y: 2, w: 3, h: 4, jpeg }));
    const decoded = decodeScreenTile(frame);
    expect(decoded).toMatchObject({ frameId: 42, x: 1, y: 2, w: 3, h: 4 });
    expect(Array.from(decoded.jpeg)).toEqual(Array.from(jpeg));
  });

  it('throws a bounds error on a truncated header instead of reading garbage', () => {
    // There is no length check in decodeScreenTile, so a short frame must fail
    // loudly through DataView rather than return a tile built from whatever
    // followed in memory. Callers guard on byteLength before decoding.
    const short = encodeScreenTile(tile(1)).subarray(0, 8);
    expect(() => decodeScreenTile(short)).toThrow(RangeError);
  });
});

function tile(frameId: number): {
  frameId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  jpeg: Uint8Array;
} {
  return { frameId, x: 0, y: 0, w: 8, h: 8, jpeg: bytes(8) };
}

describe('file chunk frames', () => {
  it('round trips a chunk', () => {
    const payload = bytes(1024, 11);
    const encoded = encodeFileChunk({
      transferKey: 0xdeadbeef,
      partIndex: 3,
      seq: 17,
      bytes: payload,
    });
    expect(encoded.byteLength).toBe(13 + payload.byteLength);
    const chunk = decodeFileChunk(encoded);
    expect(chunk).toMatchObject({ transferKey: 0xdeadbeef, partIndex: 3, seq: 17 });
    expect(Array.from(chunk.bytes)).toEqual(Array.from(payload));
  });

  it('handles a zero-length chunk', () => {
    const chunk = decodeFileChunk(
      encodeFileChunk({ transferKey: 1, partIndex: 0, seq: 0, bytes: new Uint8Array(0) }),
    );
    expect(chunk.bytes.byteLength).toBe(0);
  });

  it('handles a full-size chunk, the common case on the wire', () => {
    const payload = bytes(FILE_CHUNK_BYTES, 23);
    const chunk = decodeFileChunk(
      encodeFileChunk({ transferKey: 9, partIndex: 1, seq: 2, bytes: payload }),
    );
    expect(chunk.bytes.byteLength).toBe(FILE_CHUNK_BYTES);
    // Spot-check the ends: an off-by-one in the header size shifts everything.
    expect(chunk.bytes[0]).toBe(payload[0]);
    expect(chunk.bytes[FILE_CHUNK_BYTES - 1]).toBe(payload[FILE_CHUNK_BYTES - 1]);
  });

  it('keeps the header fields unsigned', () => {
    // transferKey comes from an FNV hash, so its top bit is set half the time.
    const chunk = decodeFileChunk(
      encodeFileChunk({
        transferKey: 0xffffffff,
        partIndex: 0xfffffffe,
        seq: 0xfffffffd,
        bytes: bytes(2),
      }),
    );
    expect(chunk).toMatchObject({
      transferKey: 0xffffffff,
      partIndex: 0xfffffffe,
      seq: 0xfffffffd,
    });
  });

  it('decodes a view that starts partway into a larger buffer', () => {
    const payload = bytes(32, 5);
    const chunk = decodeFileChunk(
      asViewWithOffset(encodeFileChunk({ transferKey: 77, partIndex: 4, seq: 5, bytes: payload })),
    );
    expect(chunk).toMatchObject({ transferKey: 77, partIndex: 4, seq: 5 });
    expect(Array.from(chunk.bytes)).toEqual(Array.from(payload));
  });

  it('throws a bounds error on a truncated header', () => {
    const short = encodeFileChunk({
      transferKey: 1,
      partIndex: 1,
      seq: 1,
      bytes: bytes(4),
    }).subarray(0, 9);
    expect(() => decodeFileChunk(short)).toThrow(RangeError);
  });

  it('splits a part into whole chunks', () => {
    // A part is the resumable unit and a chunk is the wire unit, so the part
    // size has to be a multiple of the chunk size or the last chunk of each
    // part straddles a part boundary.
    expect(PART_BYTES % FILE_CHUNK_BYTES).toBe(0);
    expect(PART_BYTES).toBeGreaterThan(FILE_CHUNK_BYTES);
  });
});

describe('transferKeyFromId', () => {
  it('is deterministic and unsigned', () => {
    const key = transferKeyFromId('transfer-9f3a');
    expect(key).toBe(transferKeyFromId('transfer-9f3a'));
    expect(key).toBeGreaterThanOrEqual(0);
    expect(key).toBeLessThanOrEqual(0xffffffff);
    expect(Number.isInteger(key)).toBe(true);
  });

  it('starts from the FNV-1a offset basis for an empty id', () => {
    expect(transferKeyFromId('')).toBe(0x811c9dc5);
  });

  it('separates the ids a session actually mints', () => {
    const ids = Array.from({ length: 500 }, (_, i) => `xfer-${i}`);
    expect(new Set(ids.map(transferKeyFromId)).size).toBe(ids.length);
  });

  it('stays unsigned for ids whose hash sets the top bit', () => {
    for (let i = 0; i < 200; i++) {
      expect(transferKeyFromId(`a${i}`)).toBeGreaterThanOrEqual(0);
    }
  });
});

describe('portable base64', () => {
  it('matches Node Buffer for every length from 0 to 1025', () => {
    // The encoder is hand-rolled so it can run on Hermes, where Buffer and
    // btoa do not exist. Node's Buffer is the reference implementation here.
    for (let length = 0; length <= 1025; length++) {
      const input = seededBytes(length, length + 1);
      const expected = NodeBuffer.from(input).toString('base64');
      expect(bytesToBase64(input)).toBe(expected);
    }
  });

  it('decodes what Node encodes, for every length from 0 to 1025', () => {
    for (let length = 0; length <= 1025; length++) {
      const input = seededBytes(length, length + 101);
      const decoded = base64ToBytes(NodeBuffer.from(input).toString('base64'));
      expect(Array.from(decoded)).toEqual(Array.from(input));
    }
  });

  it('round trips through its own encoder', () => {
    for (const length of [0, 1, 2, 3, 4, 5, 63, 64, 65, 1024, 1025]) {
      const input = seededBytes(length, length + 7);
      expect(Array.from(base64ToBytes(bytesToBase64(input)))).toEqual(Array.from(input));
    }
  });

  it('pads the tail the way standard base64 does', () => {
    expect(bytesToBase64(new Uint8Array([0]))).toBe('AA==');
    expect(bytesToBase64(new Uint8Array([0, 0]))).toBe('AAA=');
    expect(bytesToBase64(new Uint8Array([0, 0, 0]))).toBe('AAAA');
    expect(bytesToBase64(new Uint8Array(0))).toBe('');
  });

  it('encodes a subarray relative to its own view, not the backing buffer', () => {
    const backing = new Uint8Array([9, 9, 1, 2, 3, 9]);
    expect(bytesToBase64(backing.subarray(2, 5))).toBe(
      NodeBuffer.from([1, 2, 3]).toString('base64'),
    );
  });

  it('accepts URL-safe and unpadded input', () => {
    // Pairing codes travel in URL-safe form, and some QR encoders drop the
    // padding, so the decoder has to take both.
    const raw = new Uint8Array([0xfb, 0xff, 0xbe, 0xff]);
    const standard = NodeBuffer.from(raw).toString('base64');
    const urlSafe = standard.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    expect(standard).toContain('+');
    expect(Array.from(base64ToBytes(urlSafe))).toEqual(Array.from(raw));
    expect(Array.from(base64ToBytes(standard))).toEqual(Array.from(raw));
  });

  it('skips characters outside the alphabet rather than throwing', () => {
    // Deliberately lenient: newlines from a wrapped QR payload should not
    // fail a pairing attempt. The flip side is that junk decodes to junk, so
    // decodePairingCode validates the parsed object afterwards.
    const wrapped = `${bytesToBase64(new Uint8Array([1, 2, 3, 4, 5, 6]))}`;
    const dirty = `${wrapped.slice(0, 4)}\n \t${wrapped.slice(4)}`;
    expect(Array.from(base64ToBytes(dirty))).toEqual([1, 2, 3, 4, 5, 6]);
    expect(base64ToBytes('!!!').byteLength).toBe(0);
    expect(base64ToBytes('').byteLength).toBe(0);
  });
});

describe('jpegToDataUri', () => {
  it('builds a URI a mobile Image can render', () => {
    const jpeg = bytes(48, 13);
    expect(jpegToDataUri(jpeg)).toBe(
      `data:image/jpeg;base64,${NodeBuffer.from(jpeg).toString('base64')}`,
    );
  });

  it('still produces a well-formed URI for empty bytes', () => {
    expect(jpegToDataUri(new Uint8Array(0))).toBe('data:image/jpeg;base64,');
  });

  it('works straight off a decoded tile', () => {
    const jpeg = bytes(200, 17);
    const decoded = decodeScreenTile(
      encodeScreenTile({ frameId: 1, x: 0, y: 0, w: 4, h: 4, jpeg }),
    );
    // The decoded payload is a subarray of the frame, so the data URI must not
    // pick up the 13 header bytes.
    expect(jpegToDataUri(decoded.jpeg)).toBe(jpegToDataUri(jpeg));
  });
});

describe('pairing codes', () => {
  const payload: PairingPayload = {
    ip: '192.168.1.24',
    port: 41234,
    token: 'one-time-token-abc',
    deviceName: "Amin's PC",
    v: 4,
  };

  it('round trips a payload', () => {
    expect(decodePairingCode(encodePairingCode(payload))).toEqual(payload);
  });

  it('round trips non-ASCII device names', () => {
    // Device names come from the OS: accents, Persian text and emoji all show
    // up, and the code carries them through the hand-rolled UTF-8 path.
    for (const deviceName of ['Café MacBook', 'رایانه امین', 'Desk 🖥️ Pro', '日本のPC']) {
      const decoded = decodePairingCode(encodePairingCode({ ...payload, deviceName }));
      expect(decoded?.deviceName).toBe(deviceName);
    }
  });

  it('uses a URL-safe body, so it survives a QR or a link', () => {
    const code = encodePairingCode(payload);
    expect(code.startsWith('RUNOVA1:')).toBe(true);
    const body = code.slice('RUNOVA1:'.length);
    expect(body).toMatch(/^[A-Za-z0-9_-]+$/);
  });

  it('accepts a bare body, with surrounding whitespace, from a paste', () => {
    const code = encodePairingCode(payload);
    const body = code.slice('RUNOVA1:'.length);
    expect(decodePairingCode(`  ${code}\n`)).toEqual(payload);
    expect(decodePairingCode(body)).toEqual(payload);
  });

  it('reads a code from a desktop that still has the name from before the rename', () => {
    const code = encodePairingCode(payload);
    const legacy = `AGENTMATE1:${code.slice('RUNOVA1:'.length)}`; // legacy-name
    expect(decodePairingCode(legacy)).toEqual(payload);
  });

  it('defaults a missing version to 1', () => {
    // Codes minted before `v` existed have to stay pairable.
    const legacy = `RUNOVA1:${bytesToBase64(
      asciiBytes(JSON.stringify({ ip: '10.0.0.5', port: 1, token: 't', deviceName: 'old' })),
    )
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '')}`;
    expect(decodePairingCode(legacy)?.v).toBe(1);
  });

  it('returns null for a tampered code instead of throwing', () => {
    const code = encodePairingCode(payload);
    // Dropping the tail of the body leaves valid base64 but broken JSON: the
    // scanner screen shows "invalid code", it does not crash.
    expect(decodePairingCode(code.slice(0, code.length - 12))).toBeNull();
    // A body that is not base64 at all.
    expect(decodePairingCode('RUNOVA1:!!!!!!')).toBeNull();
    expect(decodePairingCode('')).toBeNull();
    expect(decodePairingCode('hello world')).toBeNull();
  });

  it('returns null when a required field is missing or the wrong type', () => {
    // A hand-edited or partially-built code must not produce a payload the
    // controller then dials with `undefined` as the host.
    const broken: Record<string, unknown>[] = [
      { port: 1, token: 't', deviceName: 'd' },
      { ip: '10.0.0.1', token: 't', deviceName: 'd' },
      { ip: '10.0.0.1', port: 1, deviceName: 'd' },
      { ip: '10.0.0.1', port: 1, token: 't' },
      { ip: '10.0.0.1', port: '1', token: 't', deviceName: 'd' },
      { ip: 42, port: 1, token: 't', deviceName: 'd' },
    ];
    for (const value of broken) {
      const body = bytesToBase64(asciiBytes(JSON.stringify(value)))
        .replace(/\+/g, '-')
        .replace(/\//g, '_')
        .replace(/=+$/, '');
      expect(decodePairingCode(`RUNOVA1:${body}`)).toBeNull();
    }
  });

  it('returns null for valid base64 that is not JSON', () => {
    const body = bytesToBase64(asciiBytes('not json at all')).replace(/=+$/, '');
    expect(decodePairingCode(`RUNOVA1:${body}`)).toBeNull();
  });
});

describe('formatBytes', () => {
  it('stays in bytes below the first boundary', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1)).toBe('1 B');
    expect(formatBytes(1023)).toBe('1023 B');
  });

  it('steps up at each 1024 boundary', () => {
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1024 * 1024 - 1)).toBe('1024.0 KB');
    expect(formatBytes(1024 * 1024)).toBe('1.0 MB');
    expect(formatBytes(1024 ** 3)).toBe('1.0 GB');
    expect(formatBytes(1024 ** 4)).toBe('1.0 TB');
  });

  it('keeps TB as the largest unit rather than running off the array', () => {
    // A bad size from a hostile peer must not index past `units`.
    expect(formatBytes(1024 ** 5)).toBe('1024.0 TB');
    expect(formatBytes(Number.MAX_SAFE_INTEGER)).toMatch(/ TB$/);
  });

  it('describes one transfer part in the unit the progress row shows', () => {
    expect(formatBytes(PART_BYTES)).toBe('10.0 MB');
    expect(formatBytes(FILE_CHUNK_BYTES)).toBe('64.0 KB');
  });
});

describe('data channel configuration', () => {
  it('names the two channels distinctly', () => {
    // Both sides open channels by label, so a clash silently merges input and
    // cursor traffic.
    expect(DC_INPUT).not.toBe(DC_CURSOR);
  });

  it('keeps input and cursor unreliable and unordered', () => {
    // Retransmitting a stale mouse position adds latency to deliver something
    // the next sample already replaced.
    expect(DC_UNRELIABLE).toEqual({ ordered: false, maxRetransmits: 0 });
  });
});
