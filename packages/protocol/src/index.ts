/**
 * Wire protocol shared between two Runova peers over a single WebSocket.
 *
 * This package is platform-agnostic on purpose: it is consumed by the desktop
 * app (Node/Electron, re-exported from `@shared/remoteProtocol`) and by the
 * mobile controller app (Hermes/React Native), so it must not rely on
 * `Buffer`, `btoa`/`atob`, or any other environment-specific global, only
 * `ArrayBuffer`/`DataView`/`Uint8Array`, which are standard everywhere.
 *
 * Two planes travel over the same socket:
 *   - Control plane: JSON text frames (see {@link RemoteControlMessage}). Small,
 *     human-readable, order-preserving.
 *   - Data plane: binary frames (see the `encode*`/`decode*` helpers). Screen
 *     tiles and file chunks are large and frequent, so they skip JSON/base64
 *     overhead and travel as compact length-prefixed buffers.
 */

export const REMOTE_PROTOCOL_VERSION = 4;

export type RemoteRole = 'host' | 'controller';

/**
 * What a connection is for. `'files'` connects, authenticates, and enables
 * file-transfer/file-manager messages, but skips screen capture and WebRTC
 * negotiation entirely, so the host never starts capturing for a `'files'` peer.
 * Absent on `hello` (older/default behavior) means `'control'`.
 */
export type RemoteConnectIntent = 'control' | 'files';

export type RemoteMouseButton = 'left' | 'right' | 'middle';

/**
 * Input coming from the controller. Pointer coordinates are normalized to
 * `0..1` against the host's screen so they survive any resolution/scaling
 * difference between the two machines.
 */
export type RemoteInputEvent =
  | { k: 'move'; x: number; y: number }
  | { k: 'down'; x: number; y: number; button: RemoteMouseButton }
  | { k: 'up'; x: number; y: number; button: RemoteMouseButton }
  | { k: 'wheel'; x: number; y: number; dx: number; dy: number }
  /** A special (non-character) key such as Enter/Backspace/Arrow keys. `code` is a DOM `KeyboardEvent.code`. */
  | { k: 'key'; code: string; down: boolean }
  /** A run of literal text to type (produced from `keypress`/IME), injected as Unicode. */
  | { k: 'text'; text: string };

