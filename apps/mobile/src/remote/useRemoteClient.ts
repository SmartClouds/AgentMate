import {
  BIN_SCREEN_TILE,
  binaryKind,
  decodePairingCode,
  decodeScreenTile,
  jpegToDataUri,
  REMOTE_PROTOCOL_VERSION,
  type RemoteControlMessage,
  type RemoteInputEvent,
} from '@runova/protocol';
import * as Clipboard from 'expo-clipboard';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Platform } from 'react-native';
import type { MediaStream, RTCIceCandidate, RTCPeerConnection } from 'react-native-webrtc';
import {
  loadSavedDevices,
  removeSavedDevice,
  renameSavedDevice,
  type SavedDevice,
  touchSavedDevice,
  upsertSavedDevice,
} from './savedDevices';
import { DEFAULT_TRANSPORT_MODE, type NegotiationPhase, RemoteTransportMode } from './transport';
import { WebRtc } from './webrtc';

export type ConnectionStatus = 'idle' | 'connecting' | 'connected' | 'error';

export interface RemoteTile {
  x: number;
  y: number;
  w: number;
  h: number;
  uri: string;
}

export interface RemoteLogEntry {
  level: 'info' | 'success' | 'warning' | 'error';
  message: string;
  at: number;
}

/** Live transport diagnostics, refreshed once per second while connected. */
export interface StreamStats {
  transport: RemoteTransportMode;
  phase: NegotiationPhase;
  /** RTCPeerConnection.connectionState, null in tile mode. */
  connectionState: string | null;
  iceConnectionState: string | null;
  /** e.g. "H264", "VP8"; null until the first stats sample. */
  codec: string | null;
  width: number;
  height: number;
  fps: number;
  /** Current receive rate in kilobits per second. */
  kbps: number;
  /** Total bytes received for screen content this session. */
  totalBytes: number;
  /** Network round-trip time in ms (WebRTC only). */
  rttMs: number | null;
  packetsLost: number;
  framesDropped: number;
  jitterMs: number | null;
}

interface RemoteScreenSize {
  width: number;
  height: number;
}

const MAX_LOG = 50;
const TILE_FLUSH_MS = 33;
/**
 * If no video *track* arrives within this window we give up and fall back.
 * Armed when we ask for video and cleared only by a track actually arriving.
 * See the note on `negotiationWatchdog`.
 */
const RTC_FALLBACK_MS = 10_000;
const STUN_SERVERS = [
  { urls: 'stun:stun.l.google.com:19302' },
  { urls: 'stun:stun.cloudflare.com:3478' },
];

function deviceName(): string {
  return Platform.OS === 'ios' ? 'Runova Mobile (iOS)' : 'Runova Mobile (Android)';
}

/**
 * Controller-role client for Runova's remote-control protocol
 * (see @runova/protocol and apps/desktop/src/main/remote/manager.ts).
 *
 * The control plane (auth, input, clipboard) is a plain WebSocket. The screen
 * streams over WebRTC as a hardware-decoded video track rendered by RTCView,
 * so frames never enter JavaScript. JPEG tiles remain only as an emergency
 * fallback and to bridge the gap while the handshake completes.
 */
