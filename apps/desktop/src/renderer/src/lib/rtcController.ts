import type { RemoteQualitySample } from '@shared/apiTypes';
import {
  DC_CURSOR,
  DC_INPUT,
  decodeCursorState,
  LEGACY_DC_CURSOR,
  LEGACY_DC_INPUT,
  type RemoteCursorState,
  type RemoteInputEvent,
  type RemoteRtcMessage,
} from '@shared/remoteProtocol';
import { recordControllerSample } from './remoteBench';

/**
 * Controller-side WebRTC: receives the host's screen as a real video track and
 * hands it to an `HTMLVideoElement`, which decodes on the GPU and composites
 * without any JavaScript in the frame path.
 *
 * This is what brings the desktop controller to parity with mobile. Previously
 * only mobile sent `rtc-request`, so desktop→desktop was permanently stuck on
 * the JPEG tile fallback, the blocky, flickering path this replaces.
 *
 * The peer connection lives here (not in a component) because it must survive
 * re-renders and page navigation, exactly like the host-side capture singleton.
 */

const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];
/** If no video track arrives within this window, fall back to JPEG tiles. */
const RTC_FALLBACK_MS = 10_000;

export type ControllerVideoMode = 'idle' | 'negotiating' | 'webrtc' | 'tiles';

export interface ControllerRtcState {
  mode: ControllerVideoMode;
  stream: MediaStream | null;
  cursor: RemoteCursorState | null;
  quality: RemoteQualitySample | null;
}

let state: ControllerRtcState = { mode: 'idle', stream: null, cursor: null, quality: null };
const listeners = new Set<(state: ControllerRtcState) => void>();

let pc: RTCPeerConnection | null = null;
let inputChannel: RTCDataChannel | null = null;
let pendingIce: RTCIceCandidateInit[] = [];
let remoteDescSet = false;
let fallbackTimer: number | null = null;
let statsTimer: number | null = null;
let initialized = false;
let lastBytesReceived: { bytes: number; at: number } | null = null;
let lastPacketsLost = 0;

export function subscribeControllerRtc(listener: (state: ControllerRtcState) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => listeners.delete(listener);
}

export function getControllerRtcState(): ControllerRtcState {
  return state;
}

function setState(patch: Partial<ControllerRtcState>): void {
  state = { ...state, ...patch };
  for (const listener of listeners) listener(state);
}

export function initRtcController(): void {
  if (initialized) return;
  initialized = true;
  window.runova.remote.onClientRtcSignal((message) => {
    void handleSignal(message).catch(() => fallbackToTiles('negotiation error'));
  });
}

/** Called when the control connection reaches 'connected'. */
export function requestRemoteVideo(): void {
  if (pc || state.mode === 'webrtc') return;
  setState({ mode: 'negotiating' });
  window.runova.remote.clientRtcSignal({ t: 'rtc-request' });
  fallbackTimer = window.setTimeout(() => {
    fallbackTimer = null;
    if (!state.stream) fallbackToTiles('timed out');
  }, RTC_FALLBACK_MS);
}

/** Called when the control connection drops. */
export function teardownRemoteVideo(): void {
  closePeer();
  setState({ mode: 'idle', stream: null, cursor: null, quality: null });
}

/**
 * Input prefers the unreliable DataChannel and falls back to the control
 * WebSocket. Both reach the same injector on the host; the channel simply
 * cannot be stuck behind queued video or file bytes.
 */
export function sendControllerInput(event: RemoteInputEvent): void {
  if (inputChannel?.readyState === 'open') {
    try {
      inputChannel.send(JSON.stringify(event));
      return;
    } catch {
      // fall through to the socket
    }
  }
  window.runova.remote.sendInput(event);
}

export function isInputChannelOpen(): boolean {
  return inputChannel?.readyState === 'open';
}

function clearFallbackTimer(): void {
  if (fallbackTimer !== null) window.clearTimeout(fallbackTimer);
  fallbackTimer = null;
}

function closePeer(): void {
  clearFallbackTimer();
  if (statsTimer !== null) window.clearInterval(statsTimer);
  statsTimer = null;
  pendingIce = [];
  remoteDescSet = false;
  inputChannel = null;
  lastBytesReceived = null;
  lastPacketsLost = 0;
  const current = pc;
  pc = null;
  if (current) {
    try {
      current.close();
    } catch {
      // already closed
    }
  }
}

function fallbackToTiles(reason: string): void {
  closePeer();
  setState({ mode: 'tiles', stream: null, cursor: null });
  window.runova.remote.clientRtcSignal({ t: 'rtc-cancel' });
  // biome-ignore lint/suspicious/noConsole: transport downgrade is worth surfacing
  console.warn(`[remote] video stream unavailable (${reason}); using tile fallback.`);
}

async function handleSignal(message: RemoteRtcMessage): Promise<void> {
  switch (message.t) {
    case 'rtc-offer':
      await acceptOffer(message.sdp);
      break;
    case 'rtc-ice': {
      if (!message.candidate) break;
      const candidate: RTCIceCandidateInit = {
        candidate: message.candidate,
        sdpMid: message.sdpMid,
        sdpMLineIndex: message.sdpMLineIndex,
      };
      if (pc && remoteDescSet) await pc.addIceCandidate(candidate);
      else pendingIce.push(candidate);
      break;
    }
    case 'rtc-unavailable':
      fallbackToTiles(message.reason);
      break;
    default:
      break;
  }
}