export type RemoteControlMessage =
  /** First frame each side sends after the socket opens. */
  | {
      t: 'hello';
      role: RemoteRole;
      deviceName: string;
      protocolVersion: number;
      intent?: RemoteConnectIntent;
    }
  /**
   * Controller proves it holds either a one-time pairing token (first pair) or
   * a durable device token issued by a previous successful pairing.
   */
  | { t: 'auth'; token: string }
  /**
   * `deviceToken` is present only when the controller authenticated with a
   * one-time pairing code: it is a durable credential the controller should
   * store and use for all future reconnects to this host.
   */
  | {
      t: 'auth-ok';
      deviceName: string;
      screen: { width: number; height: number };
      deviceToken?: string;
    }
  | { t: 'auth-fail'; reason: string }
  /** Host announces its capture surface size (physical pixels); re-sent if it changes. */
  | { t: 'screen-info'; width: number; height: number }
  /** Controller asks the host to start / stop streaming its screen. */
  | { t: 'control-start' }
  | { t: 'control-stop' }
  | { t: 'input'; event: RemoteInputEvent }
  | { t: 'clipboard'; text: string }
  /**
   * Resumable file transfer. A file is split into fixed-size "parts" (see
   * `PART_BYTES`), each independently hashed, acked, and (on failure or a
   * mid-transfer reconnect) independently resent, so a large transfer never
   * has to restart from byte zero.
   *
   * Flow: sender sends `file-offer` → receiver replies `file-resume` with the
   * list of part indexes it still needs (all of them, on a fresh transfer) →
   * for each missing part, sender streams `BIN_FILE_CHUNK` frames tagged with
   * that `partIndex`, then sends `file-part-done` with the part's SHA-256 →
   * receiver verifies and replies `file-part-ack` (retry the same part on
   * `ok: false`) → once every part is acked, sender sends `file-complete`
   * with the whole-file SHA-256 → receiver verifies, renames the temp file
   * into place, and replies `file-done`.
   */
  | {
      t: 'file-offer';
      transferId: string;
      name: string;
      size: number;
      partSize: number;
      partCount: number;
      destDir?: string;
    }
  | { t: 'file-resume'; transferId: string; missingParts: number[] }
  | { t: 'file-part-done'; transferId: string; partIndex: number; hash: string; size: number }
  | { t: 'file-part-ack'; transferId: string; partIndex: number; ok: boolean }
  | { t: 'file-complete'; transferId: string; hash: string }
  | { t: 'file-done'; transferId: string; savedPath: string; verified: boolean }
  | { t: 'file-error'; transferId: string; message: string }
  | { t: 'file-cancel'; transferId: string }
  /**
   * Download half of the remote file manager: the browsing side has no file
   * to push, so it asks the peer to become the sender for a path on the
   * peer's own filesystem. On accept, the peer starts the normal
   * `file-offer`/... flow above (minting its own `transferId`); the requester
   * just handles that `file-offer` like any other incoming transfer.
   */
  | { t: 'file-request'; reqId: string; path: string }
  | { t: 'file-request-ack'; reqId: string; ok: boolean; error?: string }
  /** Remote file manager: browse/mkdir/delete/rename on the peer's filesystem. */
  | { t: 'fm-roots'; reqId: string }
  | { t: 'fm-roots-reply'; reqId: string; roots: RemoteFileEntry[] }
  | { t: 'fm-list'; reqId: string; path: string | null }
  | { t: 'fm-list-reply'; reqId: string; path: string; entries: RemoteFileEntry[]; error?: string }
  | { t: 'fm-mkdir'; reqId: string; parentPath: string; name: string }
  | { t: 'fm-delete'; reqId: string; path: string }
  | { t: 'fm-rename'; reqId: string; path: string; newName: string }
  | { t: 'fm-ack'; reqId: string; ok: boolean; error?: string }
  | { t: 'ping' }
  | { t: 'pong' }
  | { t: 'bye'; reason: string }
  /**
   * WebRTC signaling, relayed verbatim over the control socket. The controller
   * asks for a video stream with `rtc-request`; the host answers with an SDP
   * offer (it owns the media, so it makes the offer) or `rtc-unavailable`.
   * While a WebRTC stream is active the host stops sending JPEG tiles to that
   * controller; `rtc-cancel` reverts to tile streaming (fallback path).
   */
  | { t: 'rtc-request' }
  | { t: 'rtc-cancel' }
  | { t: 'rtc-unavailable'; reason: string }
  | { t: 'rtc-offer'; sdp: string }
  | { t: 'rtc-answer'; sdp: string }
  | { t: 'rtc-ice'; candidate: string; sdpMid: string | null; sdpMLineIndex: number | null }
  /**
   * Controller reports the physical-pixel size of its actual video display
   * box (not the whole window, just the aspect-locked content area), so the host
   * can avoid encoding more resolution than the controller can show, and can
   * raise resolution back up for a large/maximized controller window instead
   * of leaving it capped at whatever a small window last requested. Re-sent
   * (debounced) whenever that box resizes.
   */
  | { t: 'display-size'; width: number; height: number };

/** One entry in a remote-file-manager directory listing. */
export interface RemoteFileEntry {
  name: string;
  /** Absolute path on the remote peer's filesystem. */
  path: string;
  isDirectory: boolean;
  /** 0 for directories. */
  size: number;
  mtimeMs: number;
}

/** The subset of control messages that carry WebRTC signaling. */
export type RemoteRtcMessage = Extract<
  RemoteControlMessage,
  { t: 'rtc-request' | 'rtc-cancel' | 'rtc-unavailable' | 'rtc-offer' | 'rtc-answer' | 'rtc-ice' }
>;

// --- WebRTC data channels ------------------------------------------------------

