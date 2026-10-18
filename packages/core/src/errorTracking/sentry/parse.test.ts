import { describe, expect, it } from 'vitest';
import * as errorTracking from '../index.js';
import {
  FAKE_EMAIL,
  FAKE_IP,
  FAKE_LITERALS,
  FAKE_QUERY_TOKEN,
  sentryEnvironments,
  sentryEvent,
  sentryIssue,
  sentryIssues,
  sentryIssueWarning,
  sentryMessageEvent,
  sentryOrganizations,
  sentryProjects,
} from '../testing/sentryFixtures.js';
import { MAX_BREADCRUMBS } from '../types.js';
import {
  parseSentryEnvironments,
  parseSentryEvent,
  parseSentryIssue,
  parseSentryIssues,
  parseSentryOrganizations,
  parseSentryProjects,
} from './parse.js';

/**
 * Sentry's JSON is read leniently (one odd entry is dropped, the rest still shows) and scrubbed on
 * the way in, so nothing past the parser holds a header, a cookie, an email or an IP address.
 */

describe('the module index', () => {
  it('exports the parsers', () => {
    expect(errorTracking.parseSentryIssue).toBe(parseSentryIssue);
  });
});

describe('parseSentryIssue', () => {
  it('reads an issue into the neutral shape', () => {
    expect(parseSentryIssue(sentryIssue)).toEqual({
      id: '4501',
      shortId: 'STOREFRONT-API-3F',
      title: "TypeError: Cannot read properties of undefined (reading 'total')",
      culprit: 'POST /api/checkout',
      level: 'error',
      status: 'unresolved',
      count: 1287,
      userCount: 214,
      firstSeen: '2026-10-17T08:12:44.120000Z',
      lastSeen: '2026-10-18T09:58:02.000000Z',
      permalink: 'https://acme.sentry.io/issues/4501/',
      remoteProjectId: '102',
      remoteProjectSlug: 'storefront-api',
      trend: [3, 0, 12, 40],
    });
  });

  it('turns the count string into a number, and garbage into 0', () => {
    expect(parseSentryIssue({ ...sentryIssue, count: 55 })?.count).toBe(55);
    expect(parseSentryIssue({ ...sentryIssue, count: 'lots' })?.count).toBe(0);
    expect(parseSentryIssue({ ...sentryIssue, count: undefined, userCount: '7' })).toMatchObject({
      count: 0,
      userCount: 7,
    });
  });

  it('reads the levels it knows and treats anything else as an error', () => {
    const levels: Array<[unknown, string]> = [
      ['fatal', 'fatal'],
      ['warning', 'warning'],
      ['warn', 'warning'],
      ['info', 'info'],
      ['debug', 'debug'],
      ['sample', 'error'],
      [undefined, 'error'],
    ];
    for (const [level, expected] of levels) {
      expect(parseSentryIssue({ ...sentryIssue, level })?.level, String(level)).toBe(expected);
    }
  });

  it('maps statuses, with anything unknown read as unresolved', () => {
    const statuses: Array<[unknown, unknown, string]> = [
      ['resolved', undefined, 'resolved'],
      ['resolvedInNextRelease', undefined, 'resolved'],
      ['resolved_in_next_release', undefined, 'resolved'],
      ['ignored', undefined, 'ignored'],
      ['muted', undefined, 'ignored'],
      ['archived', undefined, 'ignored'],
      ['unresolved', 'archived_until_escalating', 'ignored'],
      ['unresolved', 'ongoing', 'unresolved'],
      ['reprocessing', undefined, 'unresolved'],
      [undefined, undefined, 'unresolved'],
    ];
    for (const [status, substatus, expected] of statuses) {
      expect(parseSentryIssue({ ...sentryIssue, status, substatus })?.status, String(status)).toBe(
        expected,
      );
    }
  });

  it('reads the trend from 24h, then 14d, then whatever period is there', () => {
    expect(parseSentryIssue(sentryIssueWarning)?.trend).toEqual([1]);
    expect(
      parseSentryIssue({
        ...sentryIssue,
        stats: { '30d': [[1, 4], 'bad', [2], [3, 'x'], [4, 6]] },
      })?.trend,
    ).toEqual([4, 6]);
    expect(parseSentryIssue({ ...sentryIssue, stats: undefined })?.trend).toEqual([]);
    expect(parseSentryIssue({ ...sentryIssue, stats: { '24h': 'nope' } })?.trend).toEqual([]);
    expect(parseSentryIssue({ ...sentryIssue, stats: {} })?.trend).toEqual([]);
  });

  it('accepts numeric ids and a missing project', () => {
    const issue = parseSentryIssue({ ...sentryIssue, id: 77, project: { id: 9, slug: 'x' } });
    expect(issue).toMatchObject({ id: '77', remoteProjectId: '9', remoteProjectSlug: 'x' });
    expect(parseSentryIssue({ ...sentryIssue, project: null })).toMatchObject({
      remoteProjectId: '',
      remoteProjectSlug: '',
    });
  });

  it('fills what a minimal issue leaves out', () => {
    expect(parseSentryIssue({ id: '1', shortId: 'A-1', title: 'Boom' })).toEqual({
      id: '1',
      shortId: 'A-1',
      title: 'Boom',
      culprit: '',
      level: 'error',
      status: 'unresolved',
      count: 0,
      userCount: 0,
      firstSeen: '',
      lastSeen: '',
      permalink: '',
      remoteProjectId: '',
      remoteProjectSlug: '',
      trend: [],
    });
  });

  it('drops what is not an issue', () => {
    expect(parseSentryIssue({ id: 'x' })).toBeNull();
    expect(parseSentryIssue(null)).toBeNull();
    expect(parseSentryIssue('issue')).toBeNull();
    expect(parseSentryIssue({ id: '1', shortId: 'A-1', title: 5 })).toBeNull();
  });

  it('redacts the title and the culprit', () => {
    const issue = parseSentryIssue({ ...sentryIssueWarning, culprit: `from ${FAKE_IP}` });
    expect(issue?.title).toBe('Slow checkout for [email]');
    expect(issue?.culprit).toBe('from [ip]');
  });

  it('trims a very long title', () => {
    const issue = parseSentryIssue({ ...sentryIssue, title: 'x'.repeat(5_000) });
    expect(issue?.title.length).toBeLessThan(1_100);
  });
});

