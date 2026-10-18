import { request as httpRequest } from 'node:http';
import type { ProxySettings } from '@agentmat/core';
import { defaultProxySettings } from '@agentmat/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { electronState } from '../../test/main/electronMock';
import { json, type LocalServer, startHttpServer } from '../../test/main/fixtures';
import { useTempUserData } from '../../test/main/ipcHarness';

/**
 * Two things here are easy to get wrong and expensive when they are: what Chromium is handed
 * (a malformed bypass string silently disables the proxy) and whether the fetch shim still
 * behaves like `fetch` to its callers. Both are checked against a real local server.
 *
 * `net.request` is Electron's own client, which the mock does not carry, so it is backed by
 * node:http here and the options it was called with are recorded for assertions.
 */

interface RecordedRequest {
  method: string;
  url: string;
  session: unknown;
  useSessionCookies?: boolean;
  redirect?: string;
}

const netRequests: RecordedRequest[] = [];
/** Set by a test to have the shim raise Chromium's proxy login event. */
let loginChallenge: { isProxy: boolean } | null = null;
const loginAnswers: (string | undefined)[][] = [];
/** Where the hard coded geolocation probe URL is sent instead of the real internet. */
let probeTarget: string | null = null;

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualSession = actual.session as {
    defaultSession: Record<string, unknown>;
    fromPartition: (partition: string) => Record<string, unknown>;
  };
  // Real sessions drop their open sockets when the route changes, and the module calls this
  // outside a try/catch on the test path, so the stand-in needs it too.
  const withClose = (target: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(target, { closeAllConnections: async () => undefined });
  return {
    ...actual,
    session: {
      ...actualSession,
      defaultSession: withClose(actualSession.defaultSession),
      fromPartition: (partition: string) => withClose(actualSession.fromPartition(partition)),
    },
    net: {
      ...(actual.net as Record<string, unknown>),
      request: (options: RecordedRequest) => {
        netRequests.push(options);
        const url = new URL(options.url);
        const target =
          probeTarget && url.hostname === 'get.geojs.io'
            ? `${probeTarget}${url.pathname}`
            : options.url;
        const client = httpRequest(target, { method: options.method });
        if (loginChallenge) {
          const challenge = loginChallenge;
          // Chromium raises this before the response, so it is fired on the next tick.
          setImmediate(() =>
            client.emit('login', challenge, (...answer: (string | undefined)[]) =>
              loginAnswers.push(answer),
            ),
          );
        }
        return client;
      },
    },
  };
});

const userData = useTempUserData();

let server: LocalServer | null = null;

function manual(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return {
    ...defaultProxySettings(),
    mode: 'manual',
    host: '10.0.0.1',
    port: 8080,
    ...overrides,
  };
}

async function loadProxy() {
  return import('./proxy');
}

/** The proxy settings the fake Electron session was handed, newest last. */
function proxyConfigs(): Record<string, unknown>[] {
  return electronState.proxyConfigs as Record<string, unknown>[];
}