/**
 * Input and cursor travel on their own `RTCDataChannel`s rather than sharing the
 * control WebSocket with bulk data.
 *
 * The control socket carries file chunks and (on the fallback path) JPEG tiles,
 * which can queue megabytes deep, so a keystroke behind that queue arrives when
 * the queue drains, not when it was pressed. Both channels are therefore
 * configured unreliable + unordered (`{ ordered: false, maxRetransmits: 0 }`):
 * a lost mouse-move is instantly obsoleted by the next one, so retransmitting it
 * would add latency to deliver a stale position.
 */
export const DC_INPUT = 'runova-input';
export const DC_CURSOR = 'runova-cursor';
/** The labels a host from before the rename to Runova opens its channels with. */
export const LEGACY_DC_INPUT = 'agentmat-input'; // legacy-name
export const LEGACY_DC_CURSOR = 'agentmat-cursor'; // legacy-name

export const DC_UNRELIABLE: { ordered: false; maxRetransmits: 0 } = {
  ordered: false,
  maxRetransmits: 0,
};

/**
 * Named cursor shapes, mapped to CSS cursor keywords by the controller.
 *
 * Electron exposes no cross-platform cursor-shape API, so the current
 * `ElectronCaptureProvider` always reports `default`. The field exists so a
 * future native capture provider (DXGI / ScreenCaptureKit / PipeWire, all of
 * which do expose the cursor shape) can populate it without a protocol change.
 */
export const CURSOR_SHAPES = [
  'default',
  'pointer',
  'text',
  'crosshair',
  'move',
  'ns-resize',
  'ew-resize',
  'nwse-resize',
  'nesw-resize',
  'wait',
  'progress',
  'not-allowed',
  'grab',
  'grabbing',
] as const;

export type RemoteCursorShape = (typeof CURSOR_SHAPES)[number];

export interface RemoteCursorState {
  /** Position normalized to `0..1` against the host's captured surface. */
  x: number;
  y: number;
  visible: boolean;
  /**
   * True when the host's video frames already contain a drawn cursor, so the
   * controller must NOT also draw an overlay (that would show two cursors).
   * See `ElectronCaptureProvider`: whether the cursor can be excluded from
   * capture is platform-dependent and detected at runtime.
   */
  baked: boolean;
  shape: RemoteCursorShape;
}

/** Wire layout: kind(1) x(2) y(2) flags(1) shape(1) = 7 bytes. */
const CURSOR_FRAME_BYTES = 7;
export const BIN_CURSOR = 0x03;

export function encodeCursorState(state: RemoteCursorState): Uint8Array {
  const out = new Uint8Array(CURSOR_FRAME_BYTES);
  const view = new DataView(out.buffer);
  view.setUint8(0, BIN_CURSOR);
  view.setUint16(1, Math.round(clamp01(state.x) * 0xffff));
  view.setUint16(3, Math.round(clamp01(state.y) * 0xffff));
  view.setUint8(5, (state.visible ? 1 : 0) | (state.baked ? 2 : 0));
  const shapeIndex = CURSOR_SHAPES.indexOf(state.shape);
  view.setUint8(6, shapeIndex < 0 ? 0 : shapeIndex);
  return out;
}

export function decodeCursorState(buf: Uint8Array): RemoteCursorState | null {
  if (buf.byteLength < CURSOR_FRAME_BYTES || buf[0] !== BIN_CURSOR) return null;
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  const flags = view.getUint8(5);
  return {
    x: view.getUint16(1) / 0xffff,
    y: view.getUint16(3) / 0xffff,
    visible: (flags & 1) !== 0,
    baked: (flags & 2) !== 0,
    shape: CURSOR_SHAPES[view.getUint8(6)] ?? 'default',
  };
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

// --- Binary data-plane framing -------------------------------------------------

export const BIN_SCREEN_TILE = 0x01;
export const BIN_FILE_CHUNK = 0x02;

/** Header layout for a screen tile: kind(1) frameId(4) x(2) y(2) w(2) h(2) = 13 bytes, then JPEG bytes. */
const TILE_HEADER_BYTES = 13;

export interface ScreenTile {
  frameId: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** JPEG-encoded pixels for this tile. */
  jpeg: Uint8Array;
}

export function encodeScreenTile(tile: ScreenTile): Uint8Array {
  const out = new Uint8Array(TILE_HEADER_BYTES + tile.jpeg.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, BIN_SCREEN_TILE);
  view.setUint32(1, tile.frameId >>> 0);
  view.setUint16(5, tile.x);
  view.setUint16(7, tile.y);
  view.setUint16(9, tile.w);
  view.setUint16(11, tile.h);
  out.set(tile.jpeg, TILE_HEADER_BYTES);
  return out;
}

export function decodeScreenTile(buf: Uint8Array): ScreenTile {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    frameId: view.getUint32(1),
    x: view.getUint16(5),
    y: view.getUint16(7),
    w: view.getUint16(9),
    h: view.getUint16(11),
    jpeg: buf.subarray(TILE_HEADER_BYTES),
  };
}

