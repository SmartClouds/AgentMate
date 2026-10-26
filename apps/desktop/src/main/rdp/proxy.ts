import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import type { TLSSocket } from 'node:tls';
import { type RawData, type WebSocket, WebSocketServer } from 'ws';
import type { RdpCertificateInfo, RdpFailureInfo, RdpLinkStats } from '../../shared/apiTypes';
import { type HandshakeDeps, handshake, toFailureInfo } from './handshake';
import { LinkMeter } from './linkMeter';
import {
  buildRdCleanPathError,
  buildRdCleanPathResponse,
  destinationMatches,
  parseRdCleanPathRequest,
} from './rdcleanpath';

/**
 * A loopback-only WebSocket to TCP bridge for the RDP session windows. The IronRDP engine runs
 * in a sandboxed renderer, which can't open sockets, so it hands this proxy an RDCleanPath
 * request and the proxy does the TCP connect and TLS upgrade on its behalf.
 *
 * It is not an open relay: every connection needs a one-time token minted for a single saved
 * server, and the destination in the request has to be that server's host and port.
 */

const TICKET_TTL_MS = 60_000;
/** Stop reading from the server while this much is still queued for the renderer. */
const HIGH_WATER_BYTES = 8 * 1024 * 1024;

export interface RdpProxyTarget {
  sessionId: string;
  host: string;
  port: number;
  /** The certificate fingerprint saved last time, if any. */
  expectedFingerprint?: string;
}

export interface RdpProxyHooks {
  /** First connect to this server: remember its certificate. */
  onCertificateFirstSeen: (target: RdpProxyTarget, cert: RdpCertificateInfo) => void;
  /** The certificate changed. The connection is refused; the window asks whether to trust it. */
  onCertificateMismatch: (target: RdpProxyTarget, cert: RdpCertificateInfo) => void;
  onConnected: (target: RdpProxyTarget) => void;
  onError: (target: RdpProxyTarget, failure: RdpFailureInfo) => void;
}

interface Ticket {
  target: RdpProxyTarget;
  expiresAt: number;
}

function toBuffer(data: RawData): Buffer {
  if (Buffer.isBuffer(data)) return data;
  if (Array.isArray(data)) return Buffer.concat(data);
  return Buffer.from(data);
}

export class RdpProxy {
  private server: WebSocketServer | null = null;
  private port = 0;
  private starting: Promise<void> | null = null;
  private readonly tickets = new Map<string, Ticket>();
  private readonly live = new Map<string, Set<() => void>>();
  /** The traffic of each session's current connection. A reconnect replaces its meter. */
  private readonly meters = new Map<string, LinkMeter>();

  /** `deps` stands in for the network in tests. */
  constructor(
    private readonly hooks: RdpProxyHooks,
    private readonly deps?: HandshakeDeps,
  ) {}

  /** A `ws://` URL that lets one connection through to `target`, within the next minute. */
  async issueUrl(target: RdpProxyTarget): Promise<string> {
    await this.ensureStarted();
    this.pruneTickets();
    const token = randomBytes(32).toString('hex');
    this.tickets.set(token, { target, expiresAt: Date.now() + TICKET_TTL_MS });
    return `ws://127.0.0.1:${this.port}/${token}`;
  }

  /** Drops any unused tickets and open connections for a session (its window closed). */
  closeSession(sessionId: string): void {
    for (const [token, ticket] of this.tickets) {
      if (ticket.target.sessionId === sessionId) this.tickets.delete(token);
    }
    for (const close of this.live.get(sessionId) ?? []) close();
    this.live.delete(sessionId);
  }

  get activeSessionCount(): number {
    return this.live.size;
  }

  /** Speed and answer time of a session's open connection, or null when it has none. */
  linkStats(sessionId: string): RdpLinkStats | null {
    return this.meters.get(sessionId)?.snapshot() ?? null;
  }

  shutdown(): void {
    for (const sessionId of [...this.live.keys()]) this.closeSession(sessionId);
    this.tickets.clear();
    this.server?.close();
    this.server = null;
    this.starting = null;
  }

  private pruneTickets(): void {
    const now = Date.now();
    for (const [token, ticket] of this.tickets) {
      if (ticket.expiresAt < now) this.tickets.delete(token);
    }
  }

