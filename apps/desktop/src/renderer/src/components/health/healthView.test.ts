import { describe, expect, it } from 'vitest';
import {
  emptyHealthDraft,
  formatAgo,
  formatIn,
  groupHealthTargets,
  HEALTH_STATE_META,
  healthBucket,
  healthDraftFromTarget,
  healthDraftToInput,
  matchesHealthSearch,
  summarizeHealth,
  targetHost,
  validateHealthDraft,
} from './healthView';
import { environment, NOW, project, target } from './testing/fixtures';

describe('HEALTH_STATE_META', () => {
  it('gives every state a word, so status never rests on colour alone', () => {
    for (const meta of Object.values(HEALTH_STATE_META)) {
      expect(meta.label.length).toBeGreaterThan(2);
    }
    expect(HEALTH_STATE_META.pass.label).toBe('Healthy');
    expect(HEALTH_STATE_META.warn.tone).toBe('warning');
    expect(HEALTH_STATE_META.fail.tone).toBe('destructive');
    expect(HEALTH_STATE_META.paused.tone).toBe('neutral');
  });
});

describe('healthBucket', () => {
  it('puts every problem state under down', () => {
    expect(healthBucket('pass')).toBe('healthy');
    expect(healthBucket('warn')).toBe('degraded');
    for (const state of ['fail', 'unreachable', 'unauthorized', 'invalid'] as const) {
      expect(healthBucket(state)).toBe('down');
    }
    expect(healthBucket('paused')).toBe('paused');
    expect(healthBucket('locked')).toBe('paused');
    expect(healthBucket('pending')).toBe('pending');
  });
});

describe('summarizeHealth', () => {
  it('counts each bucket and averages the uptime of targets that have one', () => {
    const summary = summarizeHealth([
      target({ id: 'a', state: 'pass', uptime24h: 1 }),
      target({ id: 'b', state: 'warn', uptime24h: 0.9 }),
      target({ id: 'c', state: 'unreachable', uptime24h: 0.5 }),
      target({ id: 'd', state: 'locked', uptime24h: null }),
    ]);
    expect(summary).toMatchObject({ healthy: 1, degraded: 1, down: 1, paused: 1, total: 4 });
    expect(summary.uptime24h).toBeCloseTo(0.8);
  });

  it('has no uptime before any sample', () => {
    expect(summarizeHealth([target({ uptime24h: null })]).uptime24h).toBeNull();
  });
});

describe('targetHost', () => {
  it('shows the host only, never the path or query', () => {
    expect(targetHost('https://api.example.com:8443/_runova/health?token=x')).toBe(
      'api.example.com:8443',
    );
  });

  it('drops anything after ? or # in a URL that does not parse', () => {
    expect(targetHost('not a url?secret=1')).toBe('not a url');
  });
});

describe('groupHealthTargets', () => {
  it('groups by project then environment, with no environment last', () => {
    const groups = groupHealthTargets(
      [
        target({ id: 'a', projectId: 'p2', environmentId: null }),
        target({ id: 'b', projectId: 'p1', environmentId: 'env-staging' }),
        target({ id: 'c', projectId: 'p1', environmentId: 'env-prod' }),
        target({ id: 'd', projectId: 'p1', environmentId: null }),
      ],
      [project({ id: 'p1', name: 'Storefront' }), project({ id: 'p2', name: 'Admin' })],
      new Map([
        ['env-prod', environment({ id: 'env-prod', name: 'Production', order: 0 })],
        ['env-staging', environment({ id: 'env-staging', name: 'Staging', order: 1 })],
      ]),
    );
    expect(groups.map((g) => g.projectName)).toEqual(['Admin', 'Storefront']);
    expect(groups[1].environments.map((e) => e.name)).toEqual([
      'Production',
      'Staging',
      'No environment',
    ]);
    expect(groups[1].environments[0].targets.map((t) => t.id)).toEqual(['c']);
  });

  it('names a project it cannot find', () => {
    const groups = groupHealthTargets([target({ projectId: 'gone' })], [], new Map());
    expect(groups[0].projectName).toBe('Unknown project');
  });
});

describe('matchesHealthSearch', () => {
  it('matches the name, server label and host', () => {
    const one = target({ name: 'API', serverLabel: 'web-1' });
    expect(matchesHealthSearch(one, '')).toBe(true);
    expect(matchesHealthSearch(one, 'api')).toBe(true);
    expect(matchesHealthSearch(one, 'WEB-1')).toBe(true);
    expect(matchesHealthSearch(one, 'example.com')).toBe(true);
    expect(matchesHealthSearch(one, 'probe=1')).toBe(false);
    expect(matchesHealthSearch(one, 'nothing')).toBe(false);
  });
});