beforeEach(() => {
  netRequests.length = 0;
  loginAnswers.length = 0;
  loginChallenge = null;
  probeTarget = null;
  for (const key of ['HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'NO_PROXY']) {
    vi.stubEnv(key, undefined);
    vi.stubEnv(key.toLowerCase(), undefined);
  }
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('applyProxySettings', () => {
  it('hands Chromium the manual server and bypass list', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ bypassList: ['<local>', '*.corp.example'] }));

    // The default session and the updater's own session both have to be configured, or the
    // update check would keep going straight out.
    expect(proxyConfigs()).toHaveLength(2);
    expect(proxyConfigs()[0]).toEqual({
      proxyRules: 'http://10.0.0.1:8080',
      proxyBypassRules: '<local>,*.corp.example',
    });
    expect(proxyConfigs()[1]).toEqual(proxyConfigs()[0]);
  });

  it('routes utility process requests the same way', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual());
    await applyProxySettings({ ...defaultProxySettings(), mode: 'direct' });

    // The speech model downloads from a utility process, which no session covers.
    expect(electronState.appProxyConfigs).toEqual([
      { proxyRules: 'http://10.0.0.1:8080', proxyBypassRules: '<local>' },
      { mode: 'direct' },
    ]);
  });

  it('leaves the bypass key out when the list is empty', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ bypassList: [] }));

    // Chromium reads an empty rule string as a malformed list and ignores the whole config.
    expect(proxyConfigs()[0]).toEqual({ proxyRules: 'http://10.0.0.1:8080' });
    expect(Object.keys(proxyConfigs()[0])).not.toContain('proxyBypassRules');
  });

  it('passes the protocol through to the rule', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ protocol: 'socks5', port: 1080, bypassList: [] }));

    expect(proxyConfigs()[0]).toEqual({ proxyRules: 'socks5://10.0.0.1:1080' });
  });

  it('asks Chromium to follow the machine settings in system mode', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings({ ...defaultProxySettings(), mode: 'system' });

    expect(proxyConfigs()[0]).toEqual({ mode: 'system' });
  });

  it('falls back to direct when a manual entry is half filled in', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ port: null }));

    // Sending every request at a host with no port would take the app offline.
    expect(proxyConfigs()[0]).toEqual({ mode: 'direct' });
  });

  it('sets the HTTP_PROXY family so child processes use the proxy too', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ bypassList: ['<local>', 'internal.example'] }));

    expect(process.env.HTTP_PROXY).toBe('http://10.0.0.1:8080');
    // Lower case too: git and several CLIs only read the lower case names.
    expect(process.env.http_proxy).toBe('http://10.0.0.1:8080');
    expect(process.env.HTTPS_PROXY).toBe('http://10.0.0.1:8080');
    expect(process.env.ALL_PROXY).toBe('http://10.0.0.1:8080');
    // The tools that read NO_PROXY do not understand Chromium's "<local>" shorthand.
    expect(process.env.NO_PROXY).toBe('localhost,127.0.0.1,::1,internal.example');
    expect(process.env.no_proxy).toBe(process.env.NO_PROXY);
  });

  it('puts credentials in the env URL, since the CLIs cannot be prompted', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ username: 'me@corp', password: 'p a s s' }));

    expect(process.env.HTTP_PROXY).toBe('http://me%40corp:p%20a%20s%20s@10.0.0.1:8080');
    // Chromium ignores credentials in a rule and asks through its login event instead.
    expect(proxyConfigs()[0].proxyRules).toBe('http://10.0.0.1:8080');
  });

  it('drops NO_PROXY when nothing is bypassed', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual({ bypassList: [] }));

    expect(process.env.NO_PROXY).toBeUndefined();
    expect(process.env.no_proxy).toBeUndefined();
  });

  it('restores the shell values the app was started with when switching to direct', async () => {
    vi.stubEnv('HTTP_PROXY', 'http://from-the-shell:3128');
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual());
    expect(process.env.HTTP_PROXY).toBe('http://10.0.0.1:8080');

    await applyProxySettings({ ...defaultProxySettings(), mode: 'direct' });

    // Direct means "do not add a proxy", not "throw away the one this machine came with".
    expect(process.env.HTTP_PROXY).toBe('http://from-the-shell:3128');
  });

  it('removes a variable it added when the baseline had none', async () => {
    const { applyProxySettings } = await loadProxy();

    await applyProxySettings(manual());
    await applyProxySettings({ ...defaultProxySettings(), mode: 'direct' });

    expect(process.env.HTTP_PROXY).toBeUndefined();
    expect(process.env.ALL_PROXY).toBeUndefined();
  });

  it('resolves the system proxy into a literal address for child processes', async () => {
    const { applyProxySettings } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockResolvedValue(
      'PROXY 192.168.1.9:3128; DIRECT',
    );

    await applyProxySettings({ ...defaultProxySettings(), mode: 'system', bypassList: [] });

    // Child processes have no equivalent of "follow the system settings".
    expect(process.env.HTTP_PROXY).toBe('http://192.168.1.9:3128');
  });

  it.each([
    ['SOCKS5 host:1080', 'socks5://host:1080'],
    ['SOCKS4 host:1080', 'socks4://host:1080'],
    ['SOCKS host:1080', 'socks4://host:1080'],
    ['HTTPS secure:443', 'https://secure:443'],
    ['PROXY plain:8080', 'http://plain:8080'],
  ])('reads the resolver answer %s as %s', async (resolved, expected) => {
    const { resolveSystemProxy } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockResolvedValue(resolved);

    await expect(resolveSystemProxy()).resolves.toBe(expected);
  });

  it.each(['DIRECT', 'direct', '', 'PROXY'])(
    'reads the resolver answer %s as no proxy',
    async (resolved) => {
      const { resolveSystemProxy } = await loadProxy();
      const { session } = await import('electron');
      vi.spyOn(session.defaultSession, 'resolveProxy').mockResolvedValue(resolved);

      await expect(resolveSystemProxy()).resolves.toBeNull();
    },
  );

  it('answers null rather than throwing when the resolver fails', async () => {
    const { resolveSystemProxy } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockRejectedValue(new Error('no session'));

    await expect(resolveSystemProxy()).resolves.toBeNull();
  });
});