/**
 * Header layout for a file chunk: kind(1) transferKey(4) partIndex(4) seq(4)
 * = 13 bytes, then raw bytes. `seq` restarts at 0 for every part, so a
 * resumed part is indistinguishable on the wire from one sent the first time.
 */
const FILE_HEADER_BYTES = 13;

/** Size of one resumable transfer "part": the coarse unit that gets its own hash and can be resent independently. */
export const PART_BYTES = 10 * 1024 * 1024;

/** Size of one binary frame streamed within a part (does not affect resumability, only wire granularity). */
export const FILE_CHUNK_BYTES = 64 * 1024;

export interface FileChunk {
  /** Numeric handle for the transfer (low 32 bits of the transfer id hash). */
  transferKey: number;
  partIndex: number;
  seq: number;
  bytes: Uint8Array;
}

export function encodeFileChunk(chunk: FileChunk): Uint8Array {
  const out = new Uint8Array(FILE_HEADER_BYTES + chunk.bytes.byteLength);
  const view = new DataView(out.buffer);
  view.setUint8(0, BIN_FILE_CHUNK);
  view.setUint32(1, chunk.transferKey >>> 0);
  view.setUint32(5, chunk.partIndex >>> 0);
  view.setUint32(9, chunk.seq >>> 0);
  out.set(chunk.bytes, FILE_HEADER_BYTES);
  return out;
}

export function decodeFileChunk(buf: Uint8Array): FileChunk {
  const view = new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  return {
    transferKey: view.getUint32(1),
    partIndex: view.getUint32(5),
    seq: view.getUint32(9),
    bytes: buf.subarray(FILE_HEADER_BYTES),
  };
}

export function binaryKind(buf: Uint8Array): number {
  return buf[0];
}

/** Compact, deterministic 32-bit key derived from a transfer's string id (FNV-1a). */
export function transferKeyFromId(id: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < id.length; i++) {
    hash ^= id.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

// --- Portable base64 (no Buffer/btoa; safe on Node, browsers, and Hermes) ----

const B64_CHARS = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';
const B64_LOOKUP = new Map<string, number>(Array.from(B64_CHARS).map((c, i) => [c, i]));

/** Encodes raw bytes as standard (non-URL) base64, with `=` padding. */
export function bytesToBase64(bytes: Uint8Array): string {
  let result = '';
  const len = bytes.length;
  for (let i = 0; i < len; i += 3) {
    const b0 = bytes[i];
    const hasB1 = i + 1 < len;
    const hasB2 = i + 2 < len;
    const b1 = hasB1 ? bytes[i + 1] : 0;
    const b2 = hasB2 ? bytes[i + 2] : 0;
    const triplet = (b0 << 16) | (b1 << 8) | b2;
    result += B64_CHARS[(triplet >> 18) & 0x3f];
    result += B64_CHARS[(triplet >> 12) & 0x3f];
    result += hasB1 ? B64_CHARS[(triplet >> 6) & 0x3f] : '=';
    result += hasB2 ? B64_CHARS[triplet & 0x3f] : '=';
  }
  return result;
}

/** Decodes standard or URL-safe base64 (with or without padding) into raw bytes. */
export function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  const bytes: number[] = [];
  let buffer = 0;
  let bits = 0;
  for (const ch of clean) {
    const val = B64_LOOKUP.get(ch);
    if (val === undefined) continue;
    buffer = (buffer << 6) | val;
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      bytes.push((buffer >> bits) & 0xff);
    }
  }
  return new Uint8Array(bytes);
}

