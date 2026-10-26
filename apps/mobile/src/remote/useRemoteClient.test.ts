import { afterEach, beforeEach, describe, expect, it, jest } from '@jest/globals';
import AsyncStorage from '@react-native-async-storage/async-storage';
import {
  BIN_FILE_CHUNK,
  encodePairingCode,
  encodeScreenTile,
  REMOTE_PROTOCOL_VERSION,
  type RemoteControlMessage,
} from '@runova/protocol';
import { act, renderHook } from '@testing-library/react-native';
import * as Clipboard from 'expo-clipboard';
import {
  MediaStream,
  type RTCIceCandidate as MockIceCandidate,
  RTCPeerConnection as MockPeerConnection,
} from '../../__mocks__/react-native-webrtc';
import { FakeWebSocket } from '../../jest.setup';
import type { SavedDevice } from './savedDevices';
import { RemoteTransportMode } from './transport';
import { useRemoteClient } from './useRemoteClient';

const STORAGE_KEY = 'runova.savedDevices.v1';

const PAIRING_CODE = encodePairingCode({
  ip: '192.168.1.10',
  port: 47291,
  token: 'pair-token',
  deviceName: 'Studio PC',
  v: 1,
});

function savedDevice(overrides: Partial<SavedDevice> = {}): SavedDevice {
  return {
    id: 'dev-1',
    label: 'Studio PC',
    hostName: 'STUDIO-PC',
    ip: '192.168.1.44',
    port: 51000,
    token: 'durable-token',
    addedAt: 1000,
    lastConnectedAt: 1000,
    ...overrides,
  };
}

/** Every JSON control frame the client has pushed onto the socket. */
function sentJson(ws: FakeWebSocket): RemoteControlMessage[] {
  return ws.sent
    .filter((frame): frame is string => typeof frame === 'string')
    .map((frame) => JSON.parse(frame) as RemoteControlMessage);
}

function sentTypes(ws: FakeWebSocket): string[] {
  return sentJson(ws).map((msg) => msg.t);
}

function sentOfType<T extends RemoteControlMessage['t']>(
  ws: FakeWebSocket,
  type: T,
): Extract<RemoteControlMessage, { t: T }> {
  const found = sentJson(ws).find(
    (msg): msg is Extract<RemoteControlMessage, { t: T }> => msg.t === type,
  );
  if (!found) throw new Error(`the client never sent a "${type}" frame`);
  return found;
}

/** A binary screen-tile frame exactly as the host puts it on the wire. */
function tileFrame(x: number, y: number, jpeg = new Uint8Array([0xff, 0xd8, 0xff, 0xd9])) {
  const bytes = encodeScreenTile({ frameId: 1, x, y, w: 64, h: 48, jpeg });
  return bytes.buffer as ArrayBuffer;
}

type Client = ReturnType<typeof useRemoteClient>;

async function renderClient() {
  return await renderHook(() => useRemoteClient());
}

/** Dial with a fresh pairing code and let the socket open. */
async function dial(client: { current: Client }): Promise<FakeWebSocket> {
  await act(async () => {
    client.current.connect(PAIRING_CODE);
  });
  const ws = FakeWebSocket.last();
  await act(async () => {
    ws.serverOpen();
  });
  return ws;
}

/** The host accepts the controller. `deviceToken` mimics a first-time pairing. */
async function authOk(
  ws: FakeWebSocket,
  overrides: {
    deviceName?: string;
    screen?: { width: number; height: number };
    deviceToken?: string;
  } = {},
): Promise<void> {
  await act(async () => {
    ws.serverMessage({
      t: 'auth-ok',
      deviceName: 'STUDIO-PC',
      screen: { width: 1920, height: 1080 },
      ...overrides,
    });
  });
}

/** Let the mount effect's storage read settle before asserting on it. */
async function flushStorage(): Promise<void> {
  await act(async () => {
    await Promise.resolve();
  });
}

/** Play the host's side of the SDP exchange so a peer connection exists. */
async function offerVideo(ws: FakeWebSocket): Promise<void> {
  await act(async () => {
    ws.serverMessage({ t: 'rtc-offer', sdp: 'v=0\r\nfake-offer\r\n' });
  });
}

