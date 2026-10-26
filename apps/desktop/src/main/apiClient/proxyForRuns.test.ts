import { defaultProxySettings, type ProxySettings } from '@runova/core';
import { describe, expect, it, vi } from 'vitest';
import { proxyForRuns } from './proxyForRuns';

/**
 * Requests from the API Client follow the app's proxy settings, the same way every other
 * outgoing request does. These check the translation into what the engine takes.
 */

const settings = (overrides: Partial<ProxySettings>): ProxySettings => ({
  ...defaultProxySettings(),
  ...overrides,
});

describe('proxyForRuns', () => {
  it('goes direct when the app does', async () => {
    const resolveSystem = vi.fn();
    expect(await proxyForRuns(settings({ mode: 'direct' }), resolveSystem)).toBeNull();
    expect(resolveSystem).not.toHaveBeenCalled();
  });

  it('passes a manual HTTP proxy with its credentials and bypass list', async () => {
    const result = await proxyForRuns(
      settings({
        mode: 'manual',
        protocol: 'http',
        host: 'proxy.corp',
        port: 3128,
        username: 'me',
        password: 'p@ss',
        bypassList: ['<local>', '*.corp.test'],
      }),
      vi.fn(),
    );
    expect(result).toEqual({
      url: 'http://me:p%40ss@proxy.corp:3128',
      bypass: ['localhost', '127.0.0.1', '*.corp.test'],
    });
  });

  it('asks the system in system mode', async () => {
    const result = await proxyForRuns(
      settings({ mode: 'system', bypassList: [] }),
      async () => 'http://10.0.0.1:8080',
    );
    expect(result).toEqual({ url: 'http://10.0.0.1:8080', bypass: [] });
    expect(await proxyForRuns(settings({ mode: 'system' }), async () => null)).toBeNull();
  });

  it('goes direct for SOCKS, which the engine cannot use', async () => {
    expect(
      await proxyForRuns(
        settings({ mode: 'manual', protocol: 'socks5', host: 's', port: 1080 }),
        vi.fn(),
      ),
    ).toBeNull();
    expect(await proxyForRuns(settings({ mode: 'system' }), async () => 'socks5://s:1')).toBeNull();
  });
});
