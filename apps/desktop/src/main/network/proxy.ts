import type { ProxySettings } from '@agentmat/core';
import {
  defaultProxySettings,
  isProxyActive,
  noProxyEnvValue,
  normalizeProxySettings,
  proxyBypassRules,
  proxyEnvUrl,
  proxyServerUrl,
} from '@agentmat/core';
import { app, net, type Session, session } from 'electron';
import type { ProxyStatus, ProxyTestResult } from '../../shared/apiTypes';
import { store } from '../store';
import { parseProxyUrl, type TunnelRoute } from './tunnel';

/**
 * electron-updater does its downloads on a session of its own (its
 * NET_SESSION_NAME), so the update check would keep going straight out unless
 * that session is configured alongside the default one.
 */
const UPDATER_PARTITION = 'electron-updater';
/** Left on system settings for good, so the UI can report what this machine is set to. */
const PROBE_PARTITION = 'agentmate-proxy-probe';
/** Where "Test connection" points a candidate server without touching the live one. */
const TEST_PARTITION = 'agentmate-proxy-test';

/** Any host works; Chromium only consults the config (or the PAC script) to answer. */
const RESOLVE_TARGET = 'https://www.google.com';
/** Reports back the address the request arrived from, which is the proof a proxy is carrying it. */
const PROBE_URL = 'https://get.geojs.io/v1/ip/geo.json';
const TEST_TIMEOUT_MS = 15_000;

const PROXY_ENV_KEYS = [
  'HTTP_PROXY',
  'http_proxy',
  'HTTPS_PROXY',
  'https_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
] as const;

/** Node's own fetch, kept aside so direct mode behaves exactly as it did before. */
const nodeFetch = globalThis.fetch;

let current: ProxySettings = defaultProxySettings();
let fetchInstalled = false;
let probeSessionReady: Promise<Session> | null = null;
/** Credentials for an in-flight "Test connection", which the live ones must not answer for. */
let pendingTestAuth: { username: string; password: string } | null = null;
/**
 * Whatever HTTP_PROXY and friends held when the app started. The user may have
 * launched AgentMate from a shell that already had them set, and direct mode
 * means "don't add a proxy", not "throw away the one this machine came with".
 */
let envBaseline: Record<string, string | undefined> | null = null;

function captureEnvBaseline(): void {
  if (envBaseline) return;
  envBaseline = {};
  for (const key of PROXY_ENV_KEYS) envBaseline[key] = process.env[key];
}

function restoreEnvBaseline(): void {
  captureEnvBaseline();
  for (const key of PROXY_ENV_KEYS) {
    const original = envBaseline?.[key];
    if (original == null) delete process.env[key];
    else process.env[key] = original;
  }
}

function setProxyEnv(url: string, noProxy: string): void {
  process.env.HTTP_PROXY = url;
  process.env.http_proxy = url;
  process.env.HTTPS_PROXY = url;
  process.env.https_proxy = url;
  process.env.ALL_PROXY = url;
  process.env.all_proxy = url;
  if (noProxy) {
    process.env.NO_PROXY = noProxy;
    process.env.no_proxy = noProxy;
  } else {
    delete process.env.NO_PROXY;
    delete process.env.no_proxy;
  }
}

function electronProxyConfig(settings: ProxySettings): Electron.ProxyConfig {
  if (settings.mode === 'system') return { mode: 'system' };
  const server = proxyServerUrl(settings);
  if (!server) return { mode: 'direct' };
  const bypass = proxyBypassRules(settings);
  // Chromium reads an empty rule string as a malformed list, so a cleared
  // bypass field has to leave the key out rather than pass "".
  return bypass ? { proxyRules: server, proxyBypassRules: bypass } : { proxyRules: server };
}

async function probeSession(): Promise<Session> {
  if (!probeSessionReady) {
    probeSessionReady = (async () => {
      const probe = session.fromPartition(PROBE_PARTITION, { cache: false });
      await probe.setProxy({ mode: 'system' });
      return probe;
    })();
  }
  return probeSessionReady;
}

/**
 * Turns one of Chromium's resolver answers ("PROXY 10.0.0.1:8080; DIRECT",
 * "SOCKS5 host:1080", "DIRECT") into a URL, or null when it says go straight
 * out. Only the first entry matters: the rest are fallbacks Chromium tries on
 * its own.
 */
function proxyUrlFromResolution(resolved: string): string | null {
  const first = resolved.split(';')[0]?.trim();
  if (!first || first.toUpperCase() === 'DIRECT') return null;
  const [type, address] = first.split(/\s+/);
  if (!address) return null;
  const kind = type.toUpperCase();
  const scheme =
    kind === 'SOCKS5'
      ? 'socks5'
      : kind === 'SOCKS' || kind === 'SOCKS4'
        ? 'socks4'
        : kind === 'HTTPS'
          ? 'https'
          : 'http';
  return `${scheme}://${address}`;
}

/** What this machine (or its PAC script) would use, whether or not AgentMate is set to follow it. */
export async function resolveSystemProxy(): Promise<string | null> {
  try {
    const probe = await probeSession();
    return proxyUrlFromResolution(await probe.resolveProxy(RESOLVE_TARGET));
  } catch {
    return null;
  }
}

