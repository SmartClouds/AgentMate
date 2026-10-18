import type { IncomingMessage, ServerResponse } from 'node:http';
import { json, type LocalServer, startHttpServer } from './fixtures';

/**
 * A Sentry API on loopback for the error tracking tests (E24). It answers the endpoints the app
 * calls with responses shaped like the real API (the same shapes as
 * packages/core/src/errorTracking/testing/sentryFixtures.ts, which desktop cannot import), checks
 * the Bearer token the way Sentry does, and records every request so a test can see what was sent.
 *
 * `glitchtip` makes the organization-scoped issue paths 404 and answers the older per-project and
 * per-issue paths instead, which is what GlitchTip and old self-hosted Sentry expose. `override`
 * lets one test answer a path its own way (a 429, a redirect, a hang).
 */

export const FAKE_TOKEN = 'sntryu_fakeUserTokenThatMustNeverLeak_0123456789';
export const FAKE_EMAIL = 'jane.doe@example.com';

export const fakeOrganizations = [
  { id: '1', slug: 'acme', name: 'Acme' },
  { id: '2', slug: 'side-project', name: 'Side Project' },
];

export const fakeProjects = [
  { id: '101', slug: 'storefront-web', name: 'storefront-web', platform: 'javascript-react' },
  { id: '102', slug: 'storefront-api', name: 'storefront-api', platform: 'node' },
  { id: '103', slug: 'billing-worker', name: 'Billing Worker', platform: null },
];

export const fakeEnvironments: Record<string, unknown[]> = {
  'storefront-web': [
    { id: '1', name: 'production', isHidden: false },
    { id: '3', name: 'old-qa', isHidden: true },
  ],
  'storefront-api': [
    { id: '1', name: 'production', isHidden: false },
    { id: '2', name: 'staging', isHidden: false },
  ],
  'billing-worker': [],
};

export function fakeIssue(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    id: '4501',
    shortId: 'STOREFRONT-API-3F',
    title: "TypeError: Cannot read properties of undefined (reading 'total')",
    culprit: 'POST /api/checkout',
    level: 'error',
    status: 'unresolved',
    substatus: 'ongoing',
    count: '1287',
    userCount: 214,
    firstSeen: '2026-10-17T08:12:44.120000Z',
    lastSeen: '2026-10-18T09:58:02.000000Z',
    permalink: 'https://acme.sentry.io/issues/4501/',
    metadata: { type: 'TypeError', value: "Cannot read properties of undefined (reading 'total')" },
    project: { id: '102', name: 'storefront-api', slug: 'storefront-api' },
    stats: {
      '24h': [
        [1760774400, 3],
        [1760778000, 0],
        [1760781600, 12],
        [1760785200, 40],
      ],
    },
    ...overrides,
  };
}

export function fakeIssues(): Record<string, unknown>[] {
  return [
    fakeIssue(),
    fakeIssue({
      id: '4502',
      shortId: 'STOREFRONT-WEB-1A',
      title: `Slow checkout for ${FAKE_EMAIL}`,
      culprit: 'app/checkout/page.tsx',
      level: 'warning',
      count: '9',
      userCount: 3,
      firstSeen: '2026-09-01T10:00:00Z',
      lastSeen: '2026-10-18T08:00:00Z',
      permalink: 'https://acme.sentry.io/issues/4502/',
      project: { id: '101', name: 'storefront-web', slug: 'storefront-web' },
      stats: { '24h': [[1760000000, 1]] },
    }),
  ];
}

export function fakeEvent(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    eventID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
    dateCreated: '2026-10-18T09:58:02.000000Z',
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
                    filename: 'src/lib/totals.ts',
                    absPath: '/srv/app/src/lib/totals.ts',
                    function: 'computeTotals',
                    module: null,
                    lineNo: 12,
                    colNo: 17,
                    inApp: true,
                    context: [
                      [11, 'export function computeTotals(cart: Cart) {'],
                      [12, '  return { total: cart.summary.total, tax: cart.summary.tax };'],
                      [13, '}'],
                    ],
                    vars: { password: 'hunter2' },
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
              timestamp: '2026-10-18T09:58:00.000Z',
              type: 'default',
              message: `user ${FAKE_EMAIL} started checkout`,
            },
          ],
        },
      },
      {
        type: 'request',
        data: {
          method: 'POST',
          url: 'https://shop.example.com/api/checkout?token=tok_live_9f8e7d6c5b4a',
          headers: [['Cookie', 'session=s3cr3t-cookie-value']],
        },
      },
    ],
    tags: [
      { key: 'environment', value: 'production' },
      { key: 'release', value: 'storefront-api@2.14.0' },
    ],
    user: { id: 'usr_8812', email: FAKE_EMAIL },
    ...overrides,
  };
}

export interface FakeSentryOptions {
  token?: string;
  /** What `GET /api/0/` reports under `auth.scopes`; null leaves `auth` out. */
  scopes?: string[] | null;
  /** Sent as every organization's `links.regionUrl` when set. */
  regionUrl?: string | null;
  glitchtip?: boolean;
}

