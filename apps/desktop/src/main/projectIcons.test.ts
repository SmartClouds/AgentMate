import { EventEmitter } from 'node:events';
import { request as httpRequest } from 'node:http';
import type { ProxySettings } from '@runova/core';
import { defaultProxySettings } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { json, type LocalServer, startHttpServer } from '../test/main/fixtures';
import { useTempUserData } from '../test/main/ipcHarness';

/**
 * Finding a site's favicon, including the case that bit a real user: lakeoswegoairporter.com
 * got its icon tags after the app had already fetched the page, and "Use favicon" kept saying
 * the site had none. With the system proxy setting on (the default) the main process sends
 * `fetch` through Chromium, which keeps its own disk cache, and the site's `max-age=2678400`
 * made it answer from a copy that was weeks old.
 *
 * `net.request` is Electron's own client, which the mock does not carry. It is backed here by
 * node:http plus a small stand-in for Chromium's HTTP cache: anything the server marks as
 * cacheable is replayed without a network trip, unless the request opted out with `no-store`.
 */

interface StoredReply {
  statusCode: number;
  statusMessage: string;
  headers: Record<string, string | string[] | undefined>;
  body: Buffer;
}

/** Outlives a single fetch, the way Chromium's cache outlives the whole app session. */
const httpCache = new Map<string, StoredReply>();

function replay(client: EventEmitter, stored: StoredReply): void {
  const response = Object.assign(new EventEmitter(), {
    statusCode: stored.statusCode,
    statusMessage: stored.statusMessage,
    headers: stored.headers,
  });
  client.emit('response', response);
  response.emit('data', stored.body);
  response.emit('end');
}

function chromiumRequest(options: { url: string; method: string; cache?: string }): EventEmitter {
  const client = new EventEmitter();
  Object.assign(client, {
    setHeader: () => undefined,
    write: () => undefined,
    abort: () => undefined,
    end: () => {
      const bypass = options.cache === 'no-store';
      const stored = bypass ? undefined : httpCache.get(options.url);
      if (stored) {
        replay(client, stored);
        return;
      }
      const outgoing = httpRequest(options.url, { method: options.method }, (incoming) => {
        const chunks: Buffer[] = [];
        incoming.on('data', (chunk: Buffer) => chunks.push(chunk));
        incoming.on('end', () => {
          const reply: StoredReply = {
            statusCode: incoming.statusCode ?? 0,
            statusMessage: incoming.statusMessage ?? '',
            headers: incoming.headers,
            body: Buffer.concat(chunks),
          };
          if (!bypass && /max-age=[1-9]/.test(String(incoming.headers['cache-control'] ?? ''))) {
            httpCache.set(options.url, reply);
          }
          replay(client, reply);
        });
      });
      outgoing.on('error', (error) => client.emit('error', error));
      outgoing.end();
    },
  });
  return client;
}

vi.mock('electron', async (importOriginal) => {
  const actual = await importOriginal<Record<string, unknown>>();
  const actualSession = actual.session as {
    defaultSession: Record<string, unknown>;
    fromPartition: (partition: string) => Record<string, unknown>;
  };
  // Real sessions drop their open sockets when the route changes, and proxy.ts calls this.
  const withClose = (target: Record<string, unknown>): Record<string, unknown> =>
    Object.assign(target, { closeAllConnections: async () => undefined });
  return {
    ...actual,
    session: {
      ...actualSession,
      defaultSession: withClose(actualSession.defaultSession),
      fromPartition: (partition: string) => withClose(actualSession.fromPartition(partition)),
    },
    net: { ...(actual.net as Record<string, unknown>), request: chromiumRequest },
  };
});

useTempUserData();

/** Max-age of 31 days, the value the real site sends on its pages. */
const CACHEABLE = 'public, max-age=2678400';
/** Enough of a PNG for the icon pipeline, which only checks the type it was served as. */
const PNG = Buffer.from('89504e470d0a1a0a', 'hex');
const PNG_DATA_URL = `data:image/png;base64,${PNG.toString('base64')}`;

let server: LocalServer | null = null;

function viaProxy(): ProxySettings {
  return { ...defaultProxySettings(), mode: 'manual', host: '10.0.0.1', port: 8080 };
}

async function loadIcons() {
  return import('./projectIcons');
}

beforeEach(() => {
  httpCache.clear();
});

