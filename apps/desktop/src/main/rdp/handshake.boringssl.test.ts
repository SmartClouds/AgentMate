import { execFile } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { createServer as createTlsServer, type Server } from 'node:tls';
import { fileURLToPath } from 'node:url';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';
import { cleanTlsDetail, isKeyUsageError, RSA_KEY_EXCHANGE_TLS } from './handshake';
import { rdpStyleCertificate } from './testing/rdpCertificate';

/**
 * The same TLS connection the proxy makes, made by Electron's own TLS stack (BoringSSL), which
 * is not the OpenSSL of the Node that runs these tests. That difference is the bug this guards:
 * a certificate that Windows makes for Remote Desktop (Key Usage: Key Encipherment, Data
 * Encipherment) is refused by BoringSSL with KEY_USAGE_BIT_INCORRECT, which plain Node accepts,
 * so no test in Node could see it.
 *
 * Electron's binary runs the probe in "run as Node" mode, with no window and no display. The
 * suite is skipped where the Electron download is missing.
 */

const probeScript = fileURLToPath(new URL('./testing/boringsslProbe.cjs', import.meta.url));

function electronBinary(): string | null {
  try {
    const folder = dirname(createRequire(import.meta.url).resolve('electron/package.json'));
    const binary = join(folder, 'dist', readFileSync(join(folder, 'path.txt'), 'utf-8').trim());
    return existsSync(binary) ? binary : null;
  } catch {
    return null;
  }
}

const electron = electronBinary();

interface ProbeResult {
  ok: boolean;
  protocol?: string;
  cipher?: string;
  message?: string;
}

function probe(port: number, options: object): Promise<ProbeResult> {
  return new Promise((resolve, reject) => {
    execFile(
      electron as string,
      [probeScript, String(port), JSON.stringify(options)],
      {
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
        timeout: 30_000,
        windowsHide: true,
      },
      (error, stdout) => {
        if (error) return reject(error);
        const line = stdout.trim().split('\n').pop() ?? '';
        resolve(JSON.parse(line) as ProbeResult);
      },
    );
  });
}

const servers: Server[] = [];

async function serve(profile: Parameters<typeof rdpStyleCertificate>[0]): Promise<number> {
  const server = createTlsServer(rdpStyleCertificate(profile), (socket) => socket.end());
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as { port: number }).port;
}

afterEach(() => {
  for (const server of servers.splice(0)) server.close();
});

// Longer than the probe's own 30s limit, so a slow probe fails with its own error.
const PROBE_TEST_TIMEOUT = 40_000;

describe.skipIf(!electron)(
  "Electron's TLS stack and a Windows Remote Desktop certificate",
  { timeout: PROBE_TEST_TIMEOUT },
  () => {
    // The first launch of a freshly installed Electron can take many seconds (on macOS, Gatekeeper
    // scans the app bundle), which would otherwise land on whichever test happens to run first.
    beforeAll(async () => {
      await new Promise<void>((resolve, reject) => {
        execFile(
          electron as string,
          ['--version'],
          { env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' }, windowsHide: true },
          (error) => (error ? reject(error) : resolve()),
        );
      });
    }, 120_000);

    it('refuses it with an error the handshake recognises, or has stopped refusing it', async (context) => {
      const result = await probe(await serve('windows'), {});
      if (result.ok) {
        context.skip(
          'This Electron accepts the certificate with its normal settings, so the RSA retry is not needed.',
        );
        return;
      }
      expect(isKeyUsageError(result.message ?? '')).toBe(true);
      expect(cleanTlsDetail(result.message ?? '')).toBe('KEY_USAGE_BIT_INCORRECT (SSL routines)');
    });

    it('connects once only RSA key exchange over TLS 1.2 is offered', async () => {
      const result = await probe(await serve('windows'), RSA_KEY_EXCHANGE_TLS);
      expect(result.message).toBeUndefined();
      expect(result.ok).toBe(true);
      expect(result.protocol).toBe('TLSv1.2');
      expect(result.cipher).toMatch(/^AES(?:128|256)-/);
    });

    it('connects with its normal settings when the certificate allows signing', async () => {
      const result = await probe(await serve('signature'), {});
      expect(result.message).toBeUndefined();
      expect(result.ok).toBe(true);
    });

    it('connects with its normal settings when the certificate has no Key Usage at all', async () => {
      const result = await probe(await serve('none'), {});
      expect(result.message).toBeUndefined();
      expect(result.ok).toBe(true);
    });
  },
);