describe('applyProxySettingsFromStore', () => {
  it('applies whatever the saved settings hold', async () => {
    userData.writeData('settings.json', { proxy: manual({ host: '172.16.0.4', port: 3128 }) });
    const { applyProxySettingsFromStore } = await loadProxy();

    await applyProxySettingsFromStore();

    expect(proxyConfigs()[0].proxyRules).toBe('http://172.16.0.4:3128');
  });

  it('leaves the app on a direct connection when the settings cannot be read', async () => {
    userData.writeData('settings.json', 'not json');
    const { applyProxySettingsFromStore } = await loadProxy();

    await applyProxySettingsFromStore();

    // Failing loudly here would stop the app from starting at all.
    expect(proxyConfigs()[0]).toEqual({ mode: 'direct' });
  });
});

describe('getProxyStatus', () => {
  it('reports the manual server as the effective one', async () => {
    const { applyProxySettings, getProxyStatus } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockResolvedValue('DIRECT');
    await applyProxySettings(manual());

    await expect(getProxyStatus()).resolves.toEqual({
      mode: 'manual',
      effectiveServer: 'http://10.0.0.1:8080',
      systemServer: null,
    });
  });

  it('reports the machine setting in system mode, and shows it in direct mode too', async () => {
    const { applyProxySettings, getProxyStatus } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockResolvedValue('PROXY box:3128');

    await applyProxySettings({ ...defaultProxySettings(), mode: 'system' });
    await expect(getProxyStatus()).resolves.toEqual({
      mode: 'system',
      effectiveServer: 'http://box:3128',
      systemServer: 'http://box:3128',
    });

    await applyProxySettings({ ...defaultProxySettings(), mode: 'direct' });
    // Direct mode still reports what the machine is set to, so the UI can offer it.
    await expect(getProxyStatus()).resolves.toEqual({
      mode: 'direct',
      effectiveServer: null,
      systemServer: 'http://box:3128',
    });
  });
});

describe('resolveTunnelRoute', () => {
  it('asks Chromium where the host goes and hands back the proxy with its credentials', async () => {
    const { applyProxySettings, resolveTunnelRoute } = await loadProxy();
    const { session } = await import('electron');
    const resolve = vi
      .spyOn(session.defaultSession, 'resolveProxy')
      .mockResolvedValue('SOCKS5 10.0.0.1:1080');
    await applyProxySettings(
      manual({ protocol: 'socks5', port: 1080, username: 'me', password: 'pw' }),
    );

    await expect(resolveTunnelRoute('rdp.example', 3389)).resolves.toEqual({
      protocol: 'socks5',
      host: '10.0.0.1',
      port: 1080,
      username: 'me',
      password: 'pw',
    });
    // IPv6 servers are bracketed, or the URL Chromium is asked about would not parse.
    await resolveTunnelRoute('fe80::1', 3389);
    expect(resolve).toHaveBeenLastCalledWith('https://[fe80::1]:3389');
  });

  it('goes direct for a host the bypass list or PAC script skips', async () => {
    const { applyProxySettings, resolveTunnelRoute } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockResolvedValue('DIRECT');
    await applyProxySettings({ ...defaultProxySettings(), mode: 'system' });

    await expect(resolveTunnelRoute('192.168.1.5', 3389)).resolves.toBeNull();
  });

  it('goes direct without asking when no proxy is on', async () => {
    const { applyProxySettings, resolveTunnelRoute } = await loadProxy();
    const { session } = await import('electron');
    const resolve = vi.spyOn(session.defaultSession, 'resolveProxy');
    await applyProxySettings(defaultProxySettings());
    resolve.mockClear();

    await expect(resolveTunnelRoute('rdp.example', 3389)).resolves.toBeNull();
    expect(resolve).not.toHaveBeenCalled();
  });

  it('still uses a manual proxy when the resolver fails', async () => {
    const { applyProxySettings, resolveTunnelRoute } = await loadProxy();
    const { session } = await import('electron');
    vi.spyOn(session.defaultSession, 'resolveProxy').mockRejectedValue(new Error('no session'));
    await applyProxySettings(manual());

    await expect(resolveTunnelRoute('rdp.example', 3389)).resolves.toMatchObject({
      protocol: 'http',
      host: '10.0.0.1',
      port: 8080,
    });
  });
});