async function acceptOffer(sdp: string): Promise<void> {
  closePeer();
  const connection = new RTCPeerConnection({ iceServers: STUN_SERVERS });
  pc = connection;

  connection.ontrack = (event) => {
    const stream = event.streams[0];
    if (!stream || pc !== connection) return;
    clearFallbackTimer();
    setState({ mode: 'webrtc', stream });
    startStatsSampling(connection);
  };

  connection.ondatachannel = (event) => {
    if (pc !== connection) return;
    const channel = event.channel;
    channel.binaryType = 'arraybuffer';
    // A host from before the app was renamed opens them under the old labels.
    if (channel.label === DC_INPUT || channel.label === LEGACY_DC_INPUT) {
      inputChannel = channel;
    } else if (channel.label === DC_CURSOR || channel.label === LEGACY_DC_CURSOR) {
      channel.onmessage = (message) => {
        if (pc !== connection) return;
        const data = message.data;
        if (!(data instanceof ArrayBuffer)) return;
        const cursor = decodeCursorState(new Uint8Array(data));
        if (cursor) setState({ cursor });
      };
    }
  };

  connection.onicecandidate = (event) => {
    if (!event.candidate || pc !== connection) return;
    window.runova.remote.clientRtcSignal({
      t: 'rtc-ice',
      candidate: event.candidate.candidate,
      sdpMid: event.candidate.sdpMid,
      sdpMLineIndex: event.candidate.sdpMLineIndex,
    });
  };

  connection.onconnectionstatechange = () => {
    if (pc !== connection) return;
    if (connection.connectionState === 'failed') fallbackToTiles('connection failed');
  };

  await connection.setRemoteDescription({ type: 'offer', sdp });
  remoteDescSet = true;
  for (const candidate of pendingIce) {
    try {
      await connection.addIceCandidate(candidate);
    } catch {
      // Individual candidates may fail; others usually connect anyway.
    }
  }
  pendingIce = [];
  const answer = await connection.createAnswer();
  await connection.setLocalDescription(answer);
  window.runova.remote.clientRtcSignal({ t: 'rtc-answer', sdp: answer.sdp ?? '' });
}

function startStatsSampling(connection: RTCPeerConnection): void {
  if (statsTimer !== null) window.clearInterval(statsTimer);
  statsTimer = window.setInterval(() => {
    void sampleInbound(connection);
  }, 1000);
}

async function sampleInbound(connection: RTCPeerConnection): Promise<void> {
  if (pc !== connection) return;
  let report: RTCStatsReport;
  try {
    report = await connection.getStats();
  } catch {
    return;
  }
  type Stat = Record<string, unknown>;
  const byId = new Map<string, Stat>();
  // Collected onto an object: TypeScript narrows `let` bindings assigned only
  // inside a callback to never.
  const found: { inbound?: Stat; pair?: Stat } = {};
  report.forEach((entry) => {
    const stat = entry as unknown as Stat;
    if (typeof stat.id === 'string') byId.set(stat.id, stat);
    if (stat.type === 'inbound-rtp' && stat.kind === 'video') found.inbound = stat;
    else if (stat.type === 'candidate-pair' && stat.state === 'succeeded') found.pair = stat;
  });
  const stat = found.inbound;
  if (!stat) return;
  const pair = found.pair;
  const codec = typeof stat.codecId === 'string' ? byId.get(stat.codecId) : null;
  const codecName =
    typeof codec?.mimeType === 'string' ? codec.mimeType.replace(/^video\//i, '') : null;
  const bytesReceived = numberOr(stat.bytesReceived, 0);
  const packetsLostTotal = numberOr(stat.packetsLost, 0);
  const rttMs = pair ? Math.round(numberOr(pair.currentRoundTripTime, 0) * 1000) : null;
  const fps = Math.round(numberOr(stat.framesPerSecond, 0));

  recordControllerSample({
    codec: codecName,
    width: numberOr(stat.frameWidth, 0),
    height: numberOr(stat.frameHeight, 0),
    fps,
    bytesReceived,
    framesDropped: numberOr(stat.framesDropped, 0),
    packetsLost: packetsLostTotal,
    jitter: numberOr(stat.jitter, 0),
    rttMs,
  });

  const now = Date.now();
  const kbps = lastBytesReceived
    ? Math.max(
        0,
        Math.round(((bytesReceived - lastBytesReceived.bytes) * 8) / (now - lastBytesReceived.at)),
      )
    : 0;
  lastBytesReceived = { bytes: bytesReceived, at: now };
  const packetsLost = Math.max(0, packetsLostTotal - lastPacketsLost);
  lastPacketsLost = packetsLostTotal;

  setState({
    quality: {
      kbps,
      fps,
      rttMs,
      packetsLost,
      jitter: numberOr(stat.jitter, 0),
      width: numberOr(stat.frameWidth, 0),
      height: numberOr(stat.frameHeight, 0),
      codec: codecName,
    },
  });
}

function numberOr(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
