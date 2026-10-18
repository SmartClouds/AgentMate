import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * A Sentry API on loopback for the error tracking e2e (E24), in the test process. It answers the
 * endpoints the app calls (main/errorTracking/sentryClient.ts) with responses shaped like the real
 * API, checks the Bearer token the way Sentry does, and records every request.
 *
 * The data follows src/test/main/fakeSentry.ts. That one cannot be imported here because its
 * helpers pull in Vitest. Unlike it, the issue list honours the `is:<status>` term of the query, so
 * a resolved issue stays out of the Unresolved list when the app reads it again.
 *
 * The latest event carries an email, an IP, a cookie, a query token and a bearer token in the
 * places a real SDK puts them, so the spec can show none of them reach the clipboard.
 */

export const SENTRY_TOKEN = 'sntryu_e2eUserTokenThatMustNeverLeak_9f3a71c0b2d4e6f8';
export const LEAK_EMAIL = 'jane.doe@example.com';
export const LEAK_IP = '203.0.113.42';
export const LEAK_COOKIE = 's3cr3t-cookie-value';
export const LEAK_QUERY_TOKEN = 'tok_live_9f8e7d6c5b4a';
export const LEAK_BEARER = 'eyJhbGciOiJIUzI1NiJ9.e2eAppSessionBearer.c2lnbmF0dXJl';
export const LEAK_PASSWORD = 'hunter2';

export const ORG = { id: '1', slug: 'acme', name: 'Acme' };

const PROJECTS = [
  { id: '101', slug: 'storefront-web', name: 'storefront-web', platform: 'javascript-react' },
  { id: '102', slug: 'storefront-api', name: 'storefront-api', platform: 'node' },
  { id: '103', slug: 'billing-worker', name: 'Billing Worker', platform: null },
];

const ENVIRONMENTS: Record<string, unknown[]> = {
  'storefront-web': [{ id: '1', name: 'production', isHidden: false }],
  'storefront-api': [
    { id: '1', name: 'production', isHidden: false },
    { id: '2', name: 'staging', isHidden: false },
  ],
  'billing-worker': [],
};

/** The issue with an event: a crash in the app's own code. */
export const CRASH = {
  id: '4501',
  shortId: 'STOREFRONT-API-3F',
  title: "TypeError: Cannot read properties of undefined (reading 'total')",
  error: "TypeError: Cannot read properties of undefined (reading 'total')",
  frame: {
    filename: 'src/lib/totals.ts',
    function: 'computeTotals',
    at: 'src/lib/totals.ts:12:17',
  },
};

/** The second issue, with no event, so the list holds more than the one being resolved. */
export const SLOW = { id: '4502', shortId: 'STOREFRONT-WEB-1A' };

function iso(msAgo: number): string {
  return new Date(Date.now() - msAgo).toISOString();
}

function issues(): Record<string, unknown>[] {
  const hour = 3_600_000;
  const now = Math.floor(Date.now() / 1000);
  return [
    {
      id: CRASH.id,
      shortId: CRASH.shortId,
      title: CRASH.title,
      culprit: 'POST /api/checkout',
      level: 'error',
      status: 'unresolved',
      substatus: 'ongoing',
      count: '1287',
      userCount: 214,
      firstSeen: iso(30 * hour),
      lastSeen: iso(5 * 60_000),
      permalink: 'https://acme.sentry.io/issues/4501/',
      metadata: {
        type: 'TypeError',
        value: "Cannot read properties of undefined (reading 'total')",
      },
      project: { id: '102', name: 'storefront-api', slug: 'storefront-api' },
      stats: {
        '24h': [
          [now - 3 * 3600, 3],
          [now - 2 * 3600, 0],
          [now - 3600, 12],
          [now, 40],
        ],
      },
    },
    {
      id: SLOW.id,
      shortId: SLOW.shortId,
      title: 'Slow checkout render',
      culprit: 'app/checkout/page.tsx',
      level: 'warning',
      status: 'unresolved',
      substatus: 'ongoing',
      count: '9',
      userCount: 3,
      firstSeen: iso(40 * 24 * hour),
      lastSeen: iso(2 * hour),
      permalink: 'https://acme.sentry.io/issues/4502/',
      metadata: { title: 'Slow checkout render' },
      project: { id: '101', name: 'storefront-web', slug: 'storefront-web' },
      stats: { '24h': [[now, 1]] },
    },
  ];
}

function crashEvent(): Record<string, unknown> {
  return {
    eventID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    dateCreated: iso(5 * 60_000),
    platform: 'node',
    message: '',
    entries: [
      {
        type: 'exception',
        data: {
          values: [
            {
              type: 'TypeError',
              value: "Cannot read properties of undefined (reading 'total')",
              module: null,
              mechanism: { type: 'onunhandledrejection', handled: false },
              stacktrace: {
                frames: [
                  {
                    filename: 'node_modules/express/lib/router/layer.js',
                    function: 'Layer.handle',
                    module: null,
                    lineNo: 95,
                    colNo: 5,
                    inApp: false,
                    context: [],
                  },
                  {
                    filename: CRASH.frame.filename,
                    absPath: '/srv/app/src/lib/totals.ts',
                    function: CRASH.frame.function,
                    module: null,
                    lineNo: 12,
                    colNo: 17,
                    inApp: true,
                    context: [
                      [11, 'export function computeTotals(cart: Cart) {'],
                      [12, '  return { total: cart.summary.total, tax: cart.summary.tax };'],
                      [13, '}'],
                    ],
                    vars: { password: LEAK_PASSWORD, cookie: LEAK_COOKIE },
                  },
                ],
              },
            },
          ],
        },
      },
      {
        type: 'breadcrumbs',
        data: {
          values: [
            {
              category: 'console',
              level: 'log',
              timestamp: iso(6 * 60_000),
              type: 'default',
              message: `user ${LEAK_EMAIL} from ${LEAK_IP} started checkout`,
            },
            {
              category: 'http',
              level: 'info',
              timestamp: iso(5 * 60_000 + 500),
              type: 'http',
              message: `POST /api/checkout Authorization: Bearer ${LEAK_BEARER}`,
            },
          ],
        },
      },
      {
        type: 'request',
        data: {
          method: 'POST',
          url: `https://shop.example.com/api/checkout?token=${LEAK_QUERY_TOKEN}`,
          headers: [
            ['Cookie', `session=${LEAK_COOKIE}`],
            ['Authorization', `Bearer ${LEAK_BEARER}`],
            ['X-Forwarded-For', LEAK_IP],
          ],
          cookies: [['session', LEAK_COOKIE]],
          env: { REMOTE_ADDR: LEAK_IP },
        },
      },
    ],
    tags: [
      { key: 'environment', value: 'production' },
      { key: 'release', value: 'storefront-api@2.14.0' },
      { key: 'user', value: `email:${LEAK_EMAIL}` },
      { key: 'user.ip', value: LEAK_IP },
    ],
    user: { id: 'usr_8812', email: LEAK_EMAIL, ip_address: LEAK_IP },
  };
}

