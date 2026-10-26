import { randomUUID } from 'node:crypto';
import { app, BrowserWindow, clipboard, dialog, powerSaveBlocker, screen } from 'electron';
import QRCode from 'qrcode';
import { WebSocket, WebSocketServer } from 'ws';
import type {
  RemoteConnectIntent,
  RemoteConnectionInfo,
  RemoteFileProgress,
  RemoteLogLevel,
  RemotePairingInfo,
  RemotePeerInfo,
  RemoteSavedServer,
  RemoteState,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  BIN_SCREEN_TILE,
  binaryKind,
  encodePairingCode,
  REMOTE_PROTOCOL_VERSION,
  type RemoteControlMessage,
  type RemoteInputEvent,
  type RemoteRtcMessage,
} from '../../shared/remoteProtocol';
import { sendToWindow } from '../ipc/send';
import { store } from '../store';
import { FileManagerOps } from './fileManagerOps';
import { FileTransferManager } from './fileTransfer';
import { InputInjector } from './inputInjector';
import { listNetworkInterfaces } from './networkInterfaces';
import { sessionWindow } from './sessionWindow';
import { TokenStore } from './tokens';

const MAX_BUFFERED_BYTES = 4 * 1024 * 1024;
/** Backoff schedule for auto-reconnect while a file transfer is in flight. */
const RECONNECT_DELAYS_MS = [1000, 2000, 4000, 8000, 15000];
/** Give up auto-reconnecting and fail any in-flight transfers after this long. */
const RECONNECT_GIVE_UP_MS = 5 * 60 * 1000;
/**
 * OS cursor sampling rate for the cursor DataChannel (~60 Hz). Deliberately
 * faster than the video framerate: the whole point of a separate cursor plane
 * is that pointer motion doesn't wait for the next encoded frame.
 */
const CURSOR_SAMPLE_MS = 16;
/** Sockets are considered drained (safe to resend a full frame) below this. */
const TILE_HEAL_LOW_WATER = 256 * 1024;
/** Minimum spacing between drop-healing full refreshes. */
const TILE_HEAL_MIN_INTERVAL_MS = 2000;

interface HostPeer {
  id: string;
  ws: WebSocket;
  deviceName: string;
  address: string;
  connectedAt: number;
  authed: boolean;
  /** What this peer connected for; a `'files'` peer never receives capture/tiles. */
  intent: RemoteConnectIntent;
  /**
   * False while the peer receives video over a *connected* WebRTC session, so
   * the two transports don't compete for bandwidth. Deliberately stays true
   * through WebRTC negotiation. The renderer flips it via setRtcPeerConnected
   * once video truly flows, which keeps the controller's screen painted with
   * tiles instead of going black while ICE completes. Always false for a
   * `'files'`-intent peer.
   */
  wantsTiles: boolean;
}

/**
 * Orchestrates the whole remote-control feature for one Runova instance.
 *
 * A single machine can simultaneously *host* (let others control it) and act as
 * a *controller* (drive another machine). Both roles ride WebSockets that live
 * here in the main process. The renderer never opens a socket, so the app's
 * strict Content-Security-Policy is untouched. The renderer only captures the
 * screen (host) / paints frames and reads input (controller) and exchanges
 * everything with this manager over IPC.
 */
class RemoteManager {
  private mainWindow: BrowserWindow | null = null;
  private readonly injector = new InputInjector();
  private readonly tokens = new TokenStore();

  private server: WebSocketServer | null = null;
  private hostIp: string | null = null;
  private hostPort = 7900;
  private readonly peers = new Map<string, HostPeer>();
  /**
   * Windows/macOS blank the display (and screensaver/lock can follow) after
   * an idle timeout regardless of whether someone is actively watching this
   * machine's screen remotely, and once the display is off, screen capture
   * APIs return black frames, so the controller sees nothing. Held for as
   * long as at least one controller is actually authed against this host.
   */
  private powerSaveBlockerId: number | null = null;
  private hostScreen: { width: number; height: number } | null = null;
  private capturing = false;
  private tileDemand = true;
  /** A backpressured peer had tiles dropped; a healing refresh is owed. */
  private tileRefreshPending = false;
  private lastTileHealAt = 0;
  private pairing: RemotePairingInfo | null = null;

