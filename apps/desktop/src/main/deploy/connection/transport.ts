import { connect } from 'node:net';
import type { Duplex } from 'node:stream';
import { quoteForShell } from '@runova/core';
import { type SshConnection, TunnelRefusedError } from '../../ssh/connection';
import { LEGACY_CORE, RUNOVA_CORE } from '../coreLayout';
import { asSocket, type SocketLike } from './socketShim';

/** Where the installer puts the core on a new server. */
export const CORE_SOCKET_PATH = RUNOVA_CORE.socketPath;
export const CORE_BINARY_PATH = RUNOVA_CORE.binaryPath;

/**
 * Where a core listens, the new layout first. A server set up before the rename has only the old
 * socket until its core migrates, and keeps the old path as a link afterwards.
 */
export const CORE_SOCKET_PATHS: readonly string[] = [
  RUNOVA_CORE.socketPath,
  LEGACY_CORE.socketPath,
];

export type CoreTransportKind = 'streamlocal' | 'bridge' | 'dev-tcp' | 'direct-tls';

/** A way to open a fresh byte stream to the core's HTTP listener. */
export interface CoreTransport {
  kind: CoreTransportKind;
  openStream: () => Promise<Duplex & SocketLike>;
  /**
   * The Host header to send. A core from before the rename only answers to its old name and
   * every newer one takes both, so the old name goes out until the transport knows the core is
   * newer. Left out, the old name is used.
   */
  host?: () => string;
}

/** The part of an SSH connection the transports need, so tests can hand in a fake. */
export type TunnelSource = Pick<SshConnection, 'openStream' | 'openExecStream'>;

/** Which socket answered on each connection, so only its first stream tries the other one. */
const answeringSocket = new WeakMap<TunnelSource, string>();

/** The host a core behind `socketPath` answers to: only a new core listens on the new socket. */
function hostBehind(socketPath: string | undefined): string {
  return socketPath === RUNOVA_CORE.socketPath ? RUNOVA_CORE.host : LEGACY_CORE.host;
}

/**
 * A stream-local tunnel through sshd straight to the core's Unix socket. Given no path, it tries
 * the new layout's socket and then the old one, and remembers per connection which one answered.
 */
export function streamLocalTransport(source: TunnelSource, socketPath?: string): CoreTransport {
  const openAt = async (path: string) => asSocket(await source.openStream({ socketPath: path }));
  return {
    kind: 'streamlocal',
    openStream: async () => {
      if (socketPath) return openAt(socketPath);
      const known = answeringSocket.get(source);
      const order = known
        ? [known, ...CORE_SOCKET_PATHS.filter((path) => path !== known)]
        : CORE_SOCKET_PATHS;
      let first: unknown = null;
      for (const path of order) {
        try {
          const stream = await openAt(path);
          answeringSocket.set(source, path);
          return stream;
        } catch (error) {
          // A missing socket and a forbidden tunnel look alike from OpenSSH, so both mean "try
          // the next one"; anything else (a dropped connection) does not.
          if (!(error instanceof TunnelRefusedError)) throw error;
          first ??= error;
        }
      }
      throw first;
    },
    host: () => hostBehind(socketPath ?? answeringSocket.get(source)),
  };
}

/**
 * The core's own stdio bridge over an exec channel, for servers whose sshd forbids stream-local
 * forwarding. The bridge runs as the SSH user, who reaches the socket through the core's group.
 * It runs the new program when it is there and the old one otherwise; given no socket, the
 * program uses its own layout's.
 */
export function bridgeTransport(source: TunnelSource, socketPath?: string): CoreTransport {
  const socket = socketPath ? ` --socket ${quoteForShell(socketPath, 'posix')}` : '';
  // Through sh, whatever the login shell is.
  const command = `sh -c ${quoteForShell(`p=${RUNOVA_CORE.binaryPath}; [ -x "$p" ] || p=${LEGACY_CORE.binaryPath}; exec "$p" bridge${socket}`, 'posix')}`;
  return {
    kind: 'bridge',
    openStream: async () => asSocket(await source.openExecStream(command)),
    host: () => hostBehind(socketPath),
  };
}

/** Loopback TCP to the DevHost. Only development builds offer it (see `devCore.ts`). */
export function devTcpTransport(port: number, host = '127.0.0.1'): CoreTransport {
  return {
    kind: 'dev-tcp',
    openStream: () =>
      new Promise((resolve, reject) => {
        const socket = connect({ host, port });
        socket.once('connect', () => resolve(socket));
        socket.once('error', (error) =>
          reject(new Error(`Could not reach the DevHost on ${host}:${port}: ${error.message}`)),
        );
      }),
    // The DevHost is always built from this checkout.
    host: () => RUNOVA_CORE.host,
  };
}
