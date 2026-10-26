import type {
  CertificateInfo,
  SiteInfo,
} from '@shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import { describe, expect, it } from 'vitest';
import { certificateBadge, DAY_MS, daysLeft, relative, renewalText } from './certificates';
import { blankDraft, draftFromSite, suggestId } from './draft';
import {
  messageAt,
  placeProblem,
  problemsByTab,
  problemsFor,
  snippetMarks,
  tabOf,
} from './problems';
import { settingsFromDraft, splitList } from './settings';

const NOW = 1_700_000_000_000;

function cert(overrides: Partial<CertificateInfo> = {}): CertificateInfo {
  return {
    siteId: 'blog',
    source: 'acme',
    state: 'valid',
    domains: ['blog.example.com'],
    issuer: 'R11',
    notBeforeUnixMs: NOW - 10 * DAY_MS,
    notAfterUnixMs: NOW + 45 * DAY_MS + 1_000,
    autoRenew: true,
    staging: false,
    failedAttempts: 0,
    ...overrides,
  };
}

describe('problems', () => {
  it('places site, stream and general problems on their tab and field', () => {
    expect(placeProblem({ field: 'sites[blog].domains[2]', message: 'bad' })).toEqual({
      scope: 'site',
      id: 'blog',
      path: 'domains[2]',
      tab: 'domains',
      message: 'bad',
    });
    expect(
      placeProblem({ field: 'sites[blog].locationSnippet', message: 'no', line: 3 }),
    ).toMatchObject({
      tab: 'advanced',
      line: 3,
    });
    expect(placeProblem({ field: 'streams[pg].listenPort', message: 'taken' })).toMatchObject({
      scope: 'stream',
      id: 'pg',
    });
    expect(placeProblem({ field: 'nginx', message: 'nginx -t failed' })).toEqual({
      scope: 'general',
      path: 'nginx',
      tab: 'domains',
      message: 'nginx -t failed',
    });
    expect(placeProblem({ field: 'upstream', message: 'x', siteId: 'blog' })).toMatchObject({
      scope: 'site',
      id: 'blog',
      tab: 'proxy',
    });
    expect(['hsts', 'timeouts.readSeconds', 'basicAuth.users[0].name', 'weird'].map(tabOf)).toEqual(
      ['ssl', 'performance', 'security', 'domains'],
    );
  });

  it('finds the message for a field and counts problems per tab', () => {
    const placed = problemsFor(
      [
        { field: 'sites[blog].upstream.port', message: 'port' },
        { field: 'sites[blog].serverSnippet', message: 'include', line: 2 },
        { field: 'sites[blog].serverSnippet', message: 'somewhere' },
        { field: 'sites[shop].domains[0]', message: 'other site' },
      ],
      'site',
      'blog',
    );
    expect(messageAt(placed, 'upstream')).toBe('port');
    expect(messageAt(placed, 'domains')).toBeUndefined();
    expect(problemsByTab(placed)).toEqual({ proxy: 1, advanced: 2 });
    expect(snippetMarks(placed, 'serverSnippet')).toEqual([
      { line: 2, message: 'include' },
      { line: 1, message: 'somewhere' },
    ]);
  });
});

describe('certificates', () => {
  it('says how long is left in words, staging and expiry included', () => {
    expect(daysLeft(cert(), NOW)).toBe(45);
    expect(certificateBadge(undefined, NOW)).toMatchObject({ label: 'No SSL', tone: 'warn' });
    expect(certificateBadge(cert(), NOW)).toMatchObject({ label: 'SSL, 45 days', tone: 'ok' });
    expect(certificateBadge(cert({ notAfterUnixMs: NOW + DAY_MS + 5 }), NOW).label).toBe(
      'SSL, 1 day',
    );
    expect(certificateBadge(cert({ notAfterUnixMs: NOW + 5 }), NOW)).toMatchObject({
      label: 'SSL, last day',
      tone: 'warn',
    });
    expect(certificateBadge(cert({ staging: true }), NOW)).toMatchObject({
      label: 'SSL, 45 days (staging)',
      tone: 'warn',
    });
    expect(certificateBadge(cert({ staging: true }), NOW).description).toMatch(/staging CA/);
    expect(certificateBadge(cert({ state: 'expired' }), NOW)).toMatchObject({
      label: 'Expired',
      tone: 'bad',
    });
    expect(certificateBadge(cert({ notAfterUnixMs: NOW - DAY_MS }), NOW).label).toBe('Expired');
    expect(certificateBadge(cert({ state: 'revoked' }), NOW)).toMatchObject({ label: 'Revoked' });
  });

  it('says what renewal will do next', () => {
    expect(renewalText(cert({ source: 'uploaded' }), NOW)).toMatch(/Uploaded by hand/);
    expect(renewalText(cert({ autoRenew: false }), NOW)).toBe('Automatic renewal is off.');
    expect(
      renewalText(cert({ failedAttempts: 2, nextAttemptAtUnixMs: NOW + 3 * 3_600_000 }), NOW),
    ).toBe('The last 2 renewal attempts failed. Next try in 3 hours.');
    expect(renewalText(cert({ failedAttempts: 1 }), NOW)).toBe(
      'The last 1 renewal attempt failed.',
    );
    expect(renewalText(cert({ renewAtUnixMs: NOW - 1 }), NOW)).toMatch(/next few hours/);
    expect(renewalText(cert({ renewAtUnixMs: NOW + 30 * DAY_MS }), NOW)).toMatch(
      /^Renews automatically around /,
    );
    expect(renewalText(cert(), NOW)).toBe('Renews automatically before it runs out.');
    expect(relative(NOW - 20_000, NOW)).toBe('less than a minute ago');
    expect(relative(NOW + 5 * 60_000, NOW)).toBe('in 5 minutes');
    expect(relative(NOW - 3 * DAY_MS, NOW)).toBe('3 days ago');
  });
});

