import { describe, expect, it } from 'vitest';
import {
  applyIssueStatus,
  formatCount,
  groupIssuesByProject,
  issueParam,
  mergeIssuePages,
  parseIssueParam,
  scopeChecklist,
  sparklineBars,
  tokenPageUrl,
} from './errorView';
import { issue, page, project, tokenCheck } from './testing/fixtures';

describe('formatCount', () => {
  it('keeps small numbers and shortens big ones', () => {
    expect(formatCount(0)).toBe('0');
    expect(formatCount(87)).toBe('87');
    expect(formatCount(999)).toBe('999');
    expect(formatCount(1240)).toBe('1.2k');
    expect(formatCount(18_000)).toBe('18k');
    expect(formatCount(2_450_000)).toBe('2.5M');
  });
});

describe('sparklineBars', () => {
  it('pads a short trend on the left so the newest bar is always last', () => {
    expect(sparklineBars([3, 5], 4)).toEqual([0, 0, 3, 5]);
  });

  it('keeps only the newest buckets of a long trend', () => {
    expect(sparklineBars([1, 2, 3, 4, 5], 3)).toEqual([3, 4, 5]);
  });
});

describe('issue param', () => {
  it('round-trips a connection and an issue', () => {
    expect(issueParam({ connectionId: 'c1', issueId: '4501' })).toBe('c1:4501');
    expect(parseIssueParam('c1:4501')).toEqual({ connectionId: 'c1', issueId: '4501' });
  });

  it('refuses anything else', () => {
    expect(parseIssueParam(null)).toBeNull();
    expect(parseIssueParam('nocolon')).toBeNull();
    expect(parseIssueParam(':4501')).toBeNull();
    expect(parseIssueParam('c1:')).toBeNull();
  });
});

describe('groupIssuesByProject', () => {
  it('groups by Runova project in name order, keeping the list order inside', () => {
    const groups = groupIssuesByProject(
      [
        issue({ id: '1', projectId: 'p1' }),
        issue({ id: '2', projectId: 'p2' }),
        issue({ id: '3', projectId: 'p1' }),
        issue({ id: '4', projectId: 'gone' }),
      ],
      [project(), project({ id: 'p2', name: 'Admin' })],
    );
    expect(groups.map((one) => one.projectName)).toEqual([
      'Admin',
      'Storefront',
      'Unknown project',
    ]);
    expect(groups[1].issues.map((one) => one.id)).toEqual(['1', '3']);
  });

  it('names the issues of a Sentry project that no project is linked to', () => {
    const groups = groupIssuesByProject([issue({ projectId: '' })], [project()]);
    expect(groups[0].projectName).toBe('Not linked to a project');
  });
});

describe('mergeIssuePages', () => {
  it('flattens pages, drops repeats and keeps every failure once', () => {
    const failure = { connectionId: 'c2', label: 'Side', message: 'Token rejected', locked: false };
    const merged = mergeIssuePages([
      page({ issues: [issue({ id: '1' }), issue({ id: '2' })], failures: [failure] }),
      page({ issues: [issue({ id: '2' }), issue({ id: '3' })], failures: [failure] }),
    ]);
    expect(merged.issues.map((one) => one.id)).toEqual(['1', '2', '3']);
    expect(merged.failures).toEqual([failure]);
  });
});

describe('applyIssueStatus', () => {
  const ref = { connectionId: 'c1', issueId: '1' };
  const before = page({ issues: [issue({ id: '1' }), issue({ id: '2' })] });

  it('drops the issue from a list filtered to another status', () => {
    const after = applyIssueStatus(before, ref, 'resolved', 'unresolved');
    expect(after.issues.map((one) => one.id)).toEqual(['2']);
  });

  it('changes the status in place on the All list', () => {
    const after = applyIssueStatus(before, ref, 'resolved', 'all');
    expect(after.issues.map((one) => one.status)).toEqual(['resolved', 'unresolved']);
  });

  it('leaves another connection with the same issue id alone', () => {
    const after = applyIssueStatus(
      before,
      { connectionId: 'c9', issueId: '1' },
      'resolved',
      'unresolved',
    );
    expect(after).toBe(before);
  });
});

describe('tokenPageUrl', () => {
  it('points at the auth token settings on the chosen host', () => {
    expect(tokenPageUrl('https://sentry.io')).toBe(
      'https://sentry.io/settings/account/api/auth-tokens/',
    );
    expect(tokenPageUrl('https://de.sentry.io/')).toBe(
      'https://de.sentry.io/settings/account/api/auth-tokens/',
    );
  });

  it('falls back to sentry.io for a host that is not a URL yet', () => {
    expect(tokenPageUrl('')).toBe('https://sentry.io/settings/account/api/auth-tokens/');
    expect(tokenPageUrl('not a url')).toBe('https://sentry.io/settings/account/api/auth-tokens/');
  });
});

describe('scopeChecklist', () => {
  it('passes and fails the read scopes and marks event:write optional', () => {
    const list = scopeChecklist(
      tokenCheck({ scopes: ['org:read', 'event:read'], missingScopes: ['project:read'] }),
    );
    expect(list).toEqual([
      { scope: 'org:read', state: 'granted', optional: false },
      { scope: 'project:read', state: 'missing', optional: false },
      { scope: 'event:read', state: 'granted', optional: false },
      { scope: 'event:write', state: 'missing', optional: true },
    ]);
  });

  it('says unknown when the provider would not list the scopes', () => {
    const list = scopeChecklist(tokenCheck({ scopes: null, missingScopes: [], canWrite: null }));
    expect(list.every((one) => one.state === 'unknown')).toBe(true);
  });
});
