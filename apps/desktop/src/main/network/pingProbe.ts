import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { PingIpVersion, PingMethod } from '@runova/core';
import type { PingResult } from '../../shared/apiTypes';

const execFileAsync = promisify(execFile);

export const DEFAULT_PING_URL = 'https://www.gstatic.com/generate_204';
/** Cloudflare and Google public DNS, the same resolvers on both IP families. */
export const DEFAULT_PING_TARGETS_IPV4 = ['1.1.1.1'];
export const DEFAULT_PING_TARGETS_IPV6 = ['2606:4700:4700::1111', '2001:4860:4860::8888'];
export const MAX_PING_URLS = 5;
export const DEFAULT_PING_URL_INTERVAL_SECONDS = 5;
export const MIN_PING_URL_INTERVAL_SECONDS = 1;
export const MAX_PING_URL_INTERVAL_SECONDS = 300;
const HTTP_TIMEOUT_MS = 3000;

export function isPingMethod(value: unknown): value is PingMethod {
  return value === 'icmp' || value === 'http' || value === 'auto';
}

export function isPingIpVersion(value: unknown): value is PingIpVersion {
  return value === 'ipv4' || value === 'ipv6';
}

export function normalizePingUrlInterval(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return DEFAULT_PING_URL_INTERVAL_SECONDS;
  }
  return Math.min(
    MAX_PING_URL_INTERVAL_SECONDS,
    Math.max(MIN_PING_URL_INTERVAL_SECONDS, Math.round(value)),
  );
}

/** Keeps only http(s) URLs, trimmed, deduped and capped. */
export function normalizePingUrls(value: unknown): string[] {
  if (!Array.isArray(value)) return [DEFAULT_PING_URL];
  const urls: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    try {
      const parsed = new URL(trimmed);
      if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') continue;
    } catch {
      continue;
    }
    if (!urls.includes(trimmed)) urls.push(trimmed);
  }
  return urls.slice(0, MAX_PING_URLS);
}

export interface PingCommand {
  file: string;
  args: string[];
}

/**
 * Each platform's ping spells the reply timeout differently: Windows `-w` is
 * milliseconds, Linux `-W` is seconds and macOS `-W` is milliseconds, so the
 * Linux flags would give a Mac 2 ms to answer and every sample would fail.
 * macOS also has no `-6` and pings IPv6 through `ping6`, which has no reply
 * timeout flag (the exec timeout covers it). Without a family flag the OS picks
 * IPv4 for literal IPv4 addresses and most hostnames.
 */
export function pingCommand(
  host: string,
  ipVersion: PingIpVersion,
  platform: NodeJS.Platform,
): PingCommand {
  const ipv6 = ipVersion === 'ipv6';
  if (platform === 'win32') {
    return {
      file: 'ping',
      args: [...(ipv6 ? ['-6'] : []), '-n', '1', '-w', '1500', host],
    };
  }
  if (platform === 'darwin') {
    // Absolute paths, since an app opened from Finder may not have /sbin on PATH.
    return ipv6
      ? { file: '/sbin/ping6', args: ['-c', '1', host] }
      : { file: '/sbin/ping', args: ['-c', '1', '-W', '2000', host] };
  }
  return {
    file: 'ping',
    args: [...(ipv6 ? ['-6'] : []), '-c', '1', '-W', '2', host],
  };
}

/** Round trip in ms from one ping reply, or null when no reply came back. */
export function parsePingLatency(stdout: string, platform: NodeJS.Platform): number | null {
  const match =
    platform === 'win32' ? stdout.match(/time[=<](\d+)ms/i) : stdout.match(/time=([\d.]+)\s*ms/i);
  return match ? Math.round(Number(match[1])) : null;
}