const SITE: SiteInfo = {
  applied: true,
  createdAtUnixMs: NOW,
  updatedAtUnixMs: NOW,
  settings: {
    id: 'blog',
    domains: ['blog.example.com'],
    upstream: {
      kind: 'servicePort',
      service: 'web',
      port: 3000,
      verifyCertificate: true,
      sendUpstreamHost: false,
    },
    websocket: true,
    gzip: true,
    http2: true,
    redirectToHttps: true,
    hsts: { maxAgeSeconds: 600, includeSubdomains: true, preload: false },
    proxyCache: { ttlSeconds: 60, maxSizeMegabytes: 10, bypassCookies: ['sid', 'auth'] },
    securityHeaders: { noSniff: false, frameOptions: 'deny', referrerPolicy: 'noReferrer' },
    responseHeaders: [{ name: 'X-Robots-Tag', value: 'noindex' }],
    ipRules: { allow: ['10.0.0.0/8'], deny: ['192.0.2.1'] },
    basicAuth: { realm: 'Staff', users: [{ name: 'ana' }] },
    rateLimit: { requests: 5, per: 'minute', burst: 2, noDelay: false },
    clientMaxBodySizeMegabytes: 25,
    timeouts: { readSeconds: 90 },
  },
};

describe('drafts', () => {
  it('round-trips a full site through its draft', () => {
    const draft = draftFromSite(SITE);
    expect(draft).toMatchObject({
      isNew: false,
      port: '3000',
      cacheBypass: 'sid, auth',
      allow: '10.0.0.0/8',
    });
    const { settings, errors } = settingsFromDraft(draft);
    expect(errors).toEqual({});
    expect(settings).toEqual(SITE.settings);
  });

  it('reads a URL upstream and a bare site', () => {
    const draft = draftFromSite({
      ...SITE,
      settings: {
        id: 'api',
        domains: [],
        upstream: {
          kind: 'url',
          address: 'https://10.0.0.5:8443',
          verifyCertificate: false,
          sendUpstreamHost: true,
        },
        websocket: false,
        gzip: false,
        http2: false,
        redirectToHttps: false,
      },
    });
    expect(draft).toMatchObject({
      upstreamKind: 'url',
      url: 'https://10.0.0.5:8443',
      domains: [''],
      hsts: false,
    });
    const { settings, errors } = settingsFromDraft({ ...draft, domains: ['api.example.com'] });
    expect(errors).toEqual({});
    expect(settings.upstream).toEqual({
      kind: 'url',
      address: 'https://10.0.0.5:8443',
      verifyCertificate: false,
      sendUpstreamHost: true,
    });
    expect(
      settingsFromDraft({ ...draftFromSite(SITE), upstreamKind: 'servicePort', service: ' ' })
        .settings.upstream,
    ).not.toHaveProperty('service');
  });

  it('keys local mistakes by the fields the core uses', () => {
    const { errors, settings } = settingsFromDraft({
      ...blankDraft(),
      id: 'Bad',
      domains: ['ok.example.com', 'not a domain', ''],
      port: '70000',
      hsts: true,
      hstsMaxAge: '',
      cache: true,
      cacheTtl: '0',
      bodySize: 'x',
      readTimeout: '0',
      headers: [
        { name: 'bad header', value: 'v' },
        { name: '', value: '' },
      ],
      allow: '10.0.0.1, nope',
      basicAuth: true,
      users: [{ name: '', password: '', saved: false }],
      rateLimit: true,
      rateRequests: '',
    });
    expect(Object.keys(errors).sort()).toEqual(
      [
        'id',
        'domains[1]',
        'upstream',
        'hsts',
        'proxyCache',
        'clientMaxBodySizeMegabytes',
        'timeouts.readSeconds',
        'responseHeaders[0].name',
        'ipRules.allow[1]',
        'basicAuth.users[0].name',
        'basicAuth.users[0].password',
        'rateLimit',
      ].sort(),
    );
    expect(errors['ipRules.allow[1]']).toMatch(/^nope: /);
    expect(settings.domains).toEqual(['ok.example.com', 'not a domain']);
    expect(settingsFromDraft({ ...blankDraft(), domains: [' '] }).errors.domains).toMatch(
      /at least one/,
    );
    expect(settingsFromDraft({ ...blankDraft(), basicAuth: true }).errors.basicAuth).toMatch(
      /at least one user/,
    );
    expect(
      settingsFromDraft({ ...blankDraft(), upstreamKind: 'url', url: 'ftp://x' }).errors.upstream,
    ).toMatch(/http:\/\//);
  });

  it('turns international domains into their ASCII form and suggests an id', () => {
    const { settings } = settingsFromDraft({
      ...blankDraft(),
      id: 'b',
      domains: ['Bücher.de'],
      port: '80',
    });
    expect(settings.domains).toEqual(['xn--bcher-kva.de']);
    expect(suggestId('www.Shop.example.com')).toBe('www-shop-example-com');
    expect(suggestId('*.example.com')).toBe('wildcard-example-com');
    expect(suggestId(`${'a'.repeat(62)}.b`)).toBe('a'.repeat(62));
    expect(splitList('a,\n b ,,c')).toEqual(['a', 'b', 'c']);
  });
});