describe('useRemoteClient', () => {
  beforeEach(async () => {
    jest.useFakeTimers();
    await AsyncStorage.clear();
    MockPeerConnection.reset();
    jest.mocked(Clipboard.setStringAsync).mockClear();
    jest.mocked(Clipboard.getStringAsync).mockClear();
  });

  afterEach(() => {
    // Drop rather than run what is left: firing the watchdog or a stats tick
    // during teardown would update an unmounted hook.
    jest.clearAllTimers();
    jest.useRealTimers();
    jest.restoreAllMocks();
  });

  describe('initial state', () => {
    it('starts idle and loads the paired computers from storage', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([savedDevice()]));
      const { result } = await renderClient();
      expect(result.current.status).toBe('idle');
      expect(result.current.transport).toBe(RemoteTransportMode.WEBRTC_VIDEO);
      expect(result.current.phase).toBe('idle');
      await flushStorage();
      expect(result.current.savedDevices.map((d) => d.id)).toEqual(['dev-1']);
    });
  });

  describe('connect', () => {
    it('rejects a code it cannot decode without opening a socket', async () => {
      const { result } = await renderClient();
      await act(async () => {
        result.current.connect('not-a-pairing-code');
      });
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('That pairing code is not valid.');
      expect(FakeWebSocket.instances).toHaveLength(0);
    });

    it('dials the host from the decoded payload and introduces itself', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);

      expect(ws.url).toBe('ws://192.168.1.10:47291');
      // arraybuffer, not blob: the tile decoder reads bytes synchronously.
      expect(ws.binaryType).toBe('arraybuffer');
      expect(result.current.status).toBe('connecting');
      // The label from the code is shown while connecting, before the host replies.
      expect(result.current.remoteDeviceName).toBe('Studio PC');

      expect(sentTypes(ws)).toEqual(['hello', 'auth']);
      expect(sentOfType(ws, 'hello')).toMatchObject({
        role: 'controller',
        protocolVersion: REMOTE_PROTOCOL_VERSION,
      });
      expect(sentOfType(ws, 'hello').deviceName).toMatch(/^Runova Mobile \((iOS|Android)\)$/);
      expect(sentOfType(ws, 'auth').token).toBe('pair-token');
    });

    it('authenticates a saved computer with its durable token', async () => {
      const { result } = await renderClient();
      await act(async () => {
        result.current.connectToSaved(savedDevice({ label: 'Living room' }));
      });
      const ws = FakeWebSocket.last();
      await act(async () => {
        ws.serverOpen();
      });
      expect(ws.url).toBe('ws://192.168.1.44:51000');
      expect(sentOfType(ws, 'auth').token).toBe('durable-token');
      expect(result.current.remoteDeviceName).toBe('Living room');
    });

    it('says goodbye on the old socket before dialing a second host', async () => {
      const { result } = await renderClient();
      const first = await dial(result);
      await authOk(first);

      await act(async () => {
        result.current.connectToSaved(savedDevice());
      });
      expect(sentTypes(first)).toContain('bye');
      expect(FakeWebSocket.instances).toHaveLength(2);
    });
  });

  describe('the host accepting the controller', () => {
    it('reports connected, names the host and asks for screen and video', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      expect(result.current.status).toBe('connected');
      expect(result.current.remoteDeviceName).toBe('STUDIO-PC');
      expect(result.current.remoteScreen).toEqual({ width: 1920, height: 1080 });
      expect(sentTypes(ws)).toEqual(['hello', 'auth', 'control-start', 'rtc-request']);
      expect(result.current.phase).toBe('requesting');
      expect(result.current.log[0]).toMatchObject({
        level: 'success',
        message: 'Connected to STUDIO-PC.',
      });
    });

    it('ignores a zero-width screen rather than laying out against 0x0', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws, { screen: { width: 0, height: 0 } });
      expect(result.current.remoteScreen).toBeNull();
    });

    it('saves the computer when the host issues a durable device token', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws, { deviceToken: 'durable-token' });

      expect(result.current.savedDevices).toHaveLength(1);
      expect(result.current.savedDevices[0]).toMatchObject({
        hostName: 'STUDIO-PC',
        // The dialed address is saved, not anything the host claims.
        ip: '192.168.1.10',
        port: 47291,
        token: 'durable-token',
      });
      const raw = await AsyncStorage.getItem(STORAGE_KEY);
      expect(raw).toContain('durable-token');
    });

    it('only bumps lastConnectedAt when reconnecting to a saved computer', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([savedDevice()]));
      const { result } = await renderClient();
      await flushStorage();
      jest.spyOn(Date, 'now').mockReturnValue(99_000);

      await act(async () => {
        result.current.connectToSaved(savedDevice());
      });
      const ws = FakeWebSocket.last();
      await act(async () => {
        ws.serverOpen();
      });
      // No deviceToken: a reconnect reuses the stored one, so nothing is re-saved.
      await authOk(ws);

      expect(result.current.savedDevices).toHaveLength(1);
      expect(result.current.savedDevices[0].lastConnectedAt).toBe(99_000);
      expect(result.current.savedDevices[0].token).toBe('durable-token');
    });
  });

  describe('the host rejecting the controller', () => {
    it('surfaces the host reason for a fresh pairing code', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await act(async () => {
        ws.serverMessage({ t: 'auth-fail', reason: 'Pairing code expired' });
      });
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe('Pairing code expired');
    });

    it('explains that a saved pairing may have been revoked on the computer', async () => {
      // A stored token failing looks identical to a bad code otherwise, and the
      // fix (pair again) is not something the user would guess.
      const { result } = await renderClient();
      await act(async () => {
        result.current.connectToSaved(savedDevice());
      });
      const ws = FakeWebSocket.last();
      await act(async () => {
        ws.serverOpen();
        ws.serverMessage({ t: 'auth-fail', reason: 'Unknown device' });
      });
      expect(result.current.error).toBe(
        'Unknown device. The saved pairing may have been removed on the computer, pair again with a new code.',
      );
      expect(result.current.log[0]).toMatchObject({ level: 'error' });
    });
  });

  describe('screen tiles', () => {
    it('batches tiles into one state update per flush window', async () => {
      // One setState per tile would re-render the mosaic dozens of times a second.
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage(tileFrame(0, 0));
        ws.serverMessage(tileFrame(64, 0));
      });
      expect(result.current.tiles.size).toBe(0);

      await act(async () => {
        jest.advanceTimersByTime(33);
      });
      expect([...result.current.tiles.keys()]).toEqual(['0,0', '64,0']);
      expect(result.current.tiles.get('0,0')).toMatchObject({ x: 0, y: 0, w: 64, h: 48 });
      expect(result.current.tiles.get('0,0')?.uri).toMatch(/^data:image\/jpeg;base64,/);
    });

    it('replaces a tile at the same position on the next flush', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage(tileFrame(0, 0, new Uint8Array([0xff, 0xd8, 0x01])));
        jest.advanceTimersByTime(33);
      });
      const first = result.current.tiles.get('0,0')?.uri;

      await act(async () => {
        ws.serverMessage(tileFrame(0, 0, new Uint8Array([0xff, 0xd8, 0x02])));
        jest.advanceTimersByTime(33);
      });
      expect(result.current.tiles.size).toBe(1);
      expect(result.current.tiles.get('0,0')?.uri).not.toBe(first);
    });

    it('ignores binary frames that are not screen tiles', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage(new Uint8Array([BIN_FILE_CHUNK, 0, 0, 0, 1]).buffer as ArrayBuffer);
        jest.advanceTimersByTime(33);
      });
      expect(result.current.tiles.size).toBe(0);
    });

    it('drops stale tile coordinates when the host resolution changes', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await act(async () => {
        ws.serverMessage(tileFrame(0, 0));
        jest.advanceTimersByTime(33);
      });
      expect(result.current.tiles.size).toBe(1);

      await act(async () => {
        ws.serverMessage({ t: 'screen-info', width: 1280, height: 720 });
      });
      expect(result.current.remoteScreen).toEqual({ width: 1280, height: 720 });
      expect(result.current.tiles.size).toBe(0);
    });

    it('counts but never decodes tiles that arrive once video is flowing', async () => {
      // Turning a tile into a base64 data URI is the expensive part; it must not
      // happen for frames that are already superseded by the video track.
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);
      await act(async () => {
        MockPeerConnection.last().mockEmit('track', { streams: [new MediaStream()] });
      });

      await act(async () => {
        ws.serverMessage(tileFrame(0, 0));
        jest.advanceTimersByTime(1033);
      });
      expect(result.current.tiles.size).toBe(0);
      expect(result.current.stats?.totalBytes).toBeGreaterThan(0);
    });
  });

  describe('WebRTC negotiation', () => {
    it('answers the host offer and reports the phase at each step', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      expect(result.current.phase).toBe('requesting');

      await offerVideo(ws);
      const pc = MockPeerConnection.last();
      expect(pc.remoteDescription).toMatchObject({ init: { type: 'offer' } });
      expect(sentOfType(ws, 'rtc-answer').sdp).toContain('fake-answer');
      expect(result.current.phase).toBe('answered');

      await act(async () => {
        pc.mockEmit('track', { streams: [new MediaStream()] });
      });
      expect(result.current.phase).toBe('connected');
      expect(result.current.transport).toBe(RemoteTransportMode.WEBRTC_VIDEO);
      expect(result.current.remoteStream).not.toBeNull();
    });

    it('forwards its own ICE candidates to the host', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);

      await act(async () => {
        MockPeerConnection.last().mockEmit('icecandidate', {
          candidate: { candidate: 'candidate:1 1 udp', sdpMid: '0', sdpMLineIndex: 0 },
        });
      });
      expect(sentOfType(ws, 'rtc-ice')).toMatchObject({
        candidate: 'candidate:1 1 udp',
        sdpMid: '0',
        sdpMLineIndex: 0,
      });
    });

    it('queues a candidate that arrives while the remote description is still being set', async () => {
      // addIceCandidate rejects until a remote description exists, so a
      // candidate landing in the middle of acceptOffer has to wait in the queue
      // and be replayed, not be handed to the peer connection and thrown away.
      let releaseRemoteDescription = (): void => undefined;
      const gate = new Promise<void>((resolve) => {
        releaseRemoteDescription = resolve;
      });
      jest
        .spyOn(MockPeerConnection.prototype, 'setRemoteDescription')
        .mockImplementation(async function (this: MockPeerConnection, description: unknown) {
          await gate;
          this.remoteDescription = description;
        });

      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage({ t: 'rtc-offer', sdp: 'v=0\r\nfake-offer\r\n' });
        ws.serverMessage({
          t: 'rtc-ice',
          candidate: 'candidate:inflight 1 udp',
          sdpMid: '0',
          sdpMLineIndex: 0,
        });
      });
      // Nothing was added yet: there is no remote description to add it against.
      expect(MockPeerConnection.last().addedCandidates).toHaveLength(0);

      await act(async () => {
        releaseRemoteDescription();
      });
      const queued = MockPeerConnection.last().addedCandidates as MockIceCandidate[];
      expect(queued).toHaveLength(1);
      expect(queued[0].init).toMatchObject({ candidate: 'candidate:inflight 1 udp' });
    });

    it('survives a candidate that arrives before any peer connection exists', async () => {
      // The host can put a candidate on the wire ahead of its own offer; that
      // must not throw and must not disturb the negotiation that follows.
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage({
          t: 'rtc-ice',
          candidate: 'candidate:early 1 udp',
          sdpMid: '0',
          sdpMLineIndex: 0,
        });
      });
      expect(MockPeerConnection.instances).toHaveLength(0);

      await offerVideo(ws);
      expect(sentOfType(ws, 'rtc-answer').sdp).toContain('fake-answer');
      expect(result.current.phase).toBe('answered');
    });

    it('adds host candidates straight away once the offer is in', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);

      await act(async () => {
        ws.serverMessage({
          t: 'rtc-ice',
          candidate: 'candidate:late 1 udp',
          sdpMid: '0',
          sdpMLineIndex: 1,
        });
      });
      const added = MockPeerConnection.last().addedCandidates as MockIceCandidate[];
      expect(added.map((c) => c.init.candidate)).toEqual(['candidate:late 1 udp']);
    });

    it('ignores an empty candidate (the end-of-candidates marker)', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);

      await act(async () => {
        ws.serverMessage({ t: 'rtc-ice', candidate: '', sdpMid: null, sdpMLineIndex: null });
      });
      expect(MockPeerConnection.last().addedCandidates).toHaveLength(0);
    });

    it('falls back when the peer connection reports failed', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);

      const pc = MockPeerConnection.last();
      pc.connectionState = 'failed';
      await act(async () => {
        pc.mockEmit('connectionstatechange');
      });
      expect(result.current.transport).toBe(RemoteTransportMode.JPEG_TILE_FALLBACK);
      expect(result.current.phase).toBe('failed');
      expect(sentTypes(ws)).toContain('rtc-cancel');
    });

    it('falls back when ICE fails', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);

      const pc = MockPeerConnection.last();
      // The fake peer connection has no iceConnectionState of its own; the real
      // one does, and the hook reads it when the event fires.
      (pc as unknown as { iceConnectionState: string }).iceConnectionState = 'failed';
      await act(async () => {
        pc.mockEmit('iceconnectionstatechange');
      });
      expect(result.current.transport).toBe(RemoteTransportMode.JPEG_TILE_FALLBACK);
    });

    it('falls back when the host says it cannot do WebRTC', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage({ t: 'rtc-unavailable', reason: 'no encoder' });
      });
      expect(result.current.transport).toBe(RemoteTransportMode.JPEG_TILE_FALLBACK);
      expect(result.current.phase).toBe('failed');
      expect(result.current.log[0].message).toContain('no encoder');
    });

    it('re-requests video when the user retries after a fallback', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await act(async () => {
        ws.serverMessage({ t: 'rtc-unavailable', reason: 'no encoder' });
      });

      await act(async () => {
        result.current.retryVideo();
      });
      expect(sentTypes(ws).filter((t) => t === 'rtc-request')).toHaveLength(2);
      expect(result.current.phase).toBe('requesting');
      expect(result.current.transport).toBe(RemoteTransportMode.WEBRTC_VIDEO);
    });

    it('does nothing on retry while not connected', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await act(async () => {
        result.current.retryVideo();
      });
      expect(sentTypes(ws)).not.toContain('rtc-request');
    });
  });

  describe('the negotiation watchdog', () => {
    it('falls back to tiles when no video track ever arrives', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(result.current.transport).toBe(RemoteTransportMode.JPEG_TILE_FALLBACK);
      expect(result.current.phase).toBe('failed');
      expect(sentTypes(ws)).toContain('rtc-cancel');
    });

    it('still fires after the host offer arrives', async () => {
      // Regression: closePeerConnection() used to clear the watchdog, and
      // acceptOffer() calls it first, so receiving an offer disarmed the very
      // timer meant to catch a handshake that stalls right afterwards. The
      // session then sat in 'answered' forever, silently rendering tiles.
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);
      expect(result.current.phase).toBe('answered');

      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(result.current.transport).toBe(RemoteTransportMode.JPEG_TILE_FALLBACK);
      expect(result.current.phase).toBe('failed');
      // The reason names the step it died on, not a bare timeout.
      expect(result.current.log[0].message).toContain('phase "answered"');
    });

    it('is disarmed by a track actually arriving', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);
      await act(async () => {
        MockPeerConnection.last().mockEmit('track', { streams: [new MediaStream()] });
      });

      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(result.current.transport).toBe(RemoteTransportMode.WEBRTC_VIDEO);
      expect(result.current.phase).toBe('connected');
      expect(sentTypes(ws)).not.toContain('rtc-cancel');
    });

    it('does not fire after the session has gone', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await act(async () => {
        result.current.disconnect();
      });

      await act(async () => {
        jest.advanceTimersByTime(10_000);
      });
      expect(result.current.status).toBe('idle');
      expect(result.current.phase).toBe('idle');
    });
  });

  describe('stream stats', () => {
    it('samples the WebRTC report once a second and derives the bitrate', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);

      let bytesReceived = 100_000;
      const pc = MockPeerConnection.last();
      pc.getStats = async () =>
        new Map<string, unknown>([
          [
            'inbound',
            {
              type: 'inbound-rtp',
              kind: 'video',
              codecId: 'codec-1',
              bytesReceived,
              frameWidth: 1920,
              frameHeight: 1080,
              framesPerSecond: 59.6,
              packetsLost: 3,
              framesDropped: 2,
              jitter: 0.012,
            },
          ],
          ['codec-1', { type: 'codec', id: 'codec-1', mimeType: 'video/H264' }],
          ['pair', { type: 'candidate-pair', state: 'succeeded', currentRoundTripTime: 0.024 }],
        ]);

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(result.current.stats).toMatchObject({
        transport: RemoteTransportMode.WEBRTC_VIDEO,
        codec: 'H264',
        width: 1920,
        height: 1080,
        fps: 60,
        rttMs: 24,
        jitterMs: 12,
        packetsLost: 3,
        framesDropped: 2,
        totalBytes: 100_000,
        // No previous sample yet, so there is no delta to divide.
        kbps: 0,
      });

      bytesReceived = 225_000;
      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(result.current.stats?.kbps).toBe(1000);
    });

    it('reports the tile counter as JPEG stats after a fallback', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await act(async () => {
        ws.serverMessage({ t: 'rtc-unavailable', reason: 'no encoder' });
        ws.serverMessage(tileFrame(0, 0));
      });

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(result.current.stats).toMatchObject({
        transport: RemoteTransportMode.JPEG_TILE_FALLBACK,
        codec: 'JPEG',
        rttMs: null,
      });
      expect(result.current.stats?.totalBytes).toBe(17);
    });

    it('keeps the last sample when getStats rejects', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);
      MockPeerConnection.last().getStats = async () => {
        throw new Error('peer closed mid-sample');
      };

      await act(async () => {
        jest.advanceTimersByTime(1000);
      });
      expect(result.current.stats).toBeNull();
    });
  });

  describe('clipboard and input', () => {
    it('writes a clipboard push from the host to the device clipboard', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage({ t: 'clipboard', text: 'copied on the desktop' });
      });
      expect(jest.mocked(Clipboard.setStringAsync)).toHaveBeenCalledWith('copied on the desktop');
    });

    it('sends the device clipboard to the host', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      jest.mocked(Clipboard.getStringAsync).mockResolvedValueOnce('typed on the phone');

      await act(async () => {
        await result.current.sendClipboardToHost();
      });
      expect(sentOfType(ws, 'clipboard').text).toBe('typed on the phone');
    });

    it('sends nothing when the device clipboard is empty', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      jest.mocked(Clipboard.getStringAsync).mockResolvedValueOnce('');

      await act(async () => {
        await result.current.sendClipboardToHost();
      });
      expect(sentTypes(ws)).not.toContain('clipboard');
    });

    it('wraps input events in an input frame', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        result.current.sendInput({ k: 'key', code: 'Escape', down: true });
      });
      expect(sentOfType(ws, 'input').event).toEqual({ k: 'key', code: 'Escape', down: true });
    });

    it('drops input sent before the socket is open', async () => {
      const { result } = await renderClient();
      await act(async () => {
        result.current.connect(PAIRING_CODE);
      });
      const ws = FakeWebSocket.last();
      await act(async () => {
        result.current.sendInput({ k: 'move', x: 0.5, y: 0.5 });
      });
      expect(ws.sent).toHaveLength(0);
    });
  });

  describe('ending the session', () => {
    it('says goodbye, closes the socket and returns to idle', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await offerVideo(ws);
      const pc = MockPeerConnection.last();

      await act(async () => {
        result.current.disconnect('user disconnected');
      });
      expect(sentOfType(ws, 'bye').reason).toBe('user disconnected');
      expect(ws.readyState).toBe(ws.CLOSED);
      expect(pc.closed).toBe(true);
      expect(result.current.status).toBe('idle');
      expect(result.current.remoteDeviceName).toBeNull();
      expect(result.current.remoteScreen).toBeNull();
      expect(result.current.remoteStream).toBeNull();
      expect(result.current.tiles.size).toBe(0);
      expect(result.current.stats).toBeNull();
      expect(result.current.transport).toBe(RemoteTransportMode.WEBRTC_VIDEO);
      expect(result.current.phase).toBe('idle');
    });

    it('tears down when the host says goodbye first', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverMessage({ t: 'bye', reason: 'hosting stopped' });
      });
      expect(result.current.status).toBe('idle');
      expect(result.current.log[0].message).toContain('hosting stopped');
    });

    it('explains a socket error in terms the user can act on', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await act(async () => {
        ws.serverError();
      });
      expect(result.current.status).toBe('error');
      expect(result.current.error).toBe(
        'Connection failed. Make sure the computer is hosting and reachable from this network.',
      );
    });

    it('returns to idle when the host drops the connection', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);

      await act(async () => {
        ws.serverClose(1006, 'network gone');
      });
      expect(result.current.status).toBe('idle');
      expect(result.current.remoteDeviceName).toBeNull();
      expect(result.current.stats).toBeNull();
    });

    it('keeps an error on screen when the socket closes right after failing', async () => {
      // Sockets always close after an error; clearing the state here would wipe
      // the only explanation the user gets.
      const { result } = await renderClient();
      const ws = await dial(result);
      await act(async () => {
        ws.serverError();
        ws.serverClose();
      });
      expect(result.current.status).toBe('error');
      expect(result.current.error).toContain('Connection failed.');
    });

    it('ignores callbacks from a socket that is no longer the live one', async () => {
      const { result } = await renderClient();
      const first = await dial(result);
      await authOk(first);
      await act(async () => {
        result.current.connectToSaved(savedDevice());
      });
      const second = FakeWebSocket.last();
      await act(async () => {
        second.serverOpen();
        second.serverMessage({
          t: 'auth-ok',
          deviceName: 'LAPTOP',
          screen: { width: 1280, height: 720 },
        });
      });

      await act(async () => {
        first.serverError();
      });
      expect(result.current.status).toBe('connected');
      expect(result.current.remoteDeviceName).toBe('LAPTOP');
    });
  });

  describe('managing the saved list', () => {
    it('renames a computer', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([savedDevice()]));
      const { result } = await renderClient();
      await flushStorage();

      await act(async () => {
        await result.current.renameDevice('dev-1', 'Living room');
      });
      expect(result.current.savedDevices[0].label).toBe('Living room');
    });

    it('forgets a computer', async () => {
      await AsyncStorage.setItem(STORAGE_KEY, JSON.stringify([savedDevice()]));
      const { result } = await renderClient();
      await flushStorage();

      await act(async () => {
        await result.current.removeDevice('dev-1');
      });
      expect(result.current.savedDevices).toEqual([]);
    });
  });

  describe('log', () => {
    it('keeps the newest entry first and caps the history', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await act(async () => {
        for (let i = 0; i < 60; i++) {
          ws.serverMessage({ t: 'clipboard', text: `entry ${i}` });
        }
      });
      expect(result.current.log).toHaveLength(50);
      expect(result.current.log[0].message).toBe('Clipboard received from host.');
    });

    it('ignores control frames it has no handler for', async () => {
      // The host and the controller can ship at different protocol revisions, so
      // an unknown frame has to be skipped rather than break the session.
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      await act(async () => {
        ws.serverMessage({ t: 'ping' });
        ws.serverMessage({ t: 'display-size', width: 390, height: 219 });
      });
      expect(result.current.status).toBe('connected');
    });

    it('ignores malformed JSON from the host', async () => {
      const { result } = await renderClient();
      const ws = await dial(result);
      await authOk(ws);
      const before = result.current.log.length;
      await act(async () => {
        ws.serverMessage('{"t":');
      });
      expect(result.current.log).toHaveLength(before);
      expect(result.current.status).toBe('connected');
    });
  });
});