describe('installProxyFetch', () => {
  it('leaves fetch on Node while the proxy is off', async () => {
    server = await startHttpServer((_request, response) => json(response, { via: 'node' }));
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings({ ...defaultProxySettings(), mode: 'direct' });
    installProxyFetch();

    const response = await fetch(`${server.url}/ping`);

    await expect(response.json()).resolves.toEqual({ via: 'node' });
    // Turning the feature off has to put requests back on exactly the old path.
    expect(netRequests).toEqual([]);
  });

  it('routes through Chromium while a proxy is on, and still answers a Response', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(201, { 'content-type': 'application/json', 'x-seen': 'yes' });
      response.end(JSON.stringify({ via: 'chromium' }));
    });
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    const response = await fetch(`${server.url}/through`, { headers: { 'x-test': '1' } });

    expect(netRequests).toHaveLength(1);
    expect(netRequests[0]).toMatchObject({ method: 'GET', redirect: 'follow' });
    expect(response.status).toBe(201);
    expect(response.headers.get('x-seen')).toBe('yes');
    await expect(response.json()).resolves.toEqual({ via: 'chromium' });
    expect(server.requests[0].headers['x-test']).toBe('1');
  });

  it('sends a request body and reports the status text', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(418, { 'content-type': 'text/plain' });
      response.end('nope');
    });
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    const response = await fetch(`${server.url}/post`, {
      method: 'POST',
      body: JSON.stringify({ a: 1 }),
      headers: { 'content-type': 'application/json' },
    });

    expect(netRequests[0].method).toBe('POST');
    expect(server.requests[0].body).toBe('{"a":1}');
    expect(response.status).toBe(418);
    await expect(response.text()).resolves.toBe('nope');
  });

  it('strips content-encoding, which Chromium has already undone', async () => {
    server = await startHttpServer((_request, response) => {
      // Reporting gzip on an already decompressed body makes the caller try to unzip text.
      response.writeHead(200, { 'content-encoding': 'gzip', 'content-type': 'text/plain' });
      response.end('plain bytes');
    });
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    const response = await fetch(`${server.url}/gz`);

    expect(response.headers.get('content-encoding')).toBeNull();
    await expect(response.text()).resolves.toBe('plain bytes');
  });

  it('keeps a bodyless status bodyless, which Response insists on', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(204);
      response.end();
    });
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    const response = await fetch(`${server.url}/nothing`);

    expect(response.status).toBe(204);
    expect(response.body).toBeNull();
  });

  it('turns on session cookies only when the caller sent a Cookie header', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    await fetch(`${server.url}/plain`);
    await fetch(`${server.url}/with-cookie`, { headers: { cookie: 'session=abc' } });

    // Off by default so the app's own browsing state never rides along, on when a caller
    // authenticates that way, because Chromium drops the header otherwise.
    expect(netRequests[0].useSessionCookies).toBe(false);
    expect(netRequests[1].useSessionCookies).toBe(true);
  });

  it('passes manual redirect handling through', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(302, { location: '/elsewhere' });
      response.end();
    });
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    await fetch(`${server.url}/redirect`, { redirect: 'manual' });

    expect(netRequests[0].redirect).toBe('manual');
  });

  it('rejects an aborted request instead of hanging', async () => {
    server = await startHttpServer(() => {
      // Never answered, so only the abort can end this request.
    });
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    const controller = new AbortController();
    const pending = fetch(`${server.url}/hang`, { signal: controller.signal });
    controller.abort(new Error('caller gave up'));

    await expect(pending).rejects.toThrow('caller gave up');
  });

  it('rejects straight away for a signal that is already aborted', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();

    await expect(
      fetch(`${server.url}/x`, { signal: AbortSignal.abort(new Error('already gone')) }),
    ).rejects.toThrow('already gone');
  });

  it('answers the proxy login once with the saved credentials', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    loginChallenge = { isProxy: true };
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual({ username: 'me', password: 'secret' }));
    installProxyFetch();

    await fetch(`${server.url}/auth`);

    expect(loginAnswers).toEqual([['me', 'secret']]);
  });

  it('declines a challenge that came from the site rather than the proxy', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    loginChallenge = { isProxy: false };
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual({ username: 'me', password: 'secret' }));
    installProxyFetch();

    await fetch(`${server.url}/auth`);

    // A site's own challenge is not ours to answer, and an empty callback is how Electron
    // is told to give up rather than hang.
    expect(loginAnswers).toEqual([[]]);
  });

  it('installs only once, so a second call does not wrap the shim in itself', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    const { applyProxySettings, installProxyFetch } = await loadProxy();
    await applyProxySettings(manual());
    installProxyFetch();
    installProxyFetch();

    await fetch(`${server.url}/once`);

    expect(netRequests).toHaveLength(1);
  });
});