  private client: WebSocket | null = null;
  private connection: RemoteConnectionInfo = {
    status: 'idle',
    remoteDeviceName: null,
    remoteScreen: null,
    intent: null,
  };
  /** Credentials behind the in-flight/most recent `connect()` call, used to save/refresh a saved-server entry once `auth-ok` arrives, and to redial on an auto-reconnect. */
  private pendingConnect: { ip: string; port: number; token: string; deviceName: string } | null =
    null;
  private connectIntent: RemoteConnectIntent = 'control';
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private reconnectDeadline = 0;

  private readonly files = new FileTransferManager({
    sendControl: (ws, msg) => this.sendControl(ws, msg),
    sendBinary: (ws, data) => this.sendBinary(ws, data),
    log: (level, message) => this.log(level, message),
    emitProgress: (progress) => this.emitFileProgress(progress),
  });
  private readonly fmOps = new FileManagerOps({
    sendControl: (ws, msg) => this.sendControl(ws, msg),
  });

  private cursorTimer: NodeJS.Timeout | null = null;
  private lastCursor: { x: number; y: number } | null = null;

  init(window: BrowserWindow): void {
    this.mainWindow = window;
    // Closing the session window ends the session, same as clicking Disconnect.
    sessionWindow.setOnClose(() => this.disconnect());
  }

  private deviceName(): string {
    return process.env.COMPUTERNAME || process.env.HOSTNAME || app.getName();
  }

  getState(): RemoteState {
    return {
      deviceName: this.deviceName(),
      hosting: this.server !== null,
      hostIp: this.hostIp,
      hostPort: this.hostPort,
      inputSupported: this.injector.isSupported(),
      pairing: this.pairing,
      peers: [...this.peers.values()]
        .filter((p) => p.authed)
        .map<RemotePeerInfo>((p) => ({
          id: p.id,
          deviceName: p.deviceName,
          address: p.address,
          connectedAt: p.connectedAt,
        })),
      connection: this.connection,
      interfaces: listNetworkInterfaces(),
    };
  }

  // --- Host role ---------------------------------------------------------------

  startHost(ip: string, port: number): RemoteState {
    this.stopHost();
    this.hostIp = ip;
    this.hostPort = port;
    const server = new WebSocketServer({ host: '0.0.0.0', port });
    server.on('connection', (ws, req) => {
      const address = req.socket.remoteAddress ?? 'unknown';
      const peer: HostPeer = {
        id: randomUUID(),
        ws,
        deviceName: address,
        address,
        connectedAt: Date.now(),
        authed: false,
        intent: 'control',
        wantsTiles: true,
      };
      this.peers.set(peer.id, peer);
      ws.on('message', (data, isBinary) => this.onHostMessage(peer, data as Buffer, isBinary));
      ws.on('close', () => this.onPeerGone(peer));
      ws.on('error', () => this.onPeerGone(peer));
    });
    server.on('error', (err) => {
      this.log('error', `Host server error: ${err.message}`);
      this.stopHost();
    });
    this.server = server;
    this.injector.start();
    this.log('info', `Hosting on ${ip}:${port}`);
    this.emitState();
    return this.getState();
  }

  stopHost(): void {
    for (const peer of this.peers.values()) this.safeClose(peer.ws, 'host stopped');
    this.peers.clear();
    this.pairing = null;
    this.tokens.clear();
    if (this.server) {
      this.server.close();
      this.server = null;
    }
    if (this.capturing) {
      this.capturing = false;
      this.send(IPC.remote.onCaptureStop);
    }
    this.tileDemand = true; // matches the renderer's default for the next session
    this.tileRefreshPending = false;
    this.setCursorTracking(false);
    // Only tear the injector down if we aren't also acting as a controller elsewhere.
    this.injector.stop();
    this.syncPowerSaveBlocker();
    this.emitState();
  }

  /** Keeps the display awake for exactly as long as someone is actually watching it. */
  private syncPowerSaveBlocker(): void {
    const hasAuthedPeer = [...this.peers.values()].some((p) => p.authed);
    if (hasAuthedPeer && this.powerSaveBlockerId == null) {
      this.powerSaveBlockerId = powerSaveBlocker.start('prevent-display-sleep');
    } else if (!hasAuthedPeer && this.powerSaveBlockerId != null) {
      powerSaveBlocker.stop(this.powerSaveBlockerId);
      this.powerSaveBlockerId = null;
    }
  }

