import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * The website's news API on loopback for the news e2e (E42), in the test process. It answers the
 * two endpoints the app reads (main/news/client.ts) with bodies shaped like
 * docs/website/api-contract.md, and records every request.
 *
 * The items cover what the spec checks: a critical security fix for Runova itself (range `*`, so
 * it matches whatever version is under test and raises the one notification), a high security
 * item for a tool this machine is not known to have, and release and AI news for the filters.
 */

export interface FakeNewsItem {
  id: number;
  slug: string;
  title: string;
  category: string;
  severity: string;
  technologies: {
    technology: string;
    name: string;
    versionRange: string;
    fixedIn: string | null;
  }[];
}

/** Matches the running app, whatever its version: the affected badge and the notification. */
export const RUNOVA_FIX: FakeNewsItem = {
  id: 9001,
  slug: 'runova-update-fixes-a-critical-flaw',
  title: 'Runova update fixes a critical flaw',
  category: 'security',
  severity: 'critical',
  technologies: [{ technology: 'runova', name: 'Runova', versionRange: '*', fixedIn: '99.0.0' }],
};

/** A security item for a technology the app cannot detect here, so it matches nothing. */
export const OTHER_FIX: FakeNewsItem = {
  id: 9002,
  slug: 'php-patches-a-session-bug',
  title: 'PHP patches a session bug',
  category: 'security',
  severity: 'high',
  technologies: [{ technology: 'php', name: 'PHP', versionRange: '<8.3.9', fixedIn: '8.3.9' }],
};

export const RELEASE: FakeNewsItem = {
  id: 9003,
  slug: 'typescript-6-is-out',
  title: 'TypeScript 6 is out',
  category: 'release',
  severity: 'info',
  technologies: [],
};

export const AI_NEWS: FakeNewsItem = {
  id: 9004,
  slug: 'a-new-coding-model-ships',
  title: 'A new coding model ships',
  category: 'ai',
  severity: 'low',
  technologies: [],
};

export const NEWS_ITEMS = [RUNOVA_FIX, OTHER_FIX, RELEASE, AI_NEWS];

function listItem(item: FakeNewsItem, index: number): Record<string, unknown> {
  // Newest first, an hour apart.
  const publishedAt = new Date(Date.now() - (index + 1) * 3_600_000).toISOString();
  return {
    id: item.id,
    slug: item.slug,
    url: `https://runovahq.com/news/${item.slug}`,
    title: item.title,
    summary: `${item.title}. A summary for the e2e test.`,
    category: item.category,
    severity: item.severity,
    technologies: item.technologies,
    cveIds: item.category === 'security' ? [`CVE-2026-${item.id}`] : [],
    cvssScore: item.severity === 'critical' ? 9.8 : null,
    tags: [],
    publishedAt,
    updatedAt: publishedAt,
  };
}

export interface RecordedNewsRequest {
  method: string;
  /** Path and query, as the app sent them. */
  url: string;
  userAgent: string | null;
  cookie: string | null;
}

export interface FakeNewsServer {
  /** What RUNOVA_NEWS_API_URL is set to: the API base, without a trailing slash. */
  apiUrl: string;
  requests: RecordedNewsRequest[];
  /** Requests whose path (without the query) is `path`. */
  requestsTo: (path: string) => RecordedNewsRequest[];
  close: () => Promise<void>;
}

function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

export async function startFakeNews(): Promise<FakeNewsServer> {
  const requests: RecordedNewsRequest[] = [];
  const items = NEWS_ITEMS.map(listItem);

  const route = (request: IncomingMessage, response: ServerResponse) => {
    const path = new URL(request.url ?? '/', 'http://fake.news').pathname;
    if (request.method !== 'GET') return json(response, { title: 'Method not allowed' }, 405);
    if (path === '/api/v1/news') {
      json(response, {
        items,
        page: 1,
        pageSize: 50,
        totalItems: items.length,
        totalPages: 1,
      });
      return;
    }
    const match = path.match(/^\/api\/v1\/news\/([^/]+)$/);
    const item = match ? items.find((one) => one.slug === decodeURIComponent(match[1])) : null;
    if (!item) return json(response, { title: 'Not found' }, 404);
    json(response, {
      ...item,
      bodyHtml: `<p>${String(item.summary)}</p><p>Update as soon as you can.</p>`,
      sourceLinks: [{ title: 'Advisory', url: `https://example.com/advisories/${item.id}` }],
    });
  };

  const server = createServer((request, response) => {
    requests.push({
      method: request.method ?? 'GET',
      url: request.url ?? '/',
      userAgent: request.headers['user-agent'] ?? null,
      cookie: request.headers.cookie ?? null,
    });
    try {
      route(request, response);
    } catch {
      json(response, { title: 'Fake news API failed' }, 500);
    }
    request.resume();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    apiUrl: `http://127.0.0.1:${port}/api/v1`,
    requests,
    requestsTo: (path) => requests.filter((request) => request.url.split('?')[0] === path),
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