describe('testProxy', () => {
  it('reports the address the probe was seen from', async () => {
    server = await startHttpServer((_request, response) =>
      json(response, { ip: '203.0.113.7', country: 'NL' }),
    );
    probeTarget = server.url;
    const { testProxy } = await loadProxy();

    const result = await testProxy(manual());

    // Reporting the address back is what proves to the user that the traffic really went
    // through the proxy rather than around it.
    expect(result).toMatchObject({ ok: true, ip: '203.0.113.7', country: 'NL', error: null });
    expect(result.latencyMs).toBeGreaterThanOrEqual(0);
  });

  it('leaves ip and country null when the probe answers something unexpected', async () => {
    server = await startHttpServer((_request, response) => json(response, { ip: 42 }));
    probeTarget = server.url;
    const { testProxy } = await loadProxy();

    await expect(testProxy(manual())).resolves.toMatchObject({ ok: true, ip: null, country: null });
  });

  it('names the credentials when the proxy answers 407', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(407);
      response.end();
    });
    probeTarget = server.url;
    const { testProxy } = await loadProxy();

    await expect(testProxy(manual())).resolves.toMatchObject({
      ok: false,
      ip: null,
      error: 'The proxy rejected the username and password.',
    });
  });

  it('reports any other status plainly', async () => {
    server = await startHttpServer((_request, response) => {
      response.writeHead(502);
      response.end();
    });
    probeTarget = server.url;
    const { testProxy } = await loadProxy();

    await expect(testProxy(manual())).resolves.toMatchObject({
      ok: false,
      error: 'The proxy answered with status 502.',
    });
  });

  it('reports a transport failure without throwing', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    probeTarget = server.url;
    await server.close();
    server = null;
    const { testProxy } = await loadProxy();

    const result = await testProxy(manual());

    expect(result.ok).toBe(false);
    expect(result.latencyMs).toBeNull();
    expect(result.error).toBeTruthy();
  });

  it('configures a throwaway session so a bad server never takes the app offline', async () => {
    server = await startHttpServer((_request, response) => json(response, {}));
    probeTarget = server.url;
    const { applyProxySettings, testProxy } = await loadProxy();
    await applyProxySettings(manual({ host: 'live.proxy', bypassList: [] }));
    const before = proxyConfigs().length;

    await testProxy(manual({ host: 'candidate.proxy', port: 9999, bypassList: [] }));

    // The candidate is applied to its own partition, and the live config is untouched.
    expect(proxyConfigs().slice(before)).toEqual([{ proxyRules: 'http://candidate.proxy:9999' }]);
    expect(process.env.HTTP_PROXY).toBe('http://live.proxy:8080');
  });
});
