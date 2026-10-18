import { readFile } from 'node:fs/promises';
import { Client, type ConnectConfig } from 'ssh2';
import type { SshAuthMethod } from '../../shared/apiTypes';
import { encodeSshError } from '../../shared/sshErrors';

/**
 * How every SSH connection in the app is opened: terminal sessions, and the Deploy section's
 * exec, upload and tunnel connections. Host keys are trusted on first use and pinned after that;
 * a changed key is refused with a coded error so the renderer can ask the user what to do.
 */

export interface SshEndpoint {
  host: string;
  port: number;
  username: string;
  authMethod: SshAuthMethod;
  password?: string;
  privateKeyPath?: string;
  passphrase?: string;
  /** Previously trusted host key fingerprint (SHA256, hex), if any. */
  storedFingerprint?: string;
}

/** What the handshake learned about the host key. */
export interface HostKeyVerdict {
  /** Set on a first connect: the fingerprint the caller should now store. */
  trustedFingerprint: string | null;
  /** Set when the server presented a different key from the stored one. */
  mismatch: { stored: string; presented: string } | null;
}

export class HostKeyChangedError extends Error {
  readonly stored: string;
  readonly presented: string;

  constructor(host: string, port: number, mismatch: { stored: string; presented: string }) {
    super(
      encodeSshError(
        'host-key-changed',
        `The host key for ${host}:${port} has changed since you last connected. If you did not ` +
          'reinstall or replace this server, treat this as a possible security warning.',
      ),
    );
    this.name = 'HostKeyChangedError';
    this.stored = mismatch.stored;
    this.presented = mismatch.presented;
  }
}

const READY_TIMEOUT_MS = 15_000;

export async function buildConnectConfig(
  endpoint: SshEndpoint,
  extra: Partial<ConnectConfig> = {},
): Promise<{ config: ConnectConfig; verdict: HostKeyVerdict }> {
  const privateKey =
    endpoint.authMethod === 'privateKey' && endpoint.privateKeyPath
      ? await readFile(endpoint.privateKeyPath)
      : undefined;
  const verdict: HostKeyVerdict = { trustedFingerprint: null, mismatch: null };

  const config: ConnectConfig = {
    host: endpoint.host,
    port: endpoint.port,
    username: endpoint.username,
    password: endpoint.authMethod === 'password' ? endpoint.password : undefined,
    privateKey,
    passphrase: endpoint.authMethod === 'privateKey' ? endpoint.passphrase : undefined,
    readyTimeout: READY_TIMEOUT_MS,
    hostHash: 'sha256',
    hostVerifier: (fingerprint: string): boolean => {
      if (!endpoint.storedFingerprint) {
        verdict.trustedFingerprint = fingerprint;
        return true;
      }
      if (fingerprint === endpoint.storedFingerprint) return true;
      verdict.mismatch = { stored: endpoint.storedFingerprint, presented: fingerprint };
      return false;
    },
    ...extra,
  };
  return { config, verdict };
}

/** Turns an ssh2 connect failure into something a user, not a protocol log, can read. */
export function friendlyConnectError(
  error: NodeJS.ErrnoException & { level?: string },
  endpoint: Pick<SshEndpoint, 'host' | 'port'>,
  verdict: HostKeyVerdict,
): Error {
  const { host, port } = endpoint;
  if (verdict.mismatch) return new HostKeyChangedError(host, port, verdict.mismatch);
  if (error.level === 'client-authentication') {
    return new Error('Authentication failed. Check the username, password, or private key.');
  }
  if (error.code === 'ENOTFOUND' || error.code === 'ECONNREFUSED') {
    return new Error(`Could not reach ${host}:${port}.`);
  }
  // ssh2's own deadline (`readyTimeout`) for a server that connects but never finishes the login.
  if (error.code === 'ETIMEDOUT' || error.level === 'client-timeout') {
    return new Error(`Connection to ${host}:${port} timed out.`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/**
 * The server's host key fingerprint, read from the handshake alone. The probe refuses the key
 * on purpose, so it never gets as far as authenticating.
 */
export function probeHostKey(
  host: string,
  port: number,
  timeoutMs = READY_TIMEOUT_MS,
): Promise<string> {
  return new Promise((resolve, reject) => {
    const client = new Client();
    let presented: string | null = null;
    const finish = (error?: Error): void => {
      client.end();
      if (presented) resolve(presented);
      else
        reject(
          friendlyConnectError(
            error ?? new Error('The server never sent a host key.'),
            { host, port },
            {
              trustedFingerprint: null,
              mismatch: null,
            },
          ),
        );
    };
    client.on('error', (error) => finish(error));
    client.on('ready', () => finish());
    client.connect({
      host,
      port,
      username: 'agentmate-host-key-probe',
      readyTimeout: timeoutMs,
      hostHash: 'sha256',
      hostVerifier: (fingerprint: string): boolean => {
        presented = fingerprint;
        return false;
      },
    });
  });
}