describe('parseSentryIssues', () => {
  it('keeps the issues and drops the rest', () => {
    expect(parseSentryIssues(sentryIssues).map((issue) => issue.id)).toEqual(['4501', '4502']);
  });

  it('reads anything that is not an array as empty', () => {
    expect(parseSentryIssues({ detail: 'nope' })).toEqual([]);
    expect(parseSentryIssues(undefined)).toEqual([]);
  });
});

describe('parseSentryEvent', () => {
  const event = parseSentryEvent(sentryEvent);

  it('reads the event header, environment, release and user id', () => {
    expect(event).toMatchObject({
      eventId: 'a1b2c3d4e5f60718293a4b5c6d7e8f90',
      dateCreated: '2026-10-18T09:58:02.000000Z',
      platform: 'node',
      message: null,
      environment: 'production',
      release: 'storefront-api@2.14.0',
      userId: 'usr_8812',
    });
  });

  it('keeps the exception chain cause first, with handled from the mechanism', () => {
    expect(event?.exceptions.map((exception) => [exception.type, exception.handled])).toEqual([
      ['PostgresError', true],
      ['TypeError', false],
    ]);
    expect(event?.exceptions[0]?.value).toBe(
      'connection to postgres://app:[redacted]@db.internal:5432/shop failed for [ip]',
    );
  });

  it('keeps frames in order with their context and never their vars', () => {
    const frames = event?.exceptions[1]?.frames ?? [];
    expect(frames.map((frame) => frame.filename)).toEqual([
      'node:internal/process/task_queues',
      'node_modules/express/lib/router/layer.js',
      'src/routes/checkout.ts',
      'src/lib/totals.ts',
    ]);
    expect(frames[3]).toEqual({
      filename: 'src/lib/totals.ts',
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
    });
    expect(JSON.stringify(frames)).not.toContain('vars');
  });

  it('drops a frame it cannot place and reads the rest of a frame leniently', () => {
    const parsed = parseSentryEvent({
      eventID: 'e1',
      entries: [
        {
          type: 'exception',
          data: {
            values: [
              {
                type: 'Error',
                value: 'boom',
                stacktrace: {
                  frames: [
                    { function: 'nowhere' },
                    'not a frame',
                    {
                      absPath: '/srv/app/a.js',
                      lineNo: 'x',
                      context: [[1, 'ok'], ['2', 'bad'], 3],
                    },
                    { module: 'app.views', function: 'index', inApp: 'yes' },
                  ],
                },
              },
              { type: 'Error' },
              { value: 'no type' },
              { mechanism: { handled: true } },
              'not an exception',
            ],
          },
        },
      ],
    });
    const exceptions = parsed?.exceptions ?? [];
    expect(exceptions.map((exception) => [exception.type, exception.value])).toEqual([
      ['Error', 'boom'],
      ['Error', ''],
      ['Error', 'no type'],
    ]);
    expect(exceptions[0]?.frames).toEqual([
      {
        filename: '/srv/app/a.js',
        function: null,
        module: null,
        lineNo: null,
        colNo: null,
        inApp: false,
        context: [[1, 'ok']],
      },
      {
        filename: 'app.views',
        function: 'index',
        module: 'app.views',
        lineNo: null,
        colNo: null,
        inApp: false,
        context: [],
      },
    ]);
    expect(exceptions[1]).toMatchObject({ handled: null, frames: [] });
  });

  it('keeps breadcrumbs with a message or a summary of their data', () => {
    expect(event?.breadcrumbs).toEqual([
      {
        timestamp: '2026-10-18T09:57:59.000Z',
        category: 'http',
        level: 'info',
        message: 'GET /api/cart 200',
      },
      {
        timestamp: '2026-10-18T09:58:00.000Z',
        category: 'console',
        level: 'log',
        message: 'user [email] from [ip] started checkout, api_key=[redacted]',
      },
      {
        timestamp: '2026-10-18T09:58:01.000Z',
        category: 'query',
        level: 'info',
        message: 'SELECT * FROM carts WHERE id = $1',
      },
    ]);
  });

  it('summarizes navigation and other crumb data, and drops empty crumbs', () => {
    const parsed = parseSentryEvent({
      eventID: 'e1',
      entries: [
        {
          type: 'breadcrumbs',
          data: {
            values: [
              {
                category: 'navigation',
                timestamp: 1760781600,
                data: { from: '/cart', to: '/pay' },
              },
              {
                category: 'http',
                data: { url: `https://shop.example.com/pay?token=${FAKE_QUERY_TOKEN}` },
              },
              { category: 'ui', data: { target: 'button#pay', password: 'hunter2', nested: {} } },
              { category: 'empty', message: '', data: null },
              { category: 'empty-data', data: { nested: { a: 1 } } },
              'not a crumb',
            ],
          },
        },
      ],
    });
    expect(parsed?.breadcrumbs).toEqual([
      {
        timestamp: '2025-10-18T10:00:00.000Z',
        category: 'navigation',
        level: null,
        message: '/cart -> /pay',
      },
      {
        timestamp: null,
        category: 'http',
        level: null,
        message: 'https://shop.example.com/pay?token=***',
      },
      {
        timestamp: null,
        category: 'ui',
        level: null,
        message: 'target=button#pay password=[redacted]',
      },
    ]);
  });

  it(`keeps only the last ${MAX_BREADCRUMBS} breadcrumbs`, () => {
    const values = Array.from({ length: 100 }, (_, index) => ({ message: `crumb ${index}` }));
    const parsed = parseSentryEvent({
      eventID: 'e1',
      entries: [{ type: 'breadcrumbs', data: { values } }],
    });
    expect(parsed?.breadcrumbs).toHaveLength(MAX_BREADCRUMBS);
    expect(parsed?.breadcrumbs[0]?.message).toBe(`crumb ${100 - MAX_BREADCRUMBS}`);
    expect(parsed?.breadcrumbs.at(-1)?.message).toBe('crumb 99');
  });

  it('keeps only the method and a scrubbed URL of the request', () => {
    expect(event?.request).toEqual({
      method: 'POST',
      url: 'https://shop.example.com/api/checkout?token=***&step=***',
    });
    const noUrl = parseSentryEvent({
      eventID: 'e1',
      entries: [{ type: 'request', data: { method: 'GET' } }],
    });
    expect(noUrl?.request).toBeNull();
    const noMethod = parseSentryEvent({
      eventID: 'e1',
      entries: [{ type: 'request', data: { url: '/health' } }],
    });
    expect(noMethod?.request).toEqual({ method: null, url: '/health' });
  });

  it('keeps tags but not the ones about the user', () => {
    expect(event?.tags).toEqual([
      { key: 'environment', value: 'production' },
      { key: 'release', value: 'storefront-api@2.14.0' },
      { key: 'server_name', value: 'web-1' },
    ]);
  });

  it('reads tags sent as pairs and drops malformed ones', () => {
    const parsed = parseSentryEvent({
      eventID: 'e1',
      tags: [['environment', 'qa'], ['user', `email:${FAKE_EMAIL}`], ['bad'], { key: 'k' }, 7],
    });
    expect(parsed?.tags).toEqual([{ key: 'environment', value: 'qa' }]);
    expect(parsed?.environment).toBe('qa');
  });

  it('reads the release from release.version or a plain release string', () => {
    const base = { eventID: 'e1', tags: [] };
    expect(parseSentryEvent({ ...base, release: { version: '1.2.3' } })?.release).toBe('1.2.3');
    expect(parseSentryEvent({ ...base, release: 'web@4.0.0' })?.release).toBe('web@4.0.0');
    expect(parseSentryEvent({ ...base, release: null })?.release).toBeNull();
  });

  it('keeps a user id and scrubs one that is an address', () => {
    expect(parseSentryEvent({ eventID: 'e1', user: { id: 42 } })?.userId).toBe('42');
    expect(parseSentryEvent({ eventID: 'e1', user: { id: FAKE_EMAIL } })?.userId).toBe('[email]');
    expect(parseSentryEvent({ eventID: 'e1', user: { email: FAKE_EMAIL } })?.userId).toBeNull();
  });

  it('reads a message event', () => {
    expect(parseSentryEvent(sentryMessageEvent)).toEqual({
      eventId: 'ffff0000ffff0000ffff0000ffff0000',
      dateCreated: '2026-10-18T10:00:00Z',
      platform: 'python',
      message: 'Payment webhook retried 5 times for [email]',
      exceptions: [],
      breadcrumbs: [],
      request: null,
      tags: [{ key: 'environment', value: 'staging' }],
      environment: 'staging',
      release: null,
      userId: null,
    });
  });

  it('takes the message from the message entry when the top level has none', () => {
    const parsed = parseSentryEvent({
      id: 'e2',
      message: '',
      entries: [{ type: 'message', data: { formatted: 'from the entry' } }, { type: 'message' }],
    });
    expect(parsed?.eventId).toBe('e2');
    expect(parsed?.message).toBe('from the entry');
  });

  it('reads an event with nothing in it, and refuses what is not an event', () => {
    expect(parseSentryEvent({ eventID: 'e1', entries: 'nope' })).toMatchObject({
      dateCreated: '',
      platform: null,
      message: null,
      exceptions: [],
      tags: [],
    });
    expect(parseSentryEvent({ entries: [] })).toBeNull();
    expect(parseSentryEvent(null)).toBeNull();
    expect(parseSentryEvent([sentryEvent])).toBeNull();
  });

  it('lets none of the fake secrets, emails or addresses through', () => {
    const subjects = [
      parseSentryEvent(sentryEvent),
      parseSentryEvent(sentryMessageEvent),
      parseSentryIssue(sentryIssueWarning),
      parseSentryIssues(sentryIssues),
    ];
    for (const subject of subjects) {
      const json = JSON.stringify(subject);
      for (const literal of FAKE_LITERALS) expect(json).not.toContain(literal);
    }
  });
});