export async function pingHost(
  host: string,
  ipVersion: PingIpVersion = 'ipv4',
  platform: NodeJS.Platform = process.platform,
): Promise<PingResult> {
  const { file, args } = pingCommand(host, ipVersion, platform);
  try {
    const { stdout } = await execFileAsync(file, args, { timeout: 3000 });
    const latencyMs = parsePingLatency(stdout, platform);
    if (latencyMs == null) return { host, latencyMs: null, alive: false };
    return { host, latencyMs, alive: true };
  } catch {
    return { host, latencyMs: null, alive: false };
  }
}

async function timedRequest(url: string, method: 'HEAD' | 'GET'): Promise<number | null> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), HTTP_TIMEOUT_MS);
  const started = performance.now();
  try {
    const response = await fetch(url, {
      method,
      redirect: 'manual',
      cache: 'no-store',
      signal: controller.signal,
    });
    const status = response.status;
    // Headers are in, which is all the timing needs. Drop the body.
    void response.body?.cancel().catch(() => undefined);
    if (status === 405 && method === 'HEAD') return -1;
    return Math.max(1, Math.round(performance.now() - started));
  } catch {
    return null;
  } finally {
    clearTimeout(timer);
  }
}

/** Any HTTP response proves the connection works, whatever the status code. */
export async function httpProbe(url: string): Promise<PingResult> {
  let latency = await timedRequest(url, 'HEAD');
  if (latency === -1) latency = await timedRequest(url, 'GET');
  if (latency == null || latency < 0) return { host: url, latencyMs: null, alive: false };
  return { host: url, latencyMs: latency, alive: true };
}

export interface PingSettings {
  pingTargets?: string[];
  pingIpVersion?: PingIpVersion;
  pingTargetsIpv6?: string[];
  pingMethod?: PingMethod;
  pingUrls?: string[];
  pingUrlIntervalSeconds?: number;
}

let httpCache: { key: string; at: number; results: Promise<PingResult[]> } | null = null;

/**
 * Callers sample far more often than a URL should be requested (the status bar
 * and dashboard poll every couple of seconds), so replies are reused until the
 * chosen period has passed.
 */
function httpProbeThrottled(urls: string[], intervalSeconds: number): Promise<PingResult[]> {
  const key = urls.join(' ');
  const now = Date.now();
  if (httpCache && httpCache.key === key && now - httpCache.at < intervalSeconds * 1000) {
    return httpCache.results;
  }
  const results = Promise.all(urls.map((url) => httpProbe(url)));
  httpCache = { key, at: now, results };
  return results;
}

function cleanHosts(hosts: string[] | undefined): string[] {
  return (hosts ?? []).map((host) => host.trim()).filter(Boolean);
}

export async function probeAll(
  settings: PingSettings,
  fallbackHosts: string[] = [],
): Promise<PingResult[]> {
  const method = isPingMethod(settings.pingMethod) ? settings.pingMethod : 'icmp';
  const ipVersion = isPingIpVersion(settings.pingIpVersion) ? settings.pingIpVersion : 'ipv4';
  const hosts = cleanHosts(ipVersion === 'ipv6' ? settings.pingTargetsIpv6 : settings.pingTargets);
  const icmpHosts =
    hosts.length > 0 ? hosts : ipVersion === 'ipv6' ? DEFAULT_PING_TARGETS_IPV6 : fallbackHosts;
  const urls = normalizePingUrls(settings.pingUrls);
  const intervalSeconds = normalizePingUrlInterval(settings.pingUrlIntervalSeconds);

  if (method === 'http') return httpProbeThrottled(urls, intervalSeconds);

  const icmp = await Promise.all(icmpHosts.map((host) => pingHost(host, ipVersion)));
  if (method === 'icmp') return icmp;

  // Auto: only reach for HTTP when ping is blocked or unanswered.
  if (icmp.some((result) => result.alive) || urls.length === 0) return icmp;
  const http = await httpProbeThrottled(urls, intervalSeconds);
  return http.some((result) => result.alive) ? http : icmp;
}