  async generatePairingCode(): Promise<RemotePairingInfo> {
    if (!this.server || !this.hostIp) {
      throw new Error('Start hosting before generating a pairing code.');
    }
    const { token, expiresAt } = this.tokens.issue();
    const code = encodePairingCode({
      ip: this.hostIp,
      port: this.hostPort,
      token,
      deviceName: this.deviceName(),
      v: REMOTE_PROTOCOL_VERSION,
    });
    const qrDataUrl = await QRCode.toDataURL(code, {
      margin: 1,
      width: 320,
      errorCorrectionLevel: 'M',
    });
    this.pairing = { code, qrDataUrl, expiresAt };
    this.log('info', 'Generated a new one-time pairing code.');
    this.emitState();
    return this.pairing;
  }

  /** Host renderer reports the size of the surface it is capturing. */
  setScreenInfo(width: number, height: number): void {
    this.hostScreen = { width, height };
    for (const peer of this.peers.values()) {
      if (peer.authed) this.sendControl(peer.ws, { t: 'screen-info', width, height });
    }
  }

  /** Host renderer produced an encoded screen tile; fan it out to controllers. */
  hostTile(buffer: Uint8Array): void {
    let dropped = false;
    let consumers = 0;
    let maxBuffered = 0;
    for (const peer of this.peers.values()) {
      if (!peer.authed || !peer.wantsTiles) continue;
      consumers++;
      if (peer.ws.bufferedAmount < MAX_BUFFERED_BYTES) {
        peer.ws.send(buffer, { binary: true });
        if (peer.ws.bufferedAmount > maxBuffered) maxBuffered = peer.ws.bufferedAmount;
      } else {
        // Dropping beats queueing (a controller lagging seconds behind is
        // worse than a briefly stale region), but the peer now shows stale
        // pixels for every tile skipped here.
        dropped = true;
      }
    }
    if (dropped) {
      this.tileRefreshPending = true;
      return;
    }
    // Heal those stale regions as soon as every consumer's socket has drained,
    // instead of leaving them wrong until the renderer's slow safety refresh.
    if (this.tileRefreshPending && consumers > 0 && maxBuffered < TILE_HEAL_LOW_WATER) {
      const now = Date.now();
      if (now - this.lastTileHealAt >= TILE_HEAL_MIN_INTERVAL_MS) {
        this.tileRefreshPending = false;
        this.lastTileHealAt = now;
        this.send(IPC.remote.onCaptureRefresh);
      }
    }
  }

  /**
   * Renderer reports whether a peer's WebRTC video session is delivering.
   * Only then do tiles stop for that peer; when video drops, tiles resume and
   * a full refresh repaints everything the peer missed while on video.
   */
  setRtcPeerConnected(peerId: string, connected: boolean): void {
    const peer = this.peers.get(peerId);
    if (!peer?.authed) return;
    const wantsTiles = !connected;
    if (peer.wantsTiles === wantsTiles) return;
    peer.wantsTiles = wantsTiles;
    this.updateTileDemand();
    if (wantsTiles && this.capturing) this.send(IPC.remote.onCaptureRefresh);
  }

  /** Renderer produced a WebRTC signaling message for one specific peer. */
  rtcSignalToPeer(peerId: string, message: RemoteRtcMessage): void {
    const peer = this.peers.get(peerId);
    if (peer?.authed) this.sendControl(peer.ws, message);
  }

  /**
   * An input event that arrived over a peer's input DataChannel rather than the
   * control socket. Same authorization rule as the WebSocket path: the peer
   * must be authed, it just skips the head-of-line blocking that bulk data on
   * the control socket would impose.
   */
  applyRtcInput(peerId: string, event: RemoteInputEvent): void {
    const peer = this.peers.get(peerId);
    if (peer?.authed) this.injector.apply(event);
  }

  /**
   * Host renderer asks for OS cursor samples while it has a cursor DataChannel
   * open. Sampled here because cursor position is a main-process concern
   * (`screen`), then pushed to the renderer which owns the peer connections.
   */
  setCursorTracking(enabled: boolean): void {
    if (enabled === (this.cursorTimer !== null)) return;
    if (enabled) {
      this.cursorTimer = setInterval(() => this.sampleCursor(), CURSOR_SAMPLE_MS);
    } else {
      if (this.cursorTimer) clearInterval(this.cursorTimer);
      this.cursorTimer = null;
      this.lastCursor = null;
    }
  }