function utf8Encode(str: string): Uint8Array {
  const bytes: number[] = [];
  for (let i = 0; i < str.length; i++) {
    const code = str.codePointAt(i) as number;
    if (code > 0xffff) i++; // consume the low surrogate too
    if (code < 0x80) {
      bytes.push(code);
    } else if (code < 0x800) {
      bytes.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      bytes.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      bytes.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f),
      );
    }
  }
  return new Uint8Array(bytes);
}

function utf8Decode(bytes: Uint8Array): string {
  let out = '';
  let i = 0;
  while (i < bytes.length) {
    const b0 = bytes[i++];
    if (b0 < 0x80) {
      out += String.fromCharCode(b0);
    } else if ((b0 & 0xe0) === 0xc0) {
      const b1 = bytes[i++] ?? 0;
      out += String.fromCharCode(((b0 & 0x1f) << 6) | (b1 & 0x3f));
    } else if ((b0 & 0xf0) === 0xe0) {
      const b1 = bytes[i++] ?? 0;
      const b2 = bytes[i++] ?? 0;
      out += String.fromCharCode(((b0 & 0x0f) << 12) | ((b1 & 0x3f) << 6) | (b2 & 0x3f));
    } else {
      const b1 = bytes[i++] ?? 0;
      const b2 = bytes[i++] ?? 0;
      const b3 = bytes[i++] ?? 0;
      const cp = ((b0 & 0x07) << 18) | ((b1 & 0x3f) << 12) | ((b2 & 0x3f) << 6) | (b3 & 0x3f);
      out += String.fromCodePoint(cp);
    }
  }
  return out;
}

/** A `data:` URI a mobile `<Image>` can render directly from a decoded screen tile's JPEG bytes. */
export function jpegToDataUri(jpeg: Uint8Array): string {
  return `data:image/jpeg;base64,${bytesToBase64(jpeg)}`;
}

// --- Pairing code --------------------------------------------------------------

const PAIRING_PREFIX = 'RUNOVA1:';
/** Codes shown by a desktop from before the rename. */
const LEGACY_PAIRING_PREFIX = 'AGENTMATE1:'; // legacy-name

/** Everything the controller needs to reach and authenticate against a host. */
export interface PairingPayload {
  /** Host LAN IP the controller should dial. */
  ip: string;
  port: number;
  /** One-time pairing token; the host invalidates it after a successful pair. */
  token: string;
  /** Friendly host name shown to the operator before connecting. */
  deviceName: string;
  v: number;
}

function base64UrlEncode(text: string): string {
  return bytesToBase64(utf8Encode(text)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function base64UrlDecode(text: string): string {
  return utf8Decode(base64ToBytes(text));
}

export function encodePairingCode(payload: PairingPayload): string {
  return PAIRING_PREFIX + base64UrlEncode(JSON.stringify(payload));
}

export function decodePairingCode(code: string): PairingPayload | null {
  const trimmed = code.trim();
  const prefix = [PAIRING_PREFIX, LEGACY_PAIRING_PREFIX].find((each) => trimmed.startsWith(each));
  const body = prefix ? trimmed.slice(prefix.length) : trimmed;
  try {
    const parsed = JSON.parse(base64UrlDecode(body)) as Partial<PairingPayload>;
    if (
      typeof parsed.ip === 'string' &&
      typeof parsed.port === 'number' &&
      typeof parsed.token === 'string' &&
      typeof parsed.deviceName === 'string'
    ) {
      return {
        ip: parsed.ip,
        port: parsed.port,
        token: parsed.token,
        deviceName: parsed.deviceName,
        v: parsed.v ?? 1,
      };
    }
  } catch {
    // fall through
  }
  return null;
}

/** Human-readable byte size (e.g. "1.4 MB") for remote file-transfer progress/logs. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes / 1024;
  let i = 0;
  while (value >= 1024 && i < units.length - 1) {
    value /= 1024;
    i++;
  }
  return `${value.toFixed(1)} ${units[i]}`;
}
