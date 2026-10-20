import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { sshErrorCode } from '../../shared/sshErrors';
import { tempDir } from '../../test/main/fixtures';
import {
  buildConnectConfig,
  friendlyConnectError,
  HostKeyChangedError,
  probeHostKey,
  type SshEndpoint,
} from './connectConfig';
import { type FakeSshServer, startFakeSshServer } from './testing/fakeSshServer';

/**
 * The connect options every SSH connection in the app uses: terminal sessions, and the Deploy
 * section's exec, upload and tunnel connections. One place decides how host keys are trusted.
 */

const endpoint: SshEndpoint = {
  host: 'example.test',
  port: 2222,
  username: 'deploy',
  authMethod: 'password',
  password: 'pw',
};

let server: FakeSshServer | null = null;

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('buildConnectConfig', () => {
  it('logs in with the password and verifies the host by SHA-256', async () => {
    const { config } = await buildConnectConfig(endpoint);

    expect(config).toMatchObject({
      host: 'example.test',
      port: 2222,
      username: 'deploy',
      password: 'pw',
      hostHash: 'sha256',
      readyTimeout: 15_000,
    });
    expect(config.privateKey).toBeUndefined();
    expect(config.passphrase).toBeUndefined();
  });

  it('reads the private key file and uses the passphrase for key logins', async () => {
    const keyPath = join(tempDir(), 'id_ed25519');
    writeFileSync(keyPath, 'PRIVATE KEY BYTES');

    const { config } = await buildConnectConfig({
      ...endpoint,
      authMethod: 'privateKey',
      privateKeyPath: keyPath,
      passphrase: 'unlock',
      password: 'must not be sent',
    });

    expect(config.privateKey?.toString()).toBe('PRIVATE KEY BYTES');
    expect(config.passphrase).toBe('unlock');
    expect(config.password).toBeUndefined();
  });

  it('passes extra options through, such as keepalive for pooled connections', async () => {
    const { config } = await buildConnectConfig(endpoint, { keepaliveInterval: 15_000 });

    expect(config.keepaliveInterval).toBe(15_000);
  });

  it('trusts an unknown host on first use and remembers what it saw', async () => {
    const { config, verdict } = await buildConnectConfig(endpoint);
    const verify = config.hostVerifier as (fingerprint: string) => boolean;

    expect(verify('ab'.repeat(32))).toBe(true);
    expect(verdict).toEqual({ trustedFingerprint: 'ab'.repeat(32), mismatch: null });
  });

  it('accepts the stored key without asking to trust it again', async () => {
    const { config, verdict } = await buildConnectConfig({
      ...endpoint,
      storedFingerprint: 'ab'.repeat(32),
    });
    const verify = config.hostVerifier as (fingerprint: string) => boolean;

    expect(verify('ab'.repeat(32))).toBe(true);
    expect(verdict).toEqual({ trustedFingerprint: null, mismatch: null });
  });

  it('refuses a different key and records both fingerprints', async () => {
    const { config, verdict } = await buildConnectConfig({
      ...endpoint,
      storedFingerprint: 'ab'.repeat(32),
    });
    const verify = config.hostVerifier as (fingerprint: string) => boolean;

    expect(verify('cd'.repeat(32))).toBe(false);
    expect(verdict.mismatch).toEqual({ stored: 'ab'.repeat(32), presented: 'cd'.repeat(32) });
  });
});

describe('friendlyConnectError', () => {
  const noVerdict = { trustedFingerprint: null, mismatch: null };

  it('turns a host key mismatch into a coded error the renderer can act on', () => {
    const error = friendlyConnectError(new Error('handshake failed'), endpoint, {
      trustedFingerprint: null,
      mismatch: { stored: 'ab'.repeat(32), presented: 'cd'.repeat(32) },
    });

    expect(error).toBeInstanceOf(HostKeyChangedError);
    expect(sshErrorCode(error)).toBe('host-key-changed');
    expect(error.message).toContain('example.test:2222');
    expect(error.message).toContain('has changed since you last connected');
    expect((error as HostKeyChangedError).presented).toBe('cd'.repeat(32));
  });

  it('explains a rejected login', () => {
    const failure = Object.assign(new Error('All configured authentication methods failed'), {
      level: 'client-authentication',
    });

    expect(friendlyConnectError(failure, endpoint, noVerdict).message).toBe(
      'Authentication failed. Check the username, password, or private key.',
    );
  });

  it.each([
    ['ENOTFOUND', 'Could not reach example.test:2222.'],
    ['ECONNREFUSED', 'Could not reach example.test:2222.'],
    ['EHOSTUNREACH', 'Could not reach example.test:2222.'],
    ['ENETUNREACH', 'Could not reach example.test:2222.'],
    ['ETIMEDOUT', 'Connection to example.test:2222 timed out.'],
  ])('explains %s', (code, message) => {
    const failure = Object.assign(new Error(code), { code });

    expect(friendlyConnectError(failure, endpoint, noVerdict).message).toBe(message);
  });

  it.each([
    ['a reset socket', Object.assign(new Error('read ECONNRESET'), { code: 'ECONNRESET' })],
    ['an aborted socket', Object.assign(new Error('aborted'), { code: 'ECONNABORTED' })],
    [
      'a hang up before the handshake',
      Object.assign(new Error('Connection lost before handshake'), { level: 'protocol' }),
    ],
  ])('explains %s as the other end closing the connection', (_name, failure) => {
    expect(friendlyConnectError(failure, endpoint, noVerdict).message).toBe(
      'The connection to example.test:2222 was closed by the other end while connecting. ' +
        'Check that the host and port belong to an SSH server.',
    );
  });

  it.each([
    ['Invalid identification string'],
    ['Bad packet length'],
    ['Bad packet length: 1213486160'],
  ])('explains "%s" as a service that is not SSH', (message) => {
    const failure = Object.assign(new Error(message), { level: 'protocol' });

    expect(friendlyConnectError(failure, endpoint, noVerdict).message).toBe(
      'example.test:2222 does not look like an SSH server. Check the host and port.',
    );
  });

  it("explains ssh2's own handshake deadline the same way as a timed out socket", () => {
    const failure = Object.assign(new Error('Timed out while waiting for handshake'), {
      level: 'client-timeout',
    });

    expect(friendlyConnectError(failure, endpoint, noVerdict).message).toBe(
      'Connection to example.test:2222 timed out.',
    );
  });

  it('passes anything else through untouched', () => {
    const failure = new Error('Unsupported key format');

    expect(friendlyConnectError(failure, endpoint, noVerdict)).toBe(failure);
  });
});

describe('probeHostKey', () => {
  it('reads the host key without logging in', async () => {
    server = await startFakeSshServer();

    const fingerprint = await probeHostKey(server.host, server.port);

    expect(fingerprint).toBe(server.fingerprint());
    expect(server.execRequests).toEqual([]);
  });

  it('explains a host that is not listening', async () => {
    server = await startFakeSshServer();
    const { port } = server;
    await server.close();
    server = null;

    await expect(probeHostKey('127.0.0.1', port)).rejects.toThrow(
      `Could not reach 127.0.0.1:${port}.`,
    );
  });
});
