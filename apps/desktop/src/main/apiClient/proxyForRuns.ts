import { noProxyEnvValue, type ProxySettings, proxyEnvUrl } from '@runova/core';
import type { EngineProxy } from './engine/types';

/**
 * The app's proxy settings as the engine takes them. Postman's runtime only speaks to HTTP(S)
 * proxies, so a SOCKS proxy means requests from the API Client go direct.
 */
export async function proxyForRuns(
  settings: ProxySettings,
  resolveSystem: () => Promise<string | null>,
): Promise<EngineProxy | null> {
  let url: string | null = null;
  if (settings.mode === 'manual') url = proxyEnvUrl(settings);
  else if (settings.mode === 'system') url = await resolveSystem();
  if (!url || !/^https?:\/\//i.test(url)) return null;

  const bypass = noProxyEnvValue(settings)
    .split(',')
    .map((host) => host.trim())
    // Postman's bypass patterns are URL match patterns, which a bare IPv6 address cannot be.
    .filter((host) => host && !host.includes(':'));
  return { url, bypass };
}
