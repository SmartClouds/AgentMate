import type { ErrorEvent, ErrorException, ErrorFrame, Project } from '@agentmat/core';
import type {
  ErrorConnectionSummary,
  ErrorIssueDetail,
  ErrorIssuePage,
  ErrorIssueSummary,
  ErrorProjectLink,
  ErrorTokenCheck,
  RemoteProject,
} from '@shared/errorTrackingTypes';

/** Test data for the Errors tab. Times are fixed so relative labels are stable. */

export const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);

const iso = (msAgo: number): string => new Date(NOW - msAgo).toISOString();

export function project(overrides: Partial<Project> = {}): Project {
  return {
    id: 'p1',
    name: 'Storefront',
    folderPath: 'C:\\work\\storefront',
    repoUrl: '',
    cliId: 'claude-code',
    ...overrides,
  } as Project;
}

export function connection(
  overrides: Partial<ErrorConnectionSummary> = {},
): ErrorConnectionSummary {
  return {
    id: 'c1',
    provider: 'sentry',
    label: 'Acme',
    host: 'https://sentry.io',
    apiBase: 'https://us.sentry.io',
    orgSlug: 'acme',
    orgName: 'Acme',
    scopes: ['org:read', 'project:read', 'event:read', 'event:write'],
    canWrite: true,
    locked: false,
    createdAt: NOW - 86_400_000,
    checkedAt: NOW - 60_000,
    problem: null,
    ...overrides,
  };
}

export function link(overrides: Partial<ErrorProjectLink> = {}): ErrorProjectLink {
  return {
    projectId: 'p1',
    connectionId: 'c1',
    remoteProjectId: '11',
    remoteSlug: 'storefront-web',
    remoteName: 'storefront-web',
    ...overrides,
  };
}

export function remoteProject(overrides: Partial<RemoteProject> = {}): RemoteProject {
  return {
    id: '11',
    slug: 'storefront-web',
    name: 'storefront-web',
    platform: 'javascript',
    ...overrides,
  };
}

export function issue(overrides: Partial<ErrorIssueSummary> = {}): ErrorIssueSummary {
  return {
    id: '4501',
    shortId: 'WEB-3F',
    title: "TypeError: Cannot read properties of undefined (reading 'total')",
    culprit: 'checkout/summary.ts in computeTotal',
    level: 'error',
    status: 'unresolved',
    count: 1240,
    userCount: 87,
    firstSeen: iso(3 * 86_400_000),
    lastSeen: iso(120_000),
    permalink: 'https://acme.sentry.io/issues/4501/',
    remoteProjectId: '11',
    remoteProjectSlug: 'storefront-web',
    trend: [0, 1, 4, 2, 0, 0, 6, 9, 3, 1, 0, 2, 5, 7, 8, 2, 0, 1, 3, 0, 0, 2, 4, 12],
    connectionId: 'c1',
    projectId: 'p1',
    isNew: false,
    ...overrides,
  };
}

export function page(overrides: Partial<ErrorIssuePage> = {}): ErrorIssuePage {
  return {
    issues: [issue()],
    nextCursor: null,
    failures: [],
    fetchedAt: NOW - 120_000,
    ...overrides,
  };
}

export function frame(overrides: Partial<ErrorFrame> = {}): ErrorFrame {
  return {
    filename: 'src/checkout/summary.ts',
    function: 'computeTotal',
    module: null,
    lineNo: 42,
    colNo: 17,
    inApp: true,
    context: [
      [40, 'export function computeTotal(cart: Cart) {'],
      [41, '  const lines = cart.lines;'],
      [42, '  return lines.total + cart.shipping;'],
      [43, '}'],
    ],
    ...overrides,
  };
}

export function exception(overrides: Partial<ErrorException> = {}): ErrorException {
  return {
    type: 'TypeError',
    value: "Cannot read properties of undefined (reading 'total')",
    module: null,
    handled: false,
    frames: [
      frame({
        filename: 'node_modules/react-dom/cjs/react-dom.js',
        function: 'invokeGuarded',
        inApp: false,
        lineNo: 4012,
        context: [],
      }),
      frame({
        filename: 'node_modules/react-dom/cjs/react-dom.js',
        function: 'commitRoot',
        inApp: false,
        lineNo: 3001,
        context: [],
      }),
      frame({
        filename: 'src/checkout/Page.tsx',
        function: 'CheckoutPage',
        lineNo: 18,
        context: [[18, '  const total = computeTotal(cart);']],
      }),
      frame(),
    ],
    ...overrides,
  };
}

export function event(overrides: Partial<ErrorEvent> = {}): ErrorEvent {
  return {
    eventId: 'e9f1',
    dateCreated: iso(120_000),
    platform: 'javascript',
    message: null,
    exceptions: [exception()],
    breadcrumbs: [
      {
        timestamp: iso(180_000),
        category: 'navigation',
        level: 'info',
        message: 'From /cart to /checkout',
      },
      { timestamp: iso(125_000), category: 'xhr', level: 'error', message: 'GET /api/cart [500]' },
    ],
    request: { method: 'GET', url: 'https://shop.example.com/checkout?step=***' },
    tags: [
      { key: 'browser', value: 'Chrome 129' },
      { key: 'environment', value: 'production' },
    ],
    environment: 'production',
    release: 'web@2.4.1',
    userId: 'u_123',
    ...overrides,
  };
}

export function detail(overrides: Partial<ErrorIssueDetail> = {}): ErrorIssueDetail {
  return { issue: issue(), event: event(), canWrite: true, ...overrides };
}

export function tokenCheck(overrides: Partial<ErrorTokenCheck> = {}): ErrorTokenCheck {
  return {
    host: 'https://sentry.io',
    organizations: [
      { slug: 'acme', name: 'Acme', regionUrl: 'https://us.sentry.io' },
      { slug: 'side', name: 'Side project', regionUrl: null },
    ],
    scopes: ['org:read', 'project:read', 'event:read'],
    missingScopes: [],
    canWrite: false,
    warning: null,
    ...overrides,
  };
}
