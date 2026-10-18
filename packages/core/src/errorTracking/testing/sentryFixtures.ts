/**
 * Sentry responses shaped like the real API (docs.sentry.io/api, checked 2026-10-18), trimmed to
 * the fields the parsers read plus a few they must ignore. The secrets, emails and addresses in
 * them are fake and exist so the tests can prove none of them survives parsing.
 */

export const FAKE_EMAIL = 'jane.doe@example.com';
export const FAKE_IP = '203.0.113.42';
export const FAKE_COOKIE = 'session=s3cr3t-cookie-value';
export const FAKE_BEARER = 'Bearer abcdef1234567890abcdef';
export const FAKE_QUERY_TOKEN = 'tok_live_9f8e7d6c5b4a';

/** Everything in the fixtures below that must never survive parsing or reach a prompt. */
export const FAKE_LITERALS = [
  FAKE_EMAIL,
  FAKE_IP,
  FAKE_COOKIE,
  FAKE_BEARER,
  FAKE_QUERY_TOKEN,
  'pa55word',
  'hunter2',
  'sk_live_51abcdefghijklmnop',
  's3cr3t-cookie-value',
  '4242424242424242',
  'Mozilla/5.0',
  'Jane Doe',
];

/** GET /api/0/organizations/ */
export const sentryOrganizations = [
  {
    id: '1',
    slug: 'acme',
    name: 'Acme',
    links: {
      organizationUrl: 'https://acme.sentry.io',
      regionUrl: 'https://de.sentry.io',
    },
    features: ['issue-stream'],
  },
  {
    id: '2',
    slug: 'side-project',
    name: 'Side Project',
    links: { organizationUrl: 'https://side-project.sentry.io', regionUrl: 'https://us.sentry.io' },
  },
  // Self-hosted Sentry and GlitchTip send no links.
  { id: '3', slug: 'selfhosted', name: 'Self Hosted' },
  // Not an organization at all: dropped.
  { id: 4 },
];

/** GET /api/0/organizations/{org}/projects/ */
export const sentryProjects = [
  { id: '101', slug: 'storefront-web', name: 'storefront-web', platform: 'javascript-react' },
  { id: '102', slug: 'storefront-api', name: 'storefront-api', platform: 'node' },
  { id: '103', slug: 'billing-worker', name: 'Billing Worker', platform: null },
  { slug: 'broken' },
];

/** GET /api/0/projects/{org}/{project}/environments/ */
export const sentryEnvironments = [
  { id: '1', name: 'production', isHidden: false },
  { id: '2', name: 'staging', isHidden: false },
  { id: '3', name: 'old-qa', isHidden: true },
];

/** One issue of GET /api/0/organizations/{org}/issues/?statsPeriod=24h */
export const sentryIssue = {
  id: '4501',
  shortId: 'STOREFRONT-API-3F',
  title: "TypeError: Cannot read properties of undefined (reading 'total')",
  culprit: 'POST /api/checkout',
  level: 'error',
  status: 'unresolved',
  substatus: 'ongoing',
  // Sentry sends the event count as a string.
  count: '1287',
  userCount: 214,
  firstSeen: '2026-10-17T08:12:44.120000Z',
  lastSeen: '2026-10-18T09:58:02.000000Z',
  permalink: 'https://acme.sentry.io/issues/4501/',
  logger: null,
  type: 'error',
  metadata: {
    type: 'TypeError',
    value: "Cannot read properties of undefined (reading 'total')",
    filename: 'src/routes/checkout.ts',
    function: 'computeTotals',
  },
  project: { id: '102', name: 'storefront-api', slug: 'storefront-api' },
  stats: {
    '24h': [
      [1760774400, 3],
      [1760778000, 0],
      [1760781600, 12],
      [1760785200, 40],
    ],
  },
  annotations: [],
  assignedTo: null,
  isBookmarked: false,
  hasSeen: true,
  numComments: 0,
};

export const sentryIssueWarning = {
  ...sentryIssue,
  id: '4502',
  shortId: 'STOREFRONT-WEB-1A',
  title: `Slow checkout for ${FAKE_EMAIL}`,
  culprit: 'app/checkout/page.tsx',
  level: 'warning',
  status: 'ignored',
  count: '9',
  userCount: 3,
  firstSeen: '2026-09-01T10:00:00Z',
  project: { id: '101', name: 'storefront-web', slug: 'storefront-web' },
  stats: { '14d': [[1760000000, 1]] },
};

/** A list response, with one entry that is not an issue. */
export const sentryIssues = [sentryIssue, sentryIssueWarning, { id: 'x' }];

/** The `Link` header Sentry sends with a list. */
export const sentryLinkHeader =
  '<https://de.sentry.io/api/0/organizations/acme/issues/?cursor=1760785200000:0:1>; rel="previous"; results="false"; cursor="1760785200000:0:1", ' +
  '<https://de.sentry.io/api/0/organizations/acme/issues/?cursor=1760785200000:100:0>; rel="next"; results="true"; cursor="1760785200000:100:0"';

export const sentryLinkHeaderLastPage =
  '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:0:1>; rel="previous"; results="true"; cursor="0:0:1", ' +
  '<https://sentry.io/api/0/organizations/acme/issues/?cursor=0:200:0>; rel="next"; results="false"; cursor="0:200:0"';