afterEach(async () => {
  await server?.close();
  server = null;
});

describe('fetchSiteFavicon', () => {
  it('prefers the largest declared icon of a WordPress style head', async () => {
    // The tags, in this order and with these attributes, are what lakeoswegoairporter.com serves.
    server = await startHttpServer((request, response) => {
      if (request.url?.startsWith('/assets/')) {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(PNG);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html; charset=UTF-8' });
      response.end(
        `<head>
<link rel="preload" as="image" href="${server?.url}/assets/hero.webp?v=1" fetchpriority="high">
<link rel="icon" href="${server?.url}/assets/favicon-32.png?v=1792886075" sizes="32x32">
<link rel="icon" href="${server?.url}/assets/site-icon.png?v=1792886075" sizes="512x512">
<link rel="apple-touch-icon" href="${server?.url}/assets/apple-touch-icon.png?v=1792886075">
<link rel="alternate" type="application/rss+xml" href="${server?.url}/feed/">
</head>`,
      );
    });
    const { fetchSiteFavicon } = await loadIcons();

    const result = await fetchSiteFavicon(`${server.url}/`);

    expect(result?.sourceUrl).toBe(`${server.url}/assets/site-icon.png?v=1792886075`);
    expect(result?.dataUrl).toBe(PNG_DATA_URL);
  });

  it('skips a /favicon.ico that is served empty and takes the next candidate', async () => {
    server = await startHttpServer((request, response) => {
      if (request.url === '/favicon.ico') {
        // Some hosts answer 200 with a zero length body for a missing icon.
        response.writeHead(200, { 'content-type': 'image/x-icon', 'content-length': '0' });
        response.end();
        return;
      }
      if (request.url === '/apple-touch-icon.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(PNG);
        return;
      }
      json(response, { ok: false }, 404);
    });
    const { fetchSiteFavicon } = await loadIcons();

    const result = await fetchSiteFavicon(server.url);

    expect(result?.sourceUrl).toBe(`${server.url}/apple-touch-icon.png`);
  });
});

describe('fetchSiteFavicon through the proxy shim', () => {
  async function installShim(): Promise<void> {
    const { applyProxySettings, installProxyFetch } = await import('./network/proxy');
    await applyProxySettings(viaProxy());
    installProxyFetch();
  }

  it('sees an icon the site added after the page was first fetched', async () => {
    let declaresIcon = false;
    server = await startHttpServer((request, response) => {
      if (request.url === '/icon.png') {
        response.writeHead(200, { 'content-type': 'image/png' });
        response.end(PNG);
        return;
      }
      if (request.url === '/') {
        response.writeHead(200, { 'content-type': 'text/html', 'cache-control': CACHEABLE });
        response.end(`<head>${declaresIcon ? '<link rel="icon" href="/icon.png">' : ''}</head>`);
        return;
      }
      json(response, { ok: false }, 404);
    });
    await installShim();
    const { fetchSiteFavicon } = await loadIcons();

    // The page as the site first shipped it, with no icon tags yet.
    expect(await fetchSiteFavicon(server.url)).toBeNull();

    declaresIcon = true;
    const result = await fetchSiteFavicon(server.url);

    // A reply replayed from Chromium's cache would still show the old page, and the app would
    // tell the user the site has no favicon while their browser shows one.
    expect(result?.sourceUrl).toBe(`${server.url}/icon.png`);
    expect(server.requests.filter((r) => r.url === '/')).toHaveLength(2);
  });

  it('does not keep serving an icon the site has since replaced', async () => {
    let iconPath = '/old.png';
    server = await startHttpServer((request, response) => {
      if (request.url === '/old.png' || request.url === '/new.png') {
        response.writeHead(200, { 'content-type': 'image/png', 'cache-control': CACHEABLE });
        response.end(PNG);
        return;
      }
      response.writeHead(200, { 'content-type': 'text/html', 'cache-control': CACHEABLE });
      response.end(`<head><link rel="icon" href="${iconPath}"></head>`);
    });
    await installShim();
    const { fetchSiteFavicon } = await loadIcons();

    expect((await fetchSiteFavicon(server.url))?.sourceUrl).toBe(`${server.url}/old.png`);

    iconPath = '/new.png';

    expect((await fetchSiteFavicon(server.url))?.sourceUrl).toBe(`${server.url}/new.png`);
  });
});