/**
 * Points every outgoing channel at the configured proxy: Chromium's sessions
 * (which is what `net.fetch` and the updater ride on) and the HTTP_PROXY-style
 * variables that the CLIs, git, and any other child process read.
 */
export async function applyProxySettings(settings: ProxySettings): Promise<void> {
  captureEnvBaseline();
  current = normalizeProxySettings(settings);

  const config = electronProxyConfig(current);
  const targets: Session[] = [
    session.defaultSession,
    session.fromPartition(UPDATER_PARTITION, { cache: false }),
  ];
  await Promise.all(
    targets.map(async (target) => {
      try {
        await target.setProxy(config);
        // Sockets opened before the switch would otherwise keep serving
        // requests over the old route until they idle out.
        await target.closeAllConnections();
      } catch {
        // A session that refuses the config still leaves the others configured.
      }
    }),
  );
  // Requests from a utility process (the speech model download) belong to no session and
  // follow this one instead.
  try {
    await app.setProxy(config);
  } catch {
    // Same as a session that refuses it: everything else is still configured.
  }

  if (current.mode === 'manual') {
    const url = proxyEnvUrl(current);
    if (url) setProxyEnv(url, noProxyEnvValue(current));
    else restoreEnvBaseline();
    return;
  }

  if (current.mode === 'system') {
    // Child processes have no equivalent of "follow the system settings", so
    // the address is resolved once here and handed to them literally.
    const url = await resolveSystemProxy();
    if (url) setProxyEnv(url, noProxyEnvValue(current));
    else restoreEnvBaseline();
    return;
  }

  restoreEnvBaseline();
}

/**
 * The proxy a raw TCP connection to `host:port` should go through, for the features that open
 * their own sockets (Remote Desktop). Asking the default session means the bypass list, the
 * system settings and any PAC script all count, the same as for every request Chromium makes.
 * Null means connect straight there: no proxy is on, or this host skips it.
 */
export async function resolveTunnelRoute(host: string, port: number): Promise<TunnelRoute | null> {
  if (!isProxyActive(current) || !app.isReady()) return null;
  const credentials = { username: current.username, password: current.password };
  const target = `https://${host.includes(':') ? `[${host}]` : host}:${port}`;
  let resolved: string;
  try {
    resolved = await session.defaultSession.resolveProxy(target);
  } catch {
    // A manual proxy is spelled out, so it doesn't need the resolver to be found.
    const server = proxyServerUrl(current);
    return server ? parseProxyUrl(server, credentials) : null;
  }
  const url = proxyUrlFromResolution(resolved);
  return url ? parseProxyUrl(url, credentials) : null;
}

/** The settings the app is running with right now, for callers that route traffic themselves. */
export function currentProxySettings(): ProxySettings {
  return current;
}

export async function applyProxySettingsFromStore(): Promise<void> {
  try {
    const settings = await store.getSettings();
    await applyProxySettings(settings.proxy);
  } catch {
    // Unreadable settings leave the app on a direct connection, which is the
    // same place it was before this feature existed.
  }
}

/** Chromium hands headers back as a plain object, repeated ones already grouped into an array. */
function toResponseHeaders(raw: Record<string, string | string[]>): Headers {
  const headers = new Headers();
  for (const [key, value] of Object.entries(raw)) {
    // Chromium has already decompressed the body by the time we see it, so
    // leaving this in would tell the caller to unzip plain bytes.
    if (key.toLowerCase() === 'content-encoding') continue;
    for (const entry of Array.isArray(value) ? value : [value]) headers.append(key, String(entry));
  }
  return headers;
}

/**
 * Runs one request over Chromium's stack and answers with an ordinary Response,
 * so a caller cannot tell it apart from Node's fetch.
 *
 * It goes through `net.request` rather than the shorter `net.fetch` for one
 * reason: only a ClientRequest raises the `login` event, and that event is the
 * only way to answer a proxy that asks for a username and password.
 */