function frame(
  filename: string,
  fn: string,
  lineNo: number,
  inApp: boolean,
  context: Array<[number, string]> = [],
) {
  return {
    filename,
    absPath: `/srv/app/${filename}`,
    function: fn,
    module: null,
    lineNo,
    colNo: 17,
    inApp,
    context,
    vars: { password: 'hunter2', orderId: 'ord_1' },
    package: null,
    platform: null,
    instructionAddr: null,
    symbolAddr: null,
    symbol: null,
    trust: null,
    errors: null,
  };
}

/** GET /api/0/organizations/{org}/issues/{id}/events/latest/ */
export const sentryEvent = {
  id: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  eventID: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
  groupID: '4501',
  projectID: '102',
  title: "TypeError: Cannot read properties of undefined (reading 'total')",
  message: '',
  platform: 'node',
  dateCreated: '2026-10-18T09:58:02.000000Z',
  dateReceived: '2026-10-18T09:58:03.000000Z',
  culprit: 'POST /api/checkout',
  type: 'error',
  size: 9123,
  entries: [
    {
      type: 'exception',
      data: {
        excOmitted: null,
        hasSystemFrames: true,
        values: [
          {
            type: 'PostgresError',
            value: `connection to postgres://app:pa55word@db.internal:5432/shop failed for ${FAKE_IP}`,
            module: null,
            threadId: null,
            mechanism: { type: 'generic', handled: true },
            stacktrace: {
              frames: [frame('node_modules/pg/lib/client.js', 'Client.connect', 132, false)],
              framesOmitted: null,
              registers: null,
              hasSystemFrames: true,
            },
            rawStacktrace: null,
          },
          {
            type: 'TypeError',
            value: "Cannot read properties of undefined (reading 'total')",
            module: null,
            threadId: null,
            mechanism: { type: 'onunhandledrejection', handled: false },
            stacktrace: {
              frames: [
                frame('node:internal/process/task_queues', 'processTicksAndRejections', 95, false),
                frame('node_modules/express/lib/router/layer.js', 'Layer.handle', 95, false),
                frame('src/routes/checkout.ts', 'handleCheckout', 41, true, [
                  [40, '  const cart = await loadCart(req.session.cartId);'],
                  [41, '  const totals = computeTotals(cart);'],
                  [42, '  res.json(totals);'],
                ]),
                frame('src/lib/totals.ts', 'computeTotals', 12, true, [
                  [11, 'export function computeTotals(cart: Cart) {'],
                  [12, '  return { total: cart.summary.total, tax: cart.summary.tax };'],
                  [13, '}'],
                ]),
              ],
              framesOmitted: null,
              registers: null,
              hasSystemFrames: true,
            },
            rawStacktrace: null,
          },
        ],
      },
    },
    {
      type: 'breadcrumbs',
      data: {
        values: [
          {
            category: 'http',
            level: 'info',
            event_id: null,
            timestamp: '2026-10-18T09:57:59.000Z',
            type: 'http',
            message: null,
            data: { method: 'GET', url: '/api/cart', status_code: 200 },
          },
          {
            category: 'console',
            level: 'log',
            event_id: null,
            timestamp: '2026-10-18T09:58:00.000Z',
            type: 'default',
            message: `user ${FAKE_EMAIL} from ${FAKE_IP} started checkout, api_key=sk_live_51abcdefghijklmnop`,
            data: null,
          },
          {
            category: 'query',
            level: 'info',
            event_id: null,
            timestamp: '2026-10-18T09:58:01.000Z',
            type: 'default',
            message: 'SELECT * FROM carts WHERE id = $1',
            data: null,
          },
        ],
      },
    },
    {
      type: 'request',
      data: {
        method: 'POST',
        url: `https://user:secret@shop.example.com/api/checkout?token=${FAKE_QUERY_TOKEN}&step=2#pay`,
        query: [
          ['token', FAKE_QUERY_TOKEN],
          ['step', '2'],
        ],
        headers: [
          ['Authorization', FAKE_BEARER],
          ['Cookie', FAKE_COOKIE],
          ['User-Agent', 'Mozilla/5.0'],
        ],
        cookies: [['session', 's3cr3t-cookie-value']],
        data: { card: '4242424242424242' },
        env: { REMOTE_ADDR: FAKE_IP },
        fragment: 'pay',
        inferredContentType: 'application/json',
      },
    },
  ],
  tags: [
    { key: 'environment', value: 'production' },
    { key: 'release', value: 'storefront-api@2.14.0' },
    { key: 'server_name', value: 'web-1' },
    { key: 'user.email', value: FAKE_EMAIL },
    { key: 'user.ip', value: FAKE_IP },
  ],
  user: {
    id: 'usr_8812',
    email: FAKE_EMAIL,
    ip_address: FAKE_IP,
    username: 'jane',
    name: 'Jane Doe',
    data: null,
  },
  contexts: { os: { name: 'Linux' }, runtime: { name: 'node', version: 'v22.4.0' } },
  release: { version: 'storefront-api@2.14.0', dateCreated: '2026-10-17T00:00:00Z' },
  sdk: { name: 'sentry.javascript.node', version: '9.1.0' },
};

/** A message event: no exception, just text. */
export const sentryMessageEvent = {
  eventID: 'ffff0000ffff0000ffff0000ffff0000',
  dateCreated: '2026-10-18T10:00:00Z',
  platform: 'python',
  message: `Payment webhook retried 5 times for ${FAKE_EMAIL}`,
  entries: [
    { type: 'message', data: { formatted: `Payment webhook retried 5 times for ${FAKE_EMAIL}` } },
  ],
  tags: [{ key: 'environment', value: 'staging' }],
  user: null,
  release: null,
};