export interface RecordedRequest {
  method: string;
  /** Path and query, as the app sent them. */
  url: string;
  authorization: string | null;
  body: string;
}

export interface FakeSentryServer {
  /** What the user types as the server URL. */
  url: string;
  requests: RecordedRequest[];
  /** Requests whose path (without the query) is `path`. */
  requestsTo: (path: string, method?: string) => RecordedRequest[];
  /** The issue's status as the fake holds it now. */
  statusOf: (id: string) => string | undefined;
  close: () => Promise<void>;
}

function json(
  response: ServerResponse,
  body: unknown,
  status = 200,
  headers: Record<string, string> = {},
): void {
  response.writeHead(status, { 'content-type': 'application/json', ...headers });
  response.end(JSON.stringify(body));
}

function notFound(response: ServerResponse): void {
  json(response, { detail: 'The requested resource does not exist' }, 404);
}

export async function startFakeSentry(): Promise<FakeSentryServer> {
  const state = {
    issues: issues(),
    events: { [CRASH.id]: crashEvent() } as Record<string, unknown>,
  };
  const requests: RecordedRequest[] = [];
  let base = '';

  const issueById = (id: string) => state.issues.find((issue) => issue.id === id);

  const route = (request: IncomingMessage, response: ServerResponse, body: string) => {
    const url = new URL(request.url ?? '/', 'http://fake.sentry');
    if (request.headers.authorization !== `Bearer ${SENTRY_TOKEN}`) {
      json(response, { detail: 'Invalid token' }, 401);
      return;
    }
    const path = url.pathname;
    const method = request.method ?? 'GET';
    let match: RegExpMatchArray | null;

    if (path === '/api/0/') {
      json(response, {
        version: '0',
        auth: { scopes: ['org:read', 'project:read', 'event:read', 'event:write'] },
        user: { id: '1', email: LEAK_EMAIL },
      });
      return;
    }
    if (path === '/api/0/organizations/') {
      json(response, [ORG]);
      return;
    }
    if (path === `/api/0/organizations/${ORG.slug}/projects/`) {
      json(response, PROJECTS);
      return;
    }
    if ((match = path.match(/^\/api\/0\/projects\/([^/]+)\/([^/]+)\/environments\/$/))) {
      const environments = ENVIRONMENTS[decodeURIComponent(match[2])];
      if (match[1] !== ORG.slug || !environments) return notFound(response);
      json(response, environments);
      return;
    }
    if (path === `/api/0/organizations/${ORG.slug}/issues/`) {
      const ids = url.searchParams.getAll('project');
      const status = (url.searchParams.get('query') ?? '').match(/\bis:(\w+)/)?.[1] ?? null;
      const listed = state.issues.filter((issue) => {
        const project = issue.project as { id: string };
        return (
          (ids.length === 0 || ids.includes(project.id)) && (!status || issue.status === status)
        );
      });
      // A first page with no further results, the way Sentry pages a short list.
      const cursor = '0:0:0';
      json(response, listed, 200, {
        link:
          `<${base}${path}?cursor=${cursor}>; rel="previous"; results="false"; cursor="${cursor}", ` +
          `<${base}${path}?cursor=0:100:0>; rel="next"; results="false"; cursor="0:100:0"`,
      });
      return;
    }
    match = path.match(
      new RegExp(`^/api/0/organizations/${ORG.slug}/issues/([^/]+)/(events/latest/)?$`),
    );
    if (match) {
      const id = decodeURIComponent(match[1]);
      if (match[2]) {
        const event = state.events[id];
        if (!event) return notFound(response);
        json(response, event);
        return;
      }
      const issue = issueById(id);
      if (!issue) return notFound(response);
      if (method === 'PUT') {
        const change = JSON.parse(body || '{}') as Record<string, unknown>;
        Object.assign(issue, change);
        json(response, { ...change, statusDetails: {} });
        return;
      }
      json(response, issue);
      return;
    }
    notFound(response);
  };

  const server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        authorization: request.headers.authorization ?? null,
        body,
      });
      try {
        route(request, response, body);
      } catch {
        json(response, { detail: 'Fake Sentry failed' }, 500);
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  base = `http://127.0.0.1:${port}`;
  return {
    url: base,
    requests,
    requestsTo: (path, method) =>
      requests.filter(
        (request) =>
          request.url.split('?')[0] === path && (method === undefined || request.method === method),
      ),
    statusOf: (id) => issueById(id)?.status as string | undefined,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
