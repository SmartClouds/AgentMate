import type { ProxySettings } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { ProxyStatus, ProxyTestResult } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * The two proxy handlers are a thin pass-through to the network layer, so what these pin is the
 * wiring: the candidate the user typed has to reach the probe unchanged, and whatever the probe
 * says has to reach the renderer unchanged. A candidate quietly dropped on the way would let the
 * Settings page report a working proxy that was never tried.
 */

useTempUserData();
expectChannelsCovered(IPC.proxy);

const getProxyStatus = vi.fn<() => Promise<ProxyStatus>>();
const testProxy = vi.fn<(candidate: ProxySettings) => Promise<ProxyTestResult>>();

vi.mock('../network/proxy', () => ({
  getProxyStatus: () => getProxyStatus(),
  testProxy: (candidate: ProxySettings) => testProxy(candidate),
}));

/** What the probe answers with when it got through. */
function probeAnswer(overrides: Partial<ProxyTestResult> = {}): ProxyTestResult {
  return { ok: true, latencyMs: 42, ip: '203.0.113.9', country: 'DE', error: null, ...overrides };
}

function candidate(overrides: Partial<ProxySettings> = {}): ProxySettings {
  return {
    mode: 'manual',
    protocol: 'http',
    host: '127.0.0.1',
    port: 8080,
    username: 'user',
    password: 'secret',
    ...overrides,
  } as ProxySettings;
}

beforeEach(async () => {
  getProxyStatus.mockReset();
  testProxy.mockReset();
  await loadIpc(
    () => import('./proxy'),
    (module) => module.registerProxyHandlers(),
  );
});

describe('proxy status', () => {
  it('reports the mode in use and the server it resolves to', async () => {
    getProxyStatus.mockResolvedValue({
      mode: 'system',
      effectiveServer: 'http://10.0.0.1:3128',
      systemServer: 'http://10.0.0.1:3128',
    });

    await expect(invoke<ProxyStatus>(IPC.proxy.status)).resolves.toEqual({
      mode: 'system',
      effectiveServer: 'http://10.0.0.1:3128',
      systemServer: 'http://10.0.0.1:3128',
    });
  });

  it('passes a direct connection through as it is', async () => {
    getProxyStatus.mockResolvedValue({ mode: 'direct', effectiveServer: null, systemServer: null });

    const status = await invoke<ProxyStatus>(IPC.proxy.status);

    expect(status.effectiveServer).toBeNull();
  });
});

describe('testing a candidate proxy', () => {
  it('hands the settings the user typed to the probe, credentials included', async () => {
    testProxy.mockResolvedValue(probeAnswer());

    await invoke(IPC.proxy.test, candidate());

    // Dropping the password here would make a proxy that needs auth look broken.
    expect(testProxy).toHaveBeenCalledWith(
      expect.objectContaining({
        host: '127.0.0.1',
        port: 8080,
        username: 'user',
        password: 'secret',
      }),
    );
  });

  it('returns the address the probe saw, which is what proves the traffic went through', async () => {
    testProxy.mockResolvedValue(probeAnswer());

    await expect(invoke<ProxyTestResult>(IPC.proxy.test, candidate())).resolves.toMatchObject({
      ok: true,
      ip: '203.0.113.9',
      country: 'DE',
    });
  });

  it('passes a refusal back rather than throwing at the renderer', async () => {
    // The Settings page shows this message next to the field, so it must survive the trip.
    const refusal = probeAnswer({
      ok: false,
      latencyMs: null,
      ip: null,
      country: null,
      error: 'Proxy refused the connection.',
    });
    testProxy.mockResolvedValue(refusal);

    await expect(invoke<ProxyTestResult>(IPC.proxy.test, candidate())).resolves.toEqual(refusal);
  });

  it('lets a thrown probe error reach the caller', async () => {
    testProxy.mockRejectedValue(new Error('probe crashed'));

    await expect(invoke(IPC.proxy.test, candidate())).rejects.toThrow('probe crashed');
  });
});