describe('formatAgo and formatIn', () => {
  it('reads as a person would say it', () => {
    expect(formatAgo(NOW - 5_000, NOW)).toBe('just now');
    expect(formatAgo(NOW - 90_000, NOW)).toBe('1 min ago');
    expect(formatAgo(NOW - 3 * 3_600_000, NOW)).toBe('3 h ago');
    expect(formatIn(NOW + 40_000, NOW)).toBe('in 40 sec');
    expect(formatIn(NOW + 600_000, NOW)).toBe('in 10 min');
    expect(formatIn(NOW - 1_000, NOW)).toBe('any moment');
  });
});

describe('validateHealthDraft', () => {
  const valid = { ...emptyHealthDraft('p1'), name: 'API', url: 'https://api.example.com/h' };

  it('accepts a complete draft', () => {
    expect(validateHealthDraft(valid)).toEqual({});
  });

  it('wants a name, a project and an http(s) URL', () => {
    const errors = validateHealthDraft({ ...valid, name: ' ', projectId: '', url: 'ftp://x' });
    expect(errors.name).toBeTruthy();
    expect(errors.projectId).toBeTruthy();
    expect(errors.url).toMatch(/https/);
  });

  it('refuses a sign-in inside the URL', () => {
    expect(validateHealthDraft({ ...valid, url: 'https://me:pw@x.com/h' }).url).toMatch(/sign-in/);
  });

  it('allows plain http on this computer but asks for the switch elsewhere', () => {
    expect(validateHealthDraft({ ...valid, url: 'http://localhost:3000/h' }).url).toBeUndefined();
    expect(validateHealthDraft({ ...valid, url: 'http://127.0.0.1/h' }).url).toBeUndefined();
    expect(validateHealthDraft({ ...valid, url: 'http://x.com/h' }).url).toMatch(/insecure/i);
    expect(
      validateHealthDraft({ ...valid, url: 'http://x.com/h', allowInsecure: true }).url,
    ).toBeUndefined();
  });

  it('keeps a custom interval inside the allowed range', () => {
    expect(
      validateHealthDraft({ ...valid, intervalChoice: 'custom', customInterval: '5' }).interval,
    ).toMatch(/15/);
    expect(
      validateHealthDraft({ ...valid, intervalChoice: 'custom', customInterval: '1.5' }).interval,
    ).toBeTruthy();
    expect(
      validateHealthDraft({ ...valid, intervalChoice: 'custom', customInterval: '45' }).interval,
    ).toBeUndefined();
  });

  it('keeps the timeout inside its range and shorter than the interval', () => {
    expect(validateHealthDraft({ ...valid, timeout: '1' }).timeout).toBeTruthy();
    expect(
      validateHealthDraft({ ...valid, intervalChoice: '30', timeout: '45' }).timeout,
    ).toBeTruthy();
  });

  it('needs a username without a colon for HTTP Basic', () => {
    expect(
      validateHealthDraft({ ...valid, authMode: 'basic', basicUser: '' }).basicUser,
    ).toBeTruthy();
    expect(
      validateHealthDraft({ ...valid, authMode: 'basic', basicUser: 'a:b' }).basicUser,
    ).toMatch(/colon/);
    expect(
      validateHealthDraft({ ...valid, authMode: 'basic', basicUser: 'monitor' }).basicUser,
    ).toBeUndefined();
  });
});

describe('health drafts', () => {
  it('round-trips a target through the form', () => {
    const one = target({ intervalSec: 45, serverLink: { kind: 'ssh', id: 's1' } });
    const draft = healthDraftFromTarget(one);
    expect(draft.intervalChoice).toBe('custom');
    expect(draft.customInterval).toBe('45');
    expect(healthDraftToInput(draft)).toMatchObject({
      projectId: 'p1',
      environmentId: 'env-prod',
      name: 'API',
      url: one.url,
      intervalSec: 45,
      timeoutSec: 10,
      serverLink: { kind: 'ssh', id: 's1' },
      basicUser: null,
    });
  });

  it('starts a new target on the defaults with auto-diagnose on', () => {
    const draft = emptyHealthDraft('p1');
    expect(draft.autoDiagnose).toBe(true);
    expect(draft.authMode).toBe('bearer');
    expect(healthDraftToInput({ ...draft, name: ' API ', serverLabel: ' ' })).toMatchObject({
      name: 'API',
      serverLabel: null,
      intervalSec: 60,
    });
  });
});
