import { formatWpConnectionKey } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { wordPressErrorCode } from '../../../shared/wordpressErrors';
import {
  checkPlainHttp,
  pairWithSite,
  readConnectionKey,
  sameOriginRescueUrl,
  wpDeviceName,
} from './pairing';
import { FakeConnector, pairingSecretOf } from './testing/fakeConnector';
import { WP_VECTORS } from './testing/vectors';
import { createFetchTransport, type WpTransport } from './transport';

/**
 * Pairing: the key is read strictly and never repeated, plain HTTP is refused unless allowed,
 * `/hello` must come from the key's site, and the secret only ever travels as an HMAC proof.
 */

const nodeTransport = createFetchTransport(globalThis.fetch as never);
let fake: FakeConnector;

beforeEach(async () => {
  fake = await new FakeConnector().start();
});
afterEach(async () => {
  await fake.stop();
});

async function failure(promise: Promise<unknown>): Promise<Error> {
  try {
    await promise;
  } catch (error) {
    return error as Error;
  }
  throw new Error('Expected the call to fail.');
}

function pair(key: string, overrides: Partial<Parameters<typeof pairWithSite>[0]> = {}) {
  return pairWithSite({
    connectionKey: key,
    allowPlainHttp: false,
    httpAuth: null,
    transport: nodeTransport,
    deviceName: 'laptop',
    ...overrides,
  });
}

describe('pairWithSite', () => {
  it('pairs once, and the secret never crosses the wire', async () => {
    const bodies: Uint8Array[] = [];
    const recording: WpTransport = async (request) => {
      if (request.body) bodies.push(request.body);
      return nodeTransport(request);
    };
    const key = fake.createKey({ scope: 'read', label: 'Office' });
    const result = await pair(key, { transport: recording });

    expect(result.pair.scope).toBe('read');
    expect(result.keyLabel).toBe('Office');
    expect(result.transport).toBe('local-http');
    expect(result.endpoint).toBe('rest');
    expect(result.rescueUrl).toBe(fake.rescueUrl);
    expect(result.sitePublicKey).toBe(fake.sitePublicKey);
    expect(fake.connections.get(result.pair.connectionId)?.publicKey).toBe(
      result.keyPair.publicKey,
    );
    expect(fake.connections.get(result.pair.connectionId)?.deviceName).toBe('laptop');
    expect(JSON.stringify(result)).not.toContain(pairingSecretOf(key));

    const secret = pairingSecretOf(key);
    for (const body of bodies) {
      expect(Buffer.from(body).toString('latin1')).not.toContain(secret);
    }

    const again = await failure(pair(key));
    expect(wordPressErrorCode(again)).toBe('pairingInvalid');
  });

  it('works when the site clock is far off', async () => {
    fake.switches.clockSkew = 2000;
    const result = await pair(fake.createKey());
    expect(result.clockOffset).toBeGreaterThanOrEqual(1998);
  });

  it('refuses a site whose key is not the one in the connection key', async () => {
    const other = WP_VECTORS.keys.desktop.publicKey;
    const wrongKey = fake.createKey({ sitePublicKey: other });
    expect(wordPressErrorCode(await failure(pair(wrongKey)))).toBe('siteKeyMismatch');

    fake.switches.helloKey = other;
    expect(wordPressErrorCode(await failure(pair(fake.createKey())))).toBe('siteKeyMismatch');
  });

  it('refuses a connector on another protocol', async () => {
    fake.switches.protocol = 0;
    expect(wordPressErrorCode(await failure(pair(fake.createKey())))).toBe('connectorOutdated');
    fake.switches.protocol = 2;
    expect(wordPressErrorCode(await failure(pair(fake.createKey())))).toBe('protocolMismatch');
  });

  it('refuses plain HTTP to another computer unless allowed', async () => {
    const urls = {
      siteUrl: 'http://shop.example',
      restUrl: 'http://shop.example/wp-json/runova/v1',
      ajaxUrl: 'http://shop.example/wp-admin/admin-ajax.php',
    };
    let called = false;
    const refused = await failure(
      pair(fake.createKey({ urls }), {
        transport: async () => {
          called = true;
          throw new Error('no network');
        },
      }),
    );
    expect(wordPressErrorCode(refused)).toBe('plainHttpRefused');
    expect(called).toBe(false);

    // Allowed, it goes ahead (and here fails on the network, which proves it tried).
    const allowed = await failure(
      pair(fake.createKey({ urls }), {
        allowPlainHttp: true,
        transport: async () => {
          throw new Error('net::ERR_NAME_NOT_RESOLVED');
        },
      }),
    );
    expect(allowed.message).toBe('net::ERR_NAME_NOT_RESOLVED');
  });

  it('reports an expired or damaged key without repeating it', async () => {
    const expired = fake.createKey({ ttlSeconds: -10 });
    const error = await failure(pair(expired));
    expect(wordPressErrorCode(error)).toBe('keyExpired');
    expect(error.message).not.toContain(pairingSecretOf(expired));
  });
});