export function useRemoteClient() {
  const [status, setStatus] = useState<ConnectionStatus>('idle');
  const [remoteDeviceName, setRemoteDeviceName] = useState<string | null>(null);
  const [remoteScreen, setRemoteScreen] = useState<RemoteScreenSize | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [log, setLog] = useState<RemoteLogEntry[]>([]);
  const [tiles, setTiles] = useState<Map<string, RemoteTile>>(new Map());
  const [transport, setTransport] = useState<RemoteTransportMode>(DEFAULT_TRANSPORT_MODE);
  const [phase, setPhase] = useState<NegotiationPhase>('idle');
  const [remoteStream, setRemoteStream] = useState<MediaStream | null>(null);
  const [savedDevices, setSavedDevices] = useState<SavedDevice[]>([]);
  const [stats, setStats] = useState<StreamStats | null>(null);

  const wsRef = useRef<WebSocket | null>(null);
  const pcRef = useRef<RTCPeerConnection | null>(null);
  const pendingIce = useRef<RTCIceCandidate[]>([]);
  const remoteDescSet = useRef(false);
  const pendingTiles = useRef<Map<string, RemoteTile>>(new Map());
  const flushHandle = useRef<ReturnType<typeof setTimeout> | null>(null);
  const statusRef = useRef<ConnectionStatus>('idle');
  /** Connection details of the session being opened (for saving after pairing). */
  const dialing = useRef<{ ip: string; port: number; savedId: string | null } | null>(null);

  /**
   * Watchdog for the whole "asked for video → video is rendering" round trip.
   *
   * This used to be cleared by closePeerConnection(), which acceptOffer() calls
   * as its first statement, so the arrival of the host's offer disarmed the
   * very timer meant to catch a negotiation that then stalls. The result was a
   * session stuck in 'negotiating' forever, silently rendering JPEG tiles with
   * no error and no recovery. It is now owned solely by the request/track path
   * and is never touched by peer-connection teardown.
   */
  const negotiationWatchdog = useRef<ReturnType<typeof setTimeout> | null>(null);
  /** Mirrors of state the watchdog and socket callbacks must read without staleness. */
  const videoFlowing = useRef(false);
  const transportRef = useRef<RemoteTransportMode>(DEFAULT_TRANSPORT_MODE);
  const phaseRef = useRef<NegotiationPhase>('idle');

  const statsTimer = useRef<ReturnType<typeof setInterval> | null>(null);
  /** Bytes received as JPEG tiles (fallback transport) this session. */
  const tileBytes = useRef(0);
  /** Previous sample for computing the receive bitrate delta. */
  const lastSample = useRef<{ bytes: number; at: number } | null>(null);

  const appendLog = useCallback((level: RemoteLogEntry['level'], message: string) => {
    setLog((prev) => [{ level, message, at: Date.now() }, ...prev].slice(0, MAX_LOG));
  }, []);

  const setPhaseTracked = useCallback((next: NegotiationPhase) => {
    phaseRef.current = next;
    setPhase(next);
  }, []);

  const setTransportTracked = useCallback((next: RemoteTransportMode) => {
    transportRef.current = next;
    setTransport(next);
  }, []);

  useEffect(() => {
    void loadSavedDevices().then(setSavedDevices);
  }, []);

  const scheduleFlush = useCallback(() => {
    if (flushHandle.current != null) return;
    flushHandle.current = setTimeout(() => {
      flushHandle.current = null;
      setTiles(new Map(pendingTiles.current));
    }, TILE_FLUSH_MS);
  }, []);

  const resetTiles = useCallback(() => {
    pendingTiles.current = new Map();
    setTiles(new Map());
  }, []);

  const send = useCallback((msg: RemoteControlMessage) => {
    const ws = wsRef.current;
    if (ws && ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }, []);

  const clearWatchdog = useCallback(() => {
    if (negotiationWatchdog.current != null) {
      clearTimeout(negotiationWatchdog.current);
      negotiationWatchdog.current = null;
    }
  }, []);

  /** Tears down the peer connection *without* touching the watchdog. */
  const closePeerConnection = useCallback(() => {
    pendingIce.current = [];
    remoteDescSet.current = false;
    videoFlowing.current = false;
    const pc = pcRef.current;
    if (pc) {
      pcRef.current = null;
      try {
        pc.close();
      } catch {
        // already closed
      }
    }
    setRemoteStream(null);
  }, []);

  const stopStats = useCallback(() => {
    if (statsTimer.current != null) {
      clearInterval(statsTimer.current);
      statsTimer.current = null;
    }
    lastSample.current = null;
    setStats(null);
  }, []);

  /** One sample per second: WebRTC getStats() or the tile byte counter. */
  const sampleStats = useCallback(async () => {
    const now = Date.now();
    const pc = pcRef.current;

    if (transportRef.current === RemoteTransportMode.WEBRTC_VIDEO && pc) {
      let entries: Record<string, unknown>[];
      try {
        const report = (await pc.getStats()) as { forEach: (cb: (entry: unknown) => void) => void };
        entries = [];
        report.forEach((entry) => {
          if (typeof entry === 'object' && entry !== null) {
            entries.push(entry as Record<string, unknown>);
          }
        });
      } catch {
        return;
      }
      const inbound = entries.find(
        (e) => e.type === 'inbound-rtp' && (e.kind === 'video' || e.mediaType === 'video'),
      );
      const codecEntry = inbound
        ? entries.find((e) => e.type === 'codec' && e.id === inbound.codecId)
        : undefined;
      const pair = entries.find(
        (e) =>
          e.type === 'candidate-pair' &&
          e.state === 'succeeded' &&
          typeof e.currentRoundTripTime === 'number',
      );
      const bytes = num(inbound?.bytesReceived) ?? 0;
      const prev = lastSample.current;
      lastSample.current = { bytes, at: now };
      const mime = typeof codecEntry?.mimeType === 'string' ? codecEntry.mimeType : null;
      const jitter = num(inbound?.jitter);
      setStats({
        transport: RemoteTransportMode.WEBRTC_VIDEO,
        phase: phaseRef.current,
        connectionState: pc.connectionState ?? null,
        iceConnectionState: pc.iceConnectionState ?? null,
        codec: mime ? mime.replace(/^video\//i, '') : null,
        width: num(inbound?.frameWidth) ?? 0,
        height: num(inbound?.frameHeight) ?? 0,
        fps: Math.round(num(inbound?.framesPerSecond) ?? 0),
        kbps:
          prev && now > prev.at
            ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)))
            : 0,
        totalBytes: bytes + tileBytes.current,
        rttMs: pair ? Math.round((pair.currentRoundTripTime as number) * 1000) : null,
        packetsLost: num(inbound?.packetsLost) ?? 0,
        framesDropped: num(inbound?.framesDropped) ?? 0,
        jitterMs: jitter !== null ? Math.round(jitter * 1000) : null,
      });
      return;
    }

    // Tile fallback: no RTP stats, but we count every binary frame ourselves.
    const bytes = tileBytes.current;
    const prev = lastSample.current;
    lastSample.current = { bytes, at: now };
    setStats({
      transport: RemoteTransportMode.JPEG_TILE_FALLBACK,
      phase: phaseRef.current,
      connectionState: pc?.connectionState ?? null,
      iceConnectionState: pc?.iceConnectionState ?? null,
      codec: 'JPEG',
      width: 0,
      height: 0,
      fps: 0,
      kbps:
        prev && now > prev.at
          ? Math.max(0, Math.round(((bytes - prev.bytes) * 8) / (now - prev.at)))
          : 0,
      totalBytes: bytes,
      rttMs: null,
      packetsLost: 0,
      framesDropped: 0,
      jitterMs: null,
    });
  }, []);

  const startStats = useCallback(() => {
    stopStats();
    tileBytes.current = 0;
    statsTimer.current = setInterval(() => {
      void sampleStats();
    }, 1000);
  }, [sampleStats, stopStats]);

  const fallbackToTiles = useCallback(
    (reason: string) => {
      clearWatchdog();
      closePeerConnection();
      setTransportTracked(RemoteTransportMode.JPEG_TILE_FALLBACK);
      setPhaseTracked('failed');
      send({ t: 'rtc-cancel' });
      appendLog('warning', `Video unavailable (${reason}); falling back to JPEG tiles.`);
    },
    [appendLog, clearWatchdog, closePeerConnection, send, setPhaseTracked, setTransportTracked],
  );

  const disconnect = useCallback(
    (reason = 'controller disconnected') => {
      stopStats();
      clearWatchdog();
      closePeerConnection();
      const ws = wsRef.current;
      if (ws) {
        try {
          if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify({ t: 'bye', reason }));
        } catch {
          // socket already gone
        }
        ws.close();
        wsRef.current = null;
      }
      dialing.current = null;
      statusRef.current = 'idle';
      setStatus('idle');
      setRemoteDeviceName(null);
      setRemoteScreen(null);
      setTransportTracked(DEFAULT_TRANSPORT_MODE);
      setPhaseTracked('idle');
      resetTiles();
    },
    [
      clearWatchdog,
      closePeerConnection,
      resetTiles,
      setPhaseTracked,
      setTransportTracked,
      stopStats,
    ],
  );

  /** Host sent an SDP offer: answer it and start receiving the video track. */
  const acceptOffer = useCallback(
    async (sdp: string) => {
      if (!WebRtc) {
        fallbackToTiles('WebRTC module missing');
        return;
      }
      // NOTE: deliberately does not clear the negotiation watchdog; the offer
      // arriving is not evidence that video will actually flow.
      closePeerConnection();
      setPhaseTracked('offer-received');
      const pc = new WebRtc.RTCPeerConnection({ iceServers: STUN_SERVERS });
      pcRef.current = pc;

      pc.addEventListener('track', (event) => {
        const stream = event.streams[0];
        if (!stream || pcRef.current !== pc) return;
        // The one event that proves the pipeline works end to end.
        clearWatchdog();
        videoFlowing.current = true;
        setRemoteStream(stream);
        setTransportTracked(RemoteTransportMode.WEBRTC_VIDEO);
        setPhaseTracked('connected');
        resetTiles();
        appendLog('success', 'Hardware video stream started.');
      });
      pc.addEventListener('icecandidate', (event) => {
        const candidate = event.candidate;
        if (!candidate || pcRef.current !== pc) return;
        send({
          t: 'rtc-ice',
          candidate: candidate.candidate,
          sdpMid: candidate.sdpMid ?? null,
          sdpMLineIndex: candidate.sdpMLineIndex ?? null,
        });
      });
      pc.addEventListener('connectionstatechange', () => {
        if (pcRef.current !== pc) return;
        // Surfaced in the debug overlay; a stalled handshake now names its state.
        appendLog('info', `WebRTC connection state: ${pc.connectionState}`);
        if (pc.connectionState === 'failed') fallbackToTiles('connection failed');
      });
      pc.addEventListener('iceconnectionstatechange', () => {
        if (pcRef.current !== pc) return;
        if (pc.iceConnectionState === 'failed') fallbackToTiles('ICE failed');
      });

      await pc.setRemoteDescription(new WebRtc.RTCSessionDescription({ type: 'offer', sdp }));
      remoteDescSet.current = true;
      for (const candidate of pendingIce.current) {
        try {
          await pc.addIceCandidate(candidate);
        } catch {
          // Individual candidates may fail; others usually connect anyway.
        }
      }
      pendingIce.current = [];
      const answer = await pc.createAnswer();
      await pc.setLocalDescription(answer);
      send({ t: 'rtc-answer', sdp: answer.sdp ?? '' });
      setPhaseTracked('answered');
    },
    [
      appendLog,
      clearWatchdog,
      closePeerConnection,
      fallbackToTiles,
      resetTiles,
      send,
      setPhaseTracked,
      setTransportTracked,
    ],
  );

  const requestVideo = useCallback(() => {
    if (!WebRtc) {
      setTransportTracked(RemoteTransportMode.JPEG_TILE_FALLBACK);
      setPhaseTracked('unsupported');
      appendLog('warning', 'This build has no WebRTC module; using JPEG tile fallback.');
      return;
    }
    setTransportTracked(RemoteTransportMode.WEBRTC_VIDEO);
    setPhaseTracked('requesting');
    send({ t: 'rtc-request' });
    clearWatchdog();
    negotiationWatchdog.current = setTimeout(() => {
      negotiationWatchdog.current = null;
      if (statusRef.current === 'connected' && !videoFlowing.current) {
        // The phase names which step it died on instead of a bare "timed out".
        fallbackToTiles(`no video track after 10s at phase "${phaseRef.current}"`);
      }
    }, RTC_FALLBACK_MS);
  }, [appendLog, clearWatchdog, fallbackToTiles, send, setPhaseTracked, setTransportTracked]);

  const open = useCallback(
    (
      payload: { ip: string; port: number; token: string; deviceName: string },
      savedId: string | null,
    ) => {
      if (wsRef.current) disconnect();

      dialing.current = { ip: payload.ip, port: payload.port, savedId };
      statusRef.current = 'connecting';
      setStatus('connecting');
      setError(null);
      setRemoteDeviceName(payload.deviceName);
      setRemoteScreen(null);
      setTransportTracked(DEFAULT_TRANSPORT_MODE);
      setPhaseTracked('idle');
      resetTiles();

      const ws = new WebSocket(`ws://${payload.ip}:${payload.port}`);
      ws.binaryType = 'arraybuffer';
      wsRef.current = ws;

      ws.onopen = () => {
        send({
          t: 'hello',
          role: 'controller',
          deviceName: deviceName(),
          protocolVersion: REMOTE_PROTOCOL_VERSION,
        });
        send({ t: 'auth', token: payload.token });
      };

      ws.onmessage = (event) => {
        if (typeof event.data === 'string') {
          let msg: RemoteControlMessage;
          try {
            msg = JSON.parse(event.data) as RemoteControlMessage;
          } catch {
            return;
          }
          switch (msg.t) {
            case 'auth-ok': {
              statusRef.current = 'connected';
              setStatus('connected');
              setRemoteDeviceName(msg.deviceName);
              if (msg.screen.width) setRemoteScreen(msg.screen);
              send({ t: 'control-start' });
              appendLog('success', `Connected to ${msg.deviceName}.`);
              startStats();

              // Remember this computer for one-tap reconnects.
              const dial = dialing.current;
              if (msg.deviceToken && dial) {
                void upsertSavedDevice({
                  hostName: msg.deviceName,
                  ip: dial.ip,
                  port: dial.port,
                  token: msg.deviceToken,
                }).then(setSavedDevices);
              } else if (dial?.savedId) {
                void touchSavedDevice(dial.savedId).then(setSavedDevices);
              }

              requestVideo();
              break;
            }
            case 'auth-fail':
              statusRef.current = 'error';
              setStatus('error');
              setError(
                dialing.current?.savedId
                  ? `${msg.reason}. The saved pairing may have been removed on the computer, pair again with a new code.`
                  : msg.reason,
              );
              appendLog('error', `Pairing rejected: ${msg.reason}`);
              break;
            case 'screen-info':
              setRemoteScreen({ width: msg.width, height: msg.height });
              resetTiles(); // tile coordinates from the old resolution are stale
              break;
            case 'rtc-offer':
              void acceptOffer(msg.sdp).catch((err: unknown) =>
                fallbackToTiles(`negotiation error: ${(err as Error).message}`),
              );
              break;
            case 'rtc-ice': {
              if (!msg.candidate || !WebRtc) break;
              const candidate = new WebRtc.RTCIceCandidate({
                candidate: msg.candidate,
                sdpMid: msg.sdpMid,
                sdpMLineIndex: msg.sdpMLineIndex,
              });
              const pc = pcRef.current;
              if (pc && remoteDescSet.current) {
                void pc.addIceCandidate(candidate).catch(() => {
                  // candidate may arrive after the connection has moved on; ignore
                });
              } else {
                pendingIce.current.push(candidate);
              }
              break;
            }
            case 'rtc-unavailable':
              fallbackToTiles(msg.reason);
              break;
            case 'clipboard':
              void Clipboard.setStringAsync(msg.text);
              appendLog('info', 'Clipboard received from host.');
              break;
            case 'bye':
              appendLog('info', `Host said goodbye: ${msg.reason}`);
              disconnect();
              break;
            default:
              break;
          }
          return;
        }

        const bytes = new Uint8Array(event.data as ArrayBuffer);
        if (binaryKind(bytes) !== BIN_SCREEN_TILE) return;

        // JPEG decoding is off the primary path. Tiles are only turned into
        // base64 data URIs when they are actually what's being rendered:
        // the fallback transport, or the brief window before the video track
        // arrives (which they bridge so the screen isn't black during ICE).
        // Once video flows the host stops sending them; any that still arrive
        // are counted and dropped without touching base64.
        tileBytes.current += bytes.byteLength;
        if (videoFlowing.current) return;

        const tile = decodeScreenTile(bytes);
        pendingTiles.current.set(`${tile.x},${tile.y}`, {
          x: tile.x,
          y: tile.y,
          w: tile.w,
          h: tile.h,
          uri: jpegToDataUri(tile.jpeg),
        });
        scheduleFlush();
      };

      ws.onerror = () => {
        if (wsRef.current !== ws) return;
        statusRef.current = 'error';
        setStatus('error');
        setError(
          'Connection failed. Make sure the computer is hosting and reachable from this network.',
        );
        appendLog('error', 'Connection failed.');
      };

      ws.onclose = () => {
        if (wsRef.current !== ws) return;
        wsRef.current = null;
        stopStats();
        clearWatchdog();
        closePeerConnection();
        if (statusRef.current !== 'error') {
          statusRef.current = 'idle';
          setStatus('idle');
          setRemoteDeviceName(null);
          setRemoteScreen(null);
          setTransportTracked(DEFAULT_TRANSPORT_MODE);
          setPhaseTracked('idle');
          resetTiles();
        }
      };
    },
    [
      acceptOffer,
      appendLog,
      clearWatchdog,
      closePeerConnection,
      disconnect,
      fallbackToTiles,
      requestVideo,
      resetTiles,
      scheduleFlush,
      send,
      setPhaseTracked,
      setTransportTracked,
      startStats,
      stopStats,
    ],
  );

  /** Connect with a fresh pairing code (QR scan or manual paste). */
  const connect = useCallback(
    (rawCode: string) => {
      const payload = decodePairingCode(rawCode);
      if (!payload) {
        setError('That pairing code is not valid.');
        setStatus('error');
        return;
      }
      open(payload, null);
    },
    [open],
  );

  /** Reconnect to a previously paired computer using its stored token. */
  const connectToSaved = useCallback(
    (device: SavedDevice) => {
      open(
        { ip: device.ip, port: device.port, token: device.token, deviceName: device.label },
        device.id,
      );
    },
    [open],
  );

  const renameDevice = useCallback(async (id: string, label: string) => {
    setSavedDevices(await renameSavedDevice(id, label));
  }, []);

  const removeDevice = useCallback(async (id: string) => {
    setSavedDevices(await removeSavedDevice(id));
  }, []);

  const sendInput = useCallback((event: RemoteInputEvent) => send({ t: 'input', event }), [send]);

  const sendClipboardToHost = useCallback(async () => {
    const text = await Clipboard.getStringAsync();
    if (!text) return;
    send({ t: 'clipboard', text });
    appendLog('info', 'Clipboard sent.');
  }, [appendLog, send]);

  /** Manual retry from the debug overlay after a fallback. */
  const retryVideo = useCallback(() => {
    if (statusRef.current !== 'connected') return;
    closePeerConnection();
    resetTiles();
    requestVideo();
  }, [closePeerConnection, requestVideo, resetTiles]);

  useEffect(() => {
    return () => {
      if (flushHandle.current != null) clearTimeout(flushHandle.current);
      if (negotiationWatchdog.current != null) clearTimeout(negotiationWatchdog.current);
      if (statsTimer.current != null) clearInterval(statsTimer.current);
      pcRef.current?.close();
      wsRef.current?.close();
    };
  }, []);

  return {
    status,
    remoteDeviceName,
    remoteScreen,
    error,
    log,
    tiles,
    transport,
    phase,
    remoteStream,
    savedDevices,
    stats,
    connect,
    connectToSaved,
    renameDevice,
    removeDevice,
    disconnect,
    sendInput,
    sendClipboardToHost,
    retryVideo,
  };
}

function num(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}