describe('parseSentryOrganizations', () => {
  it('reads organizations with their region and drops the rest', () => {
    expect(parseSentryOrganizations(sentryOrganizations)).toEqual([
      { slug: 'acme', name: 'Acme', regionUrl: 'https://de.sentry.io' },
      { slug: 'side-project', name: 'Side Project', regionUrl: 'https://us.sentry.io' },
      { slug: 'selfhosted', name: 'Self Hosted', regionUrl: null },
    ]);
  });

  it('uses the slug when the name is missing, and reads a non-array as empty', () => {
    expect(parseSentryOrganizations([{ slug: 'a' }])).toEqual([
      { slug: 'a', name: 'a', regionUrl: null },
    ]);
    expect(parseSentryOrganizations({})).toEqual([]);
  });
});

describe('parseSentryProjects', () => {
  it('reads projects and drops the rest', () => {
    expect(parseSentryProjects(sentryProjects)).toEqual([
      { id: '101', slug: 'storefront-web', name: 'storefront-web', platform: 'javascript-react' },
      { id: '102', slug: 'storefront-api', name: 'storefront-api', platform: 'node' },
      { id: '103', slug: 'billing-worker', name: 'Billing Worker', platform: null },
    ]);
  });

  it('accepts a numeric id and a missing name, and reads a non-array as empty', () => {
    expect(parseSentryProjects([{ id: 5, slug: 'five' }])).toEqual([
      { id: '5', slug: 'five', name: 'five', platform: null },
    ]);
    expect(parseSentryProjects('nope')).toEqual([]);
  });
});

describe('parseSentryEnvironments', () => {
  it('lists the environment names without hidden ones', () => {
    expect(parseSentryEnvironments(sentryEnvironments)).toEqual(['production', 'staging']);
  });

  it('drops malformed entries and reads a non-array as empty', () => {
    expect(parseSentryEnvironments([{ name: '' }, { id: 1 }, 'qa', { name: 'dev' }])).toEqual([
      'dev',
    ]);
    expect(parseSentryEnvironments(null)).toEqual([]);
  });
});