describe('readConnectionKey', () => {
  const key = {
    siteUrl: 'https://a.example',
    restUrl: 'https://a.example/wp-json/runova/v1',
    ajaxUrl: 'https://a.example/wp-admin/admin-ajax.php',
    pairingId: 'pairing-0001',
    pairingSecret: WP_VECTORS.pairProof[0].secret,
    sitePublicKey: WP_VECTORS.keys.site.publicKey,
    scope: 'write' as const,
    expiresAt: 2_000_000_000,
  };

  it('reads a good key and refuses bad ones with the right code', () => {
    expect(readConnectionKey(formatWpConnectionKey(key), 1_900_000_000).pairingId).toBe(
      'pairing-0001',
    );
    const cases: [string, string][] = [
      ['amwp1.!!!', 'keyInvalid'],
      ['nothing', 'keyInvalid'],
      [formatWpConnectionKey(key).replace('amwp1.', 'amwp2.'), 'keyInvalid'],
      [formatWpConnectionKey({ ...key, restUrl: 'ftp://x' }), 'keyInvalid'],
    ];
    for (const [text, code] of cases) {
      let error: unknown;
      try {
        readConnectionKey(text, 1_900_000_000);
      } catch (caught) {
        error = caught;
      }
      expect(wordPressErrorCode(error), text.slice(0, 12)).toBe(code);
      expect((error as Error).message).not.toContain(key.pairingSecret);
    }
    let version: unknown;
    try {
      readConnectionKey(formatWpConnectionKey(key).replace('amwp1.', 'amwp2.'), 1);
    } catch (caught) {
      version = caught;
    }
    expect((version as Error).message).toContain('another version');
    expect(() => readConnectionKey(formatWpConnectionKey(key), 2_100_000_000)).toThrow(
      '[wp:keyExpired]',
    );
  });
});

describe('policy helpers', () => {
  it('allows HTTPS and local HTTP, and plain HTTP only when asked', () => {
    expect(() => checkPlainHttp('https', false)).not.toThrow();
    expect(() => checkPlainHttp('local-http', false)).not.toThrow();
    expect(() => checkPlainHttp('plain-http', true)).not.toThrow();
    expect(() => checkPlainHttp('plain-http', false)).toThrow('[wp:plainHttpRefused]');
  });

  it('makes a device name the site accepts', () => {
    expect(wpDeviceName('DESKTOP-1')).toBe('DESKTOP-1');
    expect(wpDeviceName('\u0000\n')).toBe('Runova');
    expect([...wpDeviceName('x'.repeat(100))].length).toBeLessThanOrEqual(64);
  });

  it('keeps a rescue URL only on the site origin', () => {
    const key = {
      siteUrl: 'https://a.example',
      restUrl: 'https://a.example/wp-json/runova/v1',
      ajaxUrl: 'https://a.example/wp-admin/admin-ajax.php',
    };
    expect(sameOriginRescueUrl('https://a.example/wp-content/plugins/x/rescue.php', key)).toBe(
      'https://a.example/wp-content/plugins/x/rescue.php',
    );
    expect(sameOriginRescueUrl('https://evil.example/rescue.php', key)).toBeNull();
    expect(sameOriginRescueUrl('http://a.example/rescue.php', key)).toBeNull();
    expect(sameOriginRescueUrl('https://u:p@a.example/rescue.php', key)).toBeNull();
    expect(sameOriginRescueUrl('javascript:x', key)).toBeNull();
    expect(sameOriginRescueUrl('::', key)).toBeNull();
    expect(sameOriginRescueUrl(5, key)).toBeNull();
  });
});
