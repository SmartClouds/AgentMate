import { createHash } from 'node:crypto';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StringDecoder } from 'node:string_decoder';
import type { TerminalSnapshot } from '../../shared/apiTypes';

/**
 * Bump whenever a message changes shape. A host speaking another version is never
 * talked to beyond `hello` and `shutdown`, which have to stay the same forever so a
 * newer app can always retire an older host it can no longer drive.
 */
export const PTY_HOST_PROTOCOL_VERSION = 1;

/** Upper bound on one framed line. A snapshot of a busy terminal is far below this. */
export const MAX_LINE_BYTES = 16 * 1024 * 1024;

export interface PtyHostPaths {
  runtimeDir: string;
  endpoint: string;
  tokenFile: string;
  logFile: string;
}

/** Names the endpoint is built from. Hosts started before the rename used the old ones. */
export interface PtyEndpointNames {
  pipePrefix: string;
  socketPrefix: string;
}

export const PTY_ENDPOINT_NAMES: PtyEndpointNames = {
  pipePrefix: 'runova-pty-host-',
  socketPrefix: 'runova-pty-',
};

export function ptyHostPaths(
  userDataDir: string,
  names: PtyEndpointNames = PTY_ENDPOINT_NAMES,
): PtyHostPaths {
  const runtimeDir = join(userDataDir, 'pty-host');
  const suffix = createHash('sha256').update(userDataDir).digest('hex').slice(0, 12);
  let endpoint: string;
  if (process.platform === 'win32') {
    endpoint = `\\\\.\\pipe\\${names.pipePrefix}${suffix}`;
  } else {
    // Unix socket paths are capped at 104 bytes on macOS (108 on Linux), which a long
    // user name inside "Application Support" can blow past.
    const preferred = join(runtimeDir, 'host.sock');
    endpoint =
      Buffer.byteLength(preferred) < 100
        ? preferred
        : join(tmpdir(), `${names.socketPrefix}${suffix}.sock`);
  }
  return {
    runtimeDir,
    endpoint,
    tokenFile: join(runtimeDir, 'token'),
    logFile: join(runtimeDir, 'host.log'),
  };
}

export interface SpawnSessionOptions {
  sessionId: string;
  shell: string;
  cwd?: string;
  cols?: number;
  rows?: number;
  env?: Record<string, string>;
  initialInput?: string;
  projectId?: string;
}

export interface CreateOrAttachPayload extends SpawnSessionOptions {
  /** Only reconnect to a session that is already running; never start a new shell. */
  attachOnly?: boolean;
}

export interface CreateOrAttachResult {
  isNew: boolean;
  snapshot: TerminalSnapshot | null;
}

export interface HostSessionInfo {
  sessionId: string;
  projectId?: string;
  createdAt: number;
  pid: number;
}

export interface HelloResult {
  protocolVersion: number;
  appVersion: string;
  pid: number;
  sessionCount: number;
}

export type HostRequest =
  | { type: 'hello'; token: string; protocolVersion: number }
  | { type: 'createOrAttach'; payload: CreateOrAttachPayload }
  | { type: 'write'; payload: { sessionId: string; data: string } }
  | { type: 'resize'; payload: { sessionId: string; cols: number; rows: number } }
  | { type: 'kill'; payload: { sessionId: string } }
  | { type: 'list' }
  | { type: 'shutdown'; payload: { killSessions: boolean } };

/** A request with no `id` is fire-and-forget: the host never answers it. */
export type HostRequestEnvelope = HostRequest & { id?: number };

export type HostMessage =
  | { kind: 'response'; id: number; ok: true; result?: unknown }
  | { kind: 'response'; id: number; ok: false; error: string }
  | { kind: 'event'; event: 'data'; sessionId: string; data: string }
  | { kind: 'event'; event: 'exit'; sessionId: string; exitCode: number };

/** Splits a byte stream into newline-delimited JSON messages. */
export function createLineReader(onMessage: (message: unknown) => void, onOverflow: () => void) {
  let buffered = '';
  // A pipe chunk can end partway through a multi-byte character. Decoding each chunk on its own
  // turned that character into two or three replacement characters, which pushed the rest of a
  // terminal line over by as many columns. The decoder holds the partial bytes for the next chunk.
  const decoder = new StringDecoder('utf8');
  return (chunk: Buffer | string): void => {
    buffered += typeof chunk === 'string' ? chunk : decoder.write(chunk);
    let newline = buffered.indexOf('\n');
    while (newline !== -1) {
      const line = buffered.slice(0, newline);
      buffered = buffered.slice(newline + 1);
      if (line.trim()) {
        try {
          onMessage(JSON.parse(line));
        } catch {
          // a malformed line is dropped rather than tearing the connection down
        }
      }
      newline = buffered.indexOf('\n');
    }
    if (buffered.length > MAX_LINE_BYTES) {
      buffered = '';
      onOverflow();
    }
  };
}

export function encodeLine(message: unknown): string {
  return `${JSON.stringify(message)}\n`;
}