  private sampleCursor(): void {
    let x: number;
    let y: number;
    try {
      const point = screen.getCursorScreenPoint();
      // Normalized against the primary display, matching the surface the
      // capturer picks and the mapping InputInjector uses in reverse.
      const bounds = screen.getPrimaryDisplay().bounds;
      x = (point.x - bounds.x) / Math.max(1, bounds.width);
      y = (point.y - bounds.y) / Math.max(1, bounds.height);
    } catch {
      return; // display topology changing mid-sample; the next tick recovers
    }
    // A stationary cursor sends nothing, idle costs zero bandwidth.
    if (this.lastCursor && this.lastCursor.x === x && this.lastCursor.y === y) return;
    this.lastCursor = { x, y };
    this.send(IPC.remote.onHostCursor, {
      x,
      y,
      visible: x >= 0 && x <= 1 && y >= 0 && y <= 1,
    });
  }

  private onHostMessage(peer: HostPeer, data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    const msg = this.parseControl(data);
    if (!msg) return;
    if (
      peer.authed &&
      (this.files.handleControl(peer.ws, msg) || this.fmOps.handleControl(peer.ws, msg))
    ) {
      return;
    }
    switch (msg.t) {
      case 'hello':
        peer.deviceName = msg.deviceName || peer.address;
        peer.intent = msg.intent ?? 'control';
        if (peer.intent === 'files') peer.wantsTiles = false;
        break;
      case 'auth': {
        // A fresh pairing code pairs the device and mints a durable token for
        // it; a durable token from an earlier pairing reconnects directly.
        const paired = this.tokens.consume(msg.token);
        const known = paired ? null : this.tokens.validateDeviceToken(msg.token, peer.deviceName);
        if (paired || known) {
          peer.authed = true;
          const deviceToken = paired ? this.tokens.issueDeviceToken(peer.deviceName) : undefined;
          if (paired) this.pairing = null; // code was single-use
          if (peer.intent === 'control') {
            if (this.capturing) {
              // Capture is already streaming deltas; this newcomer needs every
              // tile once or it stares at a mostly-black screen.
              this.send(IPC.remote.onCaptureRefresh);
            }
            this.startCapture();
          }
          this.updateTileDemand();
          this.syncPowerSaveBlocker();
          this.sendControl(peer.ws, {
            t: 'auth-ok',
            deviceName: this.deviceName(),
            screen: this.hostScreen ?? { width: 0, height: 0 },
            ...(deviceToken ? { deviceToken } : {}),
          });
          this.log(
            'success',
            paired
              ? `${peer.deviceName} paired and is now controlling this machine.`
              : `${peer.deviceName} reconnected and is now controlling this machine.`,
          );
          this.emitState();
        } else {
          this.sendControl(peer.ws, { t: 'auth-fail', reason: 'Invalid or expired code' });
          this.log('warning', `Rejected a pairing attempt from ${peer.address} (bad code).`);
          this.safeClose(peer.ws, 'auth failed');
        }
        break;
      }
      case 'control-start':
        if (peer.authed && peer.intent === 'control') this.startCapture();
        break;
      case 'control-stop':
        break;
      case 'input':
        if (peer.authed) this.injector.apply(msg.event);
        break;
      case 'clipboard':
        if (peer.authed) {
          clipboard.writeText(msg.text);
          this.log('info', 'Clipboard received from controller.');
        }
        break;
      case 'ping':
        this.sendControl(peer.ws, { t: 'pong' });
        break;
      case 'rtc-request':
      case 'rtc-cancel':
      case 'rtc-answer':
      case 'rtc-ice':
        // WebRTC signaling is handled by the renderer (it owns the capture
        // MediaStream); the main process only relays, tagged with the peer id.
        // Tiles keep flowing throughout negotiation. They stop only when the
        // renderer confirms video is delivering (setRtcPeerConnected).
        if (peer.authed) {
          this.send(IPC.remote.onRtcSignal, { peerId: peer.id, message: msg });
          if (msg.t === 'rtc-cancel' && !peer.wantsTiles) {
            // Falling back from live video: resume tiles and repaint what the
            // peer missed while it was on the video track.
            peer.wantsTiles = true;
            this.updateTileDemand();
            this.send(IPC.remote.onCaptureRefresh);
          }
        }
        break;
      case 'display-size':
        // Only meaningful for a peer actually streaming video; harmless no-op
        // otherwise (e.g. a 'files' peer, which never negotiates WebRTC).
        if (peer.authed) {
          this.send(IPC.remote.onPeerDisplaySize, {
            peerId: peer.id,
            width: msg.width,
            height: msg.height,
          });
        }
        break;
      case 'bye':
        this.safeClose(peer.ws, 'peer said bye');
        break;
    }
  }