  private ensureStarted(): Promise<void> {
    if (this.server) return Promise.resolve();
    if (this.starting) return this.starting;
    this.starting = new Promise<void>((resolve, reject) => {
      const server = new WebSocketServer({
        host: '127.0.0.1',
        port: 0,
        maxPayload: 64 * 1024 * 1024,
      });
      server.once('listening', () => {
        this.server = server;
        this.port = (server.address() as AddressInfo).port;
        resolve();
      });
      server.once('error', (error) => {
        this.starting = null;
        reject(error);
      });
      server.on('connection', (ws, request) => {
        const token = (request.url ?? '').replace(/^\//, '');
        const ticket = this.tickets.get(token);
        this.tickets.delete(token);
        if (!ticket || ticket.expiresAt < Date.now()) {
          ws.close(1008, 'Invalid or expired session token');
          return;
        }
        this.handle(ws, ticket.target);
      });
    });
    return this.starting;
  }

  private handle(ws: WebSocket, target: RdpProxyTarget): void {
    const { host, port } = target;
    const sendError = (failure: RdpFailureInfo, httpStatus = 502): void => {
      this.hooks.onError(target, failure);
      try {
        ws.send(buildRdCleanPathError(1, httpStatus));
      } catch {
        // The window may already be gone.
      }
      ws.close();
    };

    ws.once('message', async (data) => {
      let request: ReturnType<typeof parseRdCleanPathRequest>;
      try {
        request = parseRdCleanPathRequest(toBuffer(data));
      } catch (error) {
        sendError(
          {
            code: 'other',
            message: 'The session sent a request Runova did not understand.',
            detail: (error as Error).message,
          },
          400,
        );
        return;
      }
      if (!destinationMatches(request.destination, host, port)) {
        sendError(
          {
            code: 'other',
            message: 'The session asked for a different server than the one it was opened for.',
          },
          403,
        );
        return;
      }

      let result: Awaited<ReturnType<typeof handshake>>;
      try {
        result = await handshake(host, port, request.x224ConnectionRequest, this.deps);
      } catch (error) {
        sendError(toFailureInfo(error, host, port));
        return;
      }

      if (ws.readyState !== ws.OPEN) {
        result.tlsSocket.destroy();
        return;
      }

      const { cert } = result;
      if (!target.expectedFingerprint) {
        this.hooks.onCertificateFirstSeen(target, cert);
      } else if (target.expectedFingerprint !== cert.fingerprint) {
        result.tlsSocket.destroy();
        this.hooks.onCertificateMismatch(target, cert);
        this.hooks.onError(target, {
          code: 'certificate-changed',
          message: `${host} is presenting a different certificate than the one Runova saved.`,
        });
        try {
          ws.send(buildRdCleanPathError(1, 403));
        } catch {
          // Ignore, the window shows the certificate prompt either way.
        }
        ws.close();
        return;
      }

      ws.send(buildRdCleanPathResponse(result.address, result.x224Response, result.chain));
      this.relay(ws, result.tlsSocket, target);
      this.hooks.onConnected(target);
    });
  }

  private relay(ws: WebSocket, tlsSocket: TLSSocket, target: RdpProxyTarget): void {
    const meter = new LinkMeter();
    this.meters.set(target.sessionId, meter);

    let closed = false;
    const close = (): void => {
      if (closed) return;
      closed = true;
      tlsSocket.destroy();
      if (ws.readyState === ws.OPEN || ws.readyState === ws.CONNECTING) ws.close();
      const set = this.live.get(target.sessionId);
      set?.delete(close);
      if (set && set.size === 0) this.live.delete(target.sessionId);
      // A reconnect may already have put its own meter here.
      if (this.meters.get(target.sessionId) === meter) this.meters.delete(target.sessionId);
    };

    let set = this.live.get(target.sessionId);
    if (!set) {
      set = new Set();
      this.live.set(target.sessionId, set);
    }
    set.add(close);

    tlsSocket.on('data', (chunk: Buffer) => {
      if (ws.readyState !== ws.OPEN) return;
      meter.recordDown(chunk.length);
      ws.send(chunk, () => {
        if (tlsSocket.isPaused() && ws.bufferedAmount < HIGH_WATER_BYTES / 2) tlsSocket.resume();
      });
      if (ws.bufferedAmount > HIGH_WATER_BYTES) tlsSocket.pause();
    });
    ws.on('message', (data) => {
      if (tlsSocket.destroyed) return;
      const chunk = toBuffer(data);
      meter.recordUp(chunk.length);
      if (!tlsSocket.write(chunk)) {
        ws.pause();
        tlsSocket.once('drain', () => ws.resume());
      }
    });

    tlsSocket.on('end', close);
    tlsSocket.on('close', close);
    tlsSocket.on('error', close);
    ws.on('close', close);
    ws.on('error', close);
  }
}