function requestThroughChromium(
  input: Parameters<typeof globalThis.fetch>[0],
  init: RequestInit | undefined,
  target: Session,
  credentials: { username: string; password: string },
): Promise<Response> {
  const request = new Request(input as string, init);

  return (async (): Promise<Response> => {
    const body =
      request.method === 'GET' || request.method === 'HEAD'
        ? null
        : Buffer.from(await request.arrayBuffer());

    return new Promise<Response>((resolve, reject) => {
      const clientRequest = net.request({
        method: request.method,
        url: request.url,
        session: target,
        // Off by default so nothing of the app's own browsing state rides
        // along, but a caller that set its own Cookie header (the Cursor usage
        // provider authenticates that way) needs it on or Chromium drops it.
        useSessionCookies: request.headers.has('cookie'),
        redirect: request.redirect === 'manual' ? 'manual' : 'follow',
      });

      for (const [key, value] of request.headers) clientRequest.setHeader(key, value);

      /**
       * Chromium raises this again for as long as it keeps being answered, so
       * the credentials get exactly one try: a wrong password would otherwise
       * loop against the proxy forever.
       *
       * Every other case answers empty, which is how Electron is told to give
       * up. Leaving the callback alone instead makes the request hang until the
       * caller's own timeout, and several callers have none.
       */
      let answered = false;
      clientRequest.on('login', (authInfo, callback) => {
        // A site's own challenge is not ours to answer, only the proxy's.
        if (!authInfo.isProxy || !credentials.username || answered) {
          callback();
          return;
        }
        answered = true;
        callback(credentials.username, credentials.password);
      });

      const signal = init?.signal ?? request.signal;
      const onAbort = (): void => {
        clientRequest.abort();
        reject(signal.reason ?? new Error('The operation was aborted.'));
      };
      if (signal.aborted) {
        onAbort();
        return;
      }
      signal.addEventListener('abort', onAbort, { once: true });

      clientRequest.on('response', (response) => {
        const chunks: Buffer[] = [];
        response.on('data', (chunk: Buffer) => chunks.push(chunk));
        response.on('end', () => {
          signal.removeEventListener('abort', onAbort);
          const status = response.statusCode;
          // Response refuses a body on these, and Chromium sends none anyway.
          const bodyless = status === 204 || status === 205 || status === 304;
          resolve(
            new Response(bodyless ? null : Buffer.concat(chunks), {
              status,
              statusText: response.statusMessage,
              headers: toResponseHeaders(response.headers),
            }),
          );
        });
        response.on('error', (error: Error) => {
          signal.removeEventListener('abort', onAbort);
          reject(error);
        });
      });

      clientRequest.on('error', (error) => {
        signal.removeEventListener('abort', onAbort);
        reject(error);
      });

      if (body?.length) clientRequest.write(body);
      clientRequest.end();
    });
  })();
}

/**
 * Sends the main process's own `fetch` through Chromium instead of Node while a
 * proxy is on. Chromium is what already knows how to talk to an HTTP, HTTPS, or
 * SOCKS proxy, how to read this machine's settings, and how to run a PAC
 * script, so every caller in the app gets all of that without changing a line.
 *
 * Direct mode still uses Node's fetch, so turning the feature off puts requests
 * back on exactly the path they took before.
 */
export function installProxyFetch(): void {
  if (fetchInstalled) return;
  fetchInstalled = true;

  type FetchInput = Parameters<typeof globalThis.fetch>[0];
  globalThis.fetch = ((input: FetchInput, init?: RequestInit) => {
    if (!isProxyActive(current) || !app.isReady()) return nodeFetch(input, init);
    return requestThroughChromium(input, init, session.defaultSession, current);
  }) as typeof globalThis.fetch;
}

/**
 * Covers the windows rather than the main process: a proxy challenge raised by
 * something a BrowserWindow loaded is answered here, since only a ClientRequest
 * carries its own login event.
 */
export function registerProxyAuthHandler(): void {
  app.on('login', (event, _webContents, _details, authInfo, callback) => {
    if (!authInfo.isProxy) return;
    const credentials = pendingTestAuth ?? current;
    if (!credentials.username) return;
    event.preventDefault();
    callback(credentials.username, credentials.password);
  });
}

export async function getProxyStatus(): Promise<ProxyStatus> {
  const systemServer = await resolveSystemProxy();
  const effectiveServer =
    current.mode === 'manual'
      ? proxyServerUrl(current)
      : current.mode === 'system'
        ? systemServer
        : null;
  return { mode: current.mode, effectiveServer, systemServer };
}

/**
 * Runs one request through a candidate proxy on a throwaway session, so a
 * server can be checked before it is saved and a bad one never takes the app
 * offline. The probe reports the address it saw, which is what tells the user
 * the traffic really went through the proxy.
 */
export async function testProxy(candidate: ProxySettings): Promise<ProxyTestResult> {
  const settings = normalizeProxySettings(candidate);
  const startedAt = Date.now();
  try {
    const testSession = session.fromPartition(TEST_PARTITION, { cache: false });
    await testSession.setProxy(electronProxyConfig(settings));
    await testSession.closeAllConnections();
    pendingTestAuth = { username: settings.username, password: settings.password };

    const response = await requestThroughChromium(
      PROBE_URL,
      { signal: AbortSignal.timeout(TEST_TIMEOUT_MS) },
      testSession,
      settings,
    );
    const latencyMs = Date.now() - startedAt;
    if (!response.ok) {
      return {
        ok: false,
        latencyMs,
        ip: null,
        country: null,
        error:
          response.status === 407
            ? 'The proxy rejected the username and password.'
            : `The proxy answered with status ${response.status}.`,
      };
    }
    const record = (await response.json()) as Record<string, unknown>;
    return {
      ok: true,
      latencyMs,
      ip: typeof record.ip === 'string' ? record.ip : null,
      country: typeof record.country === 'string' ? record.country : null,
      error: null,
    };
  } catch (error) {
    return {
      ok: false,
      latencyMs: null,
      ip: null,
      country: null,
      error: error instanceof Error ? error.message : 'The test request failed.',
    };
  } finally {
    pendingTestAuth = null;
  }
}