  private startCapture(): void {
    if (this.capturing) return;
    this.capturing = true;
    this.send(IPC.remote.onCaptureStart);
  }

  /**
   * Tell the renderer whether anyone still consumes JPEG tiles. When every
   * connected controller streams WebRTC video, the per-frame diff + JPEG
   * encode loop is pure wasted CPU that competes with the video encoder.
   */
  private updateTileDemand(): void {
    const demand = [...this.peers.values()].some((p) => p.authed && p.wantsTiles);
    if (demand !== this.tileDemand) {
      this.tileDemand = demand;
      this.send(IPC.remote.onTileDemand, demand);
    }
  }

  private onPeerGone(peer: HostPeer): void {
    if (!this.peers.has(peer.id)) return;
    this.peers.delete(peer.id);
    // We can't dial out to this peer, but its transfers just wait: if it
    // reconnects (a new peer, new ws) and re-sends file-offer/file-resume for
    // the same transferId, the file-transfer handlers rebind and resume.
    this.files.onConnectionLost(peer.ws);
    if (peer.authed) {
      this.send(IPC.remote.onRtcPeerGone, peer.id);
      this.log('info', `${peer.deviceName} disconnected.`);
    }
    const stillControlled = [...this.peers.values()].some((p) => p.authed);
    if (!stillControlled && this.capturing) {
      this.capturing = false;
      this.send(IPC.remote.onCaptureStop);
    }
    this.updateTileDemand();
    this.syncPowerSaveBlocker();
    this.emitState();
  }

  // --- Controller role ---------------------------------------------------------

  connect(
    payload: { ip: string; port: number; token: string; deviceName: string },
    intent: RemoteConnectIntent = 'control',
  ): void {
    this.disconnect();
    this.pendingConnect = payload;
    this.connectIntent = intent;
    this.reconnectAttempt = 0;
    this.dial(payload);
  }

  /**
   * Opens the socket and wires its handlers. Split out from `connect()` so
   * auto-reconnect (see `beginReconnect`) can redial without re-running
   * `connect()`'s teardown of the previous session, which would cancel the
   * very transfers reconnect exists to resume.
   */
  private dial(payload: { ip: string; port: number; token: string; deviceName: string }): void {
    this.connection = {
      status: 'connecting',
      remoteDeviceName: payload.deviceName,
      remoteScreen: null,
      intent: this.connectIntent,
    };
    this.emitState();

    const ws = new WebSocket(`ws://${payload.ip}:${payload.port}`);
    ws.binaryType = 'nodebuffer';
    this.client = ws;

    ws.on('open', () => {
      this.sendControl(ws, {
        t: 'hello',
        role: 'controller',
        deviceName: this.deviceName(),
        protocolVersion: REMOTE_PROTOCOL_VERSION,
        intent: this.connectIntent,
      });
      this.sendControl(ws, { t: 'auth', token: payload.token });
    });
    ws.on('message', (data, isBinary) => this.onClientMessage(data as Buffer, isBinary));
    ws.on('close', () => this.onClientGone(ws));
    ws.on('error', (err) => this.onClientGone(ws, err));
  }

  /**
   * The outbound socket closed or errored. If a file transfer is mid-flight,
   * this machine is the dialer, so it's the one that has to redial; treat
   * it as recoverable and start the reconnect backoff instead of giving up.
   */
  private onClientGone(ws: WebSocket, err?: Error): void {
    if (this.client !== ws) return; // already superseded by a newer socket
    this.client = null;
    if (this.pendingConnect && this.files.hasActiveTransfers()) {
      this.files.onConnectionLost(ws);
      this.connection = { ...this.connection, status: 'connecting' };
      this.log(
        'warning',
        err
          ? `Connection lost mid-transfer (${err.message}), reconnecting…`
          : 'Connection lost mid-transfer, reconnecting…',
      );
      this.emitState();
      this.beginReconnect();
      return;
    }
    if (err) {
      this.connection = {
        status: 'error',
        remoteDeviceName: this.connection.remoteDeviceName,
        remoteScreen: null,
        intent: this.connection.intent,
        error: err.message,
      };
      this.log('error', `Connection failed: ${err.message}`);
    } else {
      this.connection = {
        status: 'idle',
        remoteDeviceName: null,
        remoteScreen: null,
        intent: null,
      };
      this.log('info', 'Disconnected from remote host.');
    }
    this.emitState();
  }