export interface FakeSentryState extends Required<FakeSentryOptions> {
  organizations: Record<string, unknown>[];
  projects: Record<string, unknown>[];
  issues: Record<string, unknown>[];
  /** By issue id; a missing id answers 404. */
  events: Record<string, unknown>;
  /** The Link header sent with an issue list, when set. */
  issueLink: string | null;
  /** Answers a request before the routes do; return true when it did. */
  override:
    | ((request: IncomingMessage, response: ServerResponse, url: URL) => boolean | undefined)
    | null;
}

export interface FakeSentry {
  url: string;
  state: FakeSentryState;
  requests: LocalServer['requests'];
  /** Requests whose path (without the query) is `path`. */
  requestsTo: (path: string, method?: string) => LocalServer['requests'];
  close: () => Promise<void>;
}

function notFound(response: ServerResponse): void {
  json(response, { detail: 'The requested resource does not exist' }, 404);
}

export async function startFakeSentry(options: FakeSentryOptions = {}): Promise<FakeSentry> {
  const state: FakeSentryState = {
    token: options.token ?? FAKE_TOKEN,
    scopes:
      options.scopes === undefined
        ? ['org:read', 'project:read', 'event:read', 'event:write']
        : options.scopes,
    regionUrl: options.regionUrl ?? null,
    glitchtip: options.glitchtip ?? false,
    organizations: fakeOrganizations.map((org) => ({ ...org })),
    projects: fakeProjects.map((project) => ({ ...project })),
    issues: fakeIssues(),
    events: { '4501': fakeEvent() },
    issueLink: null,
    override: null,
  };

  const issueById = (id: string) => state.issues.find((issue) => issue.id === id);

  const update = (response: ServerResponse, id: string, body: string) => {
    if (state.scopes && !state.scopes.includes('event:write')) {
      json(response, { detail: 'You do not have permission to perform this action.' }, 403);
      return;
    }
    const issue = issueById(id);
    if (!issue) return notFound(response);
    const change = JSON.parse(body || '{}') as Record<string, unknown>;
    Object.assign(issue, change);
    json(response, { ...change, statusDetails: {} });
  };

  const list = (response: ServerResponse, url: URL, slug: string | null) => {
    const ids = url.searchParams.getAll('project');
    const issues = state.issues.filter((issue) => {
      const project = issue.project as { id: string; slug: string };
      if (slug) return project.slug === slug;
      return ids.length === 0 || ids.includes(project.id);
    });
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (state.issueLink) headers.link = state.issueLink;
    response.writeHead(200, headers);
    response.end(JSON.stringify(issues));
  };

  const server = await startHttpServer((request, response, body) => {
    const url = new URL(request.url ?? '/', 'http://fake.sentry');
    if (state.override?.(request, response, url)) return;
    if (request.headers.authorization !== `Bearer ${state.token}`) {
      json(response, { detail: 'Invalid token' }, 401);
      return;
    }
    const path = url.pathname;
    const method = request.method ?? 'GET';
    let match: RegExpMatchArray | null;

    if (path === '/api/0/') {
      json(response, {
        version: '0',
        ...(state.scopes ? { auth: { scopes: state.scopes } } : {}),
        user: { id: '1', email: FAKE_EMAIL },
      });
      return;
    }
    if (path === '/api/0/organizations/') {
      json(
        response,
        state.organizations.map((org) =>
          state.regionUrl ? { ...org, links: { regionUrl: state.regionUrl } } : org,
        ),
      );
      return;
    }
    if ((match = path.match(/^\/api\/0\/organizations\/([^/]+)\/projects\/$/))) {
      json(response, state.projects);
      return;
    }
    if ((match = path.match(/^\/api\/0\/projects\/([^/]+)\/([^/]+)\/environments\/$/))) {
      const environments = fakeEnvironments[decodeURIComponent(match[2])];
      if (!environments) return notFound(response);
      json(response, environments);
      return;
    }
    if ((match = path.match(/^\/api\/0\/projects\/([^/]+)\/([^/]+)\/issues\/$/))) {
      if (!state.glitchtip) return notFound(response);
      list(response, url, decodeURIComponent(match[2]));
      return;
    }
    if ((match = path.match(/^\/api\/0\/organizations\/([^/]+)\/issues\/$/))) {
      if (state.glitchtip) return notFound(response);
      list(response, url, null);
      return;
    }
    match =
      path.match(/^\/api\/0\/organizations\/[^/]+\/issues\/([^/]+)\/(events\/latest\/)?$/) ??
      path.match(/^\/api\/0\/issues\/([^/]+)\/(events\/latest\/)?$/);
    if (match) {
      const legacy = path.startsWith('/api/0/issues/');
      if (legacy !== state.glitchtip) return notFound(response);
      const id = decodeURIComponent(match[1]);
      if (match[2]) {
        const event = state.events[id];
        if (!event) return notFound(response);
        json(response, event);
        return;
      }
      if (method === 'PUT') return update(response, id, body);
      const issue = issueById(id);
      if (!issue) return notFound(response);
      json(response, issue);
      return;
    }
    notFound(response);
  });

  return {
    url: server.url,
    state,
    requests: server.requests,
    requestsTo: (path, method) =>
      server.requests.filter(
        (request) =>
          request.url.split('?')[0] === path && (method === undefined || request.method === method),
      ),
    close: server.close,
  };
}