  private beginReconnect(): void {
    if (!this.pendingConnect) return;
    if (this.reconnectAttempt === 0) this.reconnectDeadline = Date.now() + RECONNECT_GIVE_UP_MS;
    if (Date.now() > this.reconnectDeadline) {
      this.giveUpReconnect();
      return;
    }
    const delay =
      RECONNECT_DELAYS_MS[Math.min(this.reconnectAttempt, RECONNECT_DELAYS_MS.length - 1)];
    this.reconnectAttempt++;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (this.pendingConnect) this.dial(this.pendingConnect);
    }, delay);
  }

  private giveUpReconnect(): void {
    this.files.cancelAll('Gave up trying to reconnect.');
    this.connection = {
      status: 'error',
      remoteDeviceName: this.connection.remoteDeviceName,
      remoteScreen: null,
      intent: this.connectIntent,
      error: 'Could not reconnect to the host.',
    };
    this.pendingConnect = null;
    this.log('error', 'Could not reconnect to the host, giving up.');
    this.emitState();
  }

  openSessionWindow(): void {
    sessionWindow.open();
  }

  /**
   * Tears down the outbound connection only. Does NOT touch the session
   * window. Also called internally at the top of `connect()` to clear a
   * previous session before dialing a new one; closing the window here too
   * would race the window's own async 'closed' event against that new
   * connection (see `closeSessionAndDisconnect` for the window-closing path).
   */
  disconnect(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    this.files.cancelAll('Disconnected.');
    if (this.client) {
      this.safeClose(this.client, 'controller disconnected');
      this.client = null;
    }
    this.connection = { status: 'idle', remoteDeviceName: null, remoteScreen: null, intent: null };
    this.pendingConnect = null;
    this.emitState();
  }

  /** The user-facing "Disconnect": ends the connection and closes its window. */
  closeSessionAndDisconnect(): void {
    this.disconnect();
    sessionWindow.close();
  }

  // --- Saved servers (controller role) -----------------------------------------

  async listSavedServers(): Promise<RemoteSavedServer[]> {
    const servers = await store.getRemoteServers();
    return [...servers].sort((a, b) => b.lastConnectedAt - a.lastConnectedAt);
  }

  async connectSaved(
    id: string,
    intent: RemoteConnectIntent = 'control',
  ): Promise<{ ok: boolean; error?: string }> {
    const servers = await store.getRemoteServers();
    const server = servers.find((s) => s.id === id);
    if (!server) return { ok: false, error: 'That saved server no longer exists.' };
    this.connect(
      {
        ip: server.ip,
        port: server.port,
        token: server.deviceToken,
        deviceName: server.deviceName,
      },
      intent,
    );
    return { ok: true };
  }

  async renameSavedServer(id: string, nickname: string): Promise<void> {
    const servers = await store.getRemoteServers();
    const idx = servers.findIndex((s) => s.id === id);
    if (idx < 0) return;
    servers[idx] = { ...servers[idx], nickname };
    await store.setRemoteServers(servers);
  }

  async removeSavedServer(id: string): Promise<void> {
    const servers = await store.getRemoteServers();
    await store.setRemoteServers(servers.filter((s) => s.id !== id));
  }

  /**
   * Persists (or refreshes) a saved-server entry once a connection succeeds.
   * A fresh `deviceToken` means we just paired for the first time; a reconnect
   * via an already-saved token gets none (the host doesn't reissue), so the
   * existing token is kept and only `lastConnectedAt` moves.
   */
  private async rememberServer(freshDeviceToken?: string): Promise<void> {
    const pending = this.pendingConnect;
    if (!pending) return;
    const token = freshDeviceToken ?? pending.token;
    const servers = await store.getRemoteServers();
    const idx = servers.findIndex(
      (s) => s.ip === pending.ip && s.port === pending.port && s.deviceName === pending.deviceName,
    );
    const now = Date.now();
    if (idx >= 0) {
      servers[idx] = { ...servers[idx], deviceToken: token, lastConnectedAt: now };
    } else if (freshDeviceToken) {
      servers.push({
        id: randomUUID(),
        nickname: pending.deviceName,
        ip: pending.ip,
        port: pending.port,
        deviceName: pending.deviceName,
        deviceToken: freshDeviceToken,
        createdAt: now,
        lastConnectedAt: now,
      });
    } else {
      return; // no durable token to save and no existing entry to refresh
    }
    await store.setRemoteServers(servers);
  }

  sendInput(event: RemoteInputEvent): void {
    if (this.client && this.connection.status === 'connected') {
      this.sendControl(this.client, { t: 'input', event });
    }
  }

  /** Controller role: reports the video display box's physical-pixel size so the host can match encode resolution to it. */
  setDisplaySize(width: number, height: number): void {
    if (this.client && this.connection.status === 'connected') {
      this.sendControl(this.client, { t: 'display-size', width, height });
    }
  }

  /**
   * Controller role: the renderer owns the RTCPeerConnection (it must, to
   * render the video track), so main relays its signaling to the host over the
   * control socket, mirroring what `rtcSignalToPeer` does on the host side.
   */
  sendClientRtcSignal(message: RemoteRtcMessage): void {
    if (this.client && this.connection.status === 'connected') {
      this.sendControl(this.client, message);
    }
  }

  private onClientMessage(data: Buffer, isBinary: boolean): void {
    if (isBinary) {
      this.onBinary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
      return;
    }
    const msg = this.parseControl(data);
    if (!msg) return;
    if (
      this.client &&
      (this.files.handleControl(this.client, msg) || this.fmOps.handleControl(this.client, msg))
    ) {
      return;
    }
    switch (msg.t) {
      case 'auth-ok': {
        const wasReconnect = this.reconnectAttempt > 0;
        this.reconnectAttempt = 0;
        this.connection = {
          status: 'connected',
          remoteDeviceName: msg.deviceName,
          remoteScreen: msg.screen.width ? msg.screen : null,
          intent: this.connectIntent,
        };
        if (this.client && this.connectIntent === 'control') {
          this.sendControl(this.client, { t: 'control-start' });
        }
        if (msg.screen.width) this.send(IPC.remote.onScreenInfo, msg.screen);
        this.log(
          'success',
          wasReconnect ? `Reconnected to ${msg.deviceName}.` : `Connected to ${msg.deviceName}.`,
        );
        // A fresh pairing code is single-use; once the host issues a durable
        // device token, switch to it so a later auto-reconnect redials with a
        // credential the host will still accept, instead of the already-spent code.
        if (msg.deviceToken && this.pendingConnect) {
          this.pendingConnect = { ...this.pendingConnect, token: msg.deviceToken };
        }
        void this.rememberServer(msg.deviceToken);
        if (this.client) this.files.resumeAfterReconnect(this.client);
        sessionWindow.setTitle(`Runova Remote - ${msg.deviceName}`);
        this.emitState();
        break;
      }
      case 'auth-fail':
        this.connection = {
          status: 'error',
          remoteDeviceName: this.connection.remoteDeviceName,
          remoteScreen: null,
          intent: this.connection.intent,
          error: msg.reason,
        };
        this.log('error', `Pairing rejected: ${msg.reason}`);
        this.emitState();
        break;
      case 'screen-info':
        this.connection = {
          ...this.connection,
          remoteScreen: { width: msg.width, height: msg.height },
        };
        this.send(IPC.remote.onScreenInfo, { width: msg.width, height: msg.height });
        this.emitState();
        break;
      case 'clipboard':
        clipboard.writeText(msg.text);
        this.log('info', 'Clipboard received from host.');
        break;
      case 'pong':
        break;
      case 'rtc-offer':
      case 'rtc-ice':
      case 'rtc-unavailable':
        // Relayed to the renderer, which owns the peer connection and paints
        // the resulting video track (see lib/rtcController.ts).
        this.send(IPC.remote.onClientRtcSignal, msg);
        break;
      case 'bye':
        this.disconnect();
        break;
    }
  }

  // --- Shared: clipboard, files, binary ---------------------------------------

  /** Send this machine's clipboard text to whichever peer(s) are connected. */
  sendClipboard(): void {
    const text = clipboard.readText();
    if (!text) return;
    if (this.client && this.connection.status === 'connected') {
      this.sendControl(this.client, { t: 'clipboard', text });
    }
    for (const peer of this.peers.values()) {
      if (peer.authed) this.sendControl(peer.ws, { t: 'clipboard', text });
    }
    this.log('info', 'Clipboard sent.');
  }

  /** Snapshot of in-flight/recent transfers, for a newly-opened file-manager window to populate its list from. */
  getFileProgress(): RemoteFileProgress[] {
    return this.files.listProgress();
  }

  /** Prompt for a file and send it to the connected peer's default downloads folder. */
  async sendFile(): Promise<void> {
    const target = this.pickTransferTarget();
    if (!target) {
      this.log('warning', 'No active connection to send a file to.');
      return;
    }
    const picked = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (picked.canceled || picked.filePaths.length === 0) return;
    await this.files.startUpload(target, picked.filePaths[0]);
  }

  /** Remote file manager: prompt for a local file and upload it into a specific remote folder. */
  async uploadFileTo(destDir: string): Promise<void> {
    const picked = await dialog.showOpenDialog({ properties: ['openFile'] });
    if (picked.canceled || picked.filePaths.length === 0) return;
    await this.files.startUpload(this.requireTarget(), picked.filePaths[0], destDir);
  }

  /** Remote file manager: ask the peer to push a file it has at `path`. */
  async downloadFile(path: string): Promise<void> {
    await this.fmOps.requestFile(this.requireTarget(), path);
  }

  fmRoots() {
    return this.fmOps.roots(this.requireTarget());
  }

  fmList(path: string | null) {
    return this.fmOps.list(this.requireTarget(), path);
  }

  fmMkdir(parentPath: string, name: string): Promise<void> {
    return this.fmOps.mkdir(this.requireTarget(), parentPath, name);
  }

  fmDelete(path: string): Promise<void> {
    return this.fmOps.delete(this.requireTarget(), path);
  }

  fmRename(path: string, newName: string): Promise<void> {
    return this.fmOps.rename(this.requireTarget(), path, newName);
  }

  private pickTransferTarget(): WebSocket | null {
    if (this.client && this.connection.status === 'connected') return this.client;
    for (const peer of this.peers.values()) if (peer.authed) return peer.ws;
    return null;
  }

  private requireTarget(): WebSocket {
    const target = this.pickTransferTarget();
    if (!target) throw new Error('No active connection.');
    return target;
  }

  private onBinary(buf: Uint8Array): void {
    const kind = binaryKind(buf);
    if (kind === BIN_SCREEN_TILE) {
      // Controller side: hand the raw tile to the renderer to paint.
      this.send(IPC.remote.onFrameTile, buf);
      return;
    }
    this.files.handleBinary(buf);
  }

  // --- Plumbing ----------------------------------------------------------------

  private sendControl(ws: WebSocket, msg: RemoteControlMessage): void {
    if (ws.readyState === WebSocket.OPEN) ws.send(JSON.stringify(msg));
  }

  private sendBinary(ws: WebSocket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
      if (ws.readyState !== WebSocket.OPEN) {
        reject(new Error('socket closed'));
        return;
      }
      ws.send(data, { binary: true }, (err) => (err ? reject(err) : resolve()));
    });
  }

  private parseControl(data: Buffer): RemoteControlMessage | null {
    try {
      return JSON.parse(data.toString('utf-8')) as RemoteControlMessage;
    } catch {
      return null;
    }
  }

  private safeClose(ws: WebSocket, reason: string): void {
    try {
      this.sendControl(ws, { t: 'bye', reason });
      ws.close();
    } catch {
      // already closed
    }
  }

  /**
   * Broadcasts to the main window and, when open, the standalone session
   * window. Both run their own copy of the renderer bundle and may each have
   * listeners for state/log/frame/signaling events.
   */
  private send(channel: string, payload?: unknown): void {
    for (const target of [this.mainWindow, sessionWindow.get()]) {
      sendToWindow(target, channel, payload);
    }
  }

  private emitState(): void {
    this.send(IPC.remote.onState, this.getState());
  }

  private emitFileProgress(progress: RemoteFileProgress): void {
    this.send(IPC.remote.onFileProgress, progress);
  }

  private log(level: RemoteLogLevel, message: string): void {
    this.send(IPC.remote.onLog, { level, message, at: Date.now() });
  }

  shutdown(): void {
    this.disconnect();
    this.stopHost();
  }
}

export const remoteManager = new RemoteManager();
