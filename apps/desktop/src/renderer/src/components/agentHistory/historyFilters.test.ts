import type { AgentHistorySession } from '@runova/core';
import { describe, expect, it } from 'vitest';
import {
  backgroundCount,
  countByProvider,
  dayBucket,
  displayPath,
  filterSessions,
  groupByDay,
  groupByFolder,
  PROVIDER_LABEL,
} from './historyFilters';

const DAY = 24 * 60 * 60 * 1000;
// Local time on purpose: the buckets start at local midnight, so the fixtures must too.
const now = new Date(2026, 9, 2, 12);
const startOfToday = new Date(2026, 9, 2).getTime();

function session(overrides: Partial<AgentHistorySession> = {}): AgentHistorySession {
  return {
    provider: 'claude-code',
    id: 'aaaaaaaa-0000',
    title: null,
    firstPrompt: null,
    lastPrompt: null,
    cwd: '/home/ubuntu/app',
    gitBranch: null,
    model: null,
    effort: null,
    startedAt: null,
    updatedAt: startOfToday + 60_000,
    sizeBytes: 100,
    background: false,
    ...overrides,
  };
}

const all = { query: '', provider: 'all', showBackground: false } as const;

describe('filterSessions', () => {
  it('matches the query against every text field, ignoring case and outer spaces', () => {
    const sessions = [
      session({ id: 'id-title-1', title: 'Fix the Login page' }),
      session({ id: 'id-first-1', firstPrompt: 'add a login button' }),
      session({ id: 'id-last-01', lastPrompt: 'now the LOGIN form' }),
      session({ id: 'id-branch1', gitBranch: 'feature/login' }),
      session({ id: 'id-model-1', model: 'login-model' }),
      session({ id: 'login-id-1' }),
      session({ id: 'id-other-1', title: 'Something else' }),
    ];
    const ids = filterSessions(sessions, { ...all, query: '  LOGIN ' }).map((s) => s.id);
    expect(ids).toEqual([
      'id-title-1',
      'id-first-1',
      'id-last-01',
      'id-branch1',
      'id-model-1',
      'login-id-1',
    ]);
  });

  it('keeps everything for an empty or blank query', () => {
    const sessions = [session({ id: 'a1' }), session({ id: 'b2' })];
    expect(filterSessions(sessions, { ...all, query: '   ' })).toHaveLength(2);
  });

  it('narrows to one provider', () => {
    const sessions = [
      session({ id: 'claude-1', provider: 'claude-code' }),
      session({ id: 'codex-1', provider: 'codex' }),
    ];
    expect(filterSessions(sessions, { ...all, provider: 'codex' }).map((s) => s.id)).toEqual([
      'codex-1',
    ]);
    expect(filterSessions(sessions, all)).toHaveLength(2);
  });

  it('hides runs started by tools unless asked for', () => {
    const sessions = [session({ id: 'person' }), session({ id: 'tool', background: true })];
    expect(filterSessions(sessions, all).map((s) => s.id)).toEqual(['person']);
    expect(filterSessions(sessions, { ...all, showBackground: true }).map((s) => s.id)).toEqual([
      'person',
      'tool',
    ]);
  });
});

describe('countByProvider', () => {
  it('counts conversations per agent for the filter menu', () => {
    const sessions = [
      session({ id: 'a', provider: 'claude-code' }),
      session({ id: 'b', provider: 'codex' }),
      session({ id: 'c', provider: 'codex' }),
      session({ id: 'd', provider: 'opencode' }),
    ];
    expect(countByProvider(sessions)).toEqual(
      new Map([
        ['claude-code', 1],
        ['codex', 2],
        ['opencode', 1],
      ]),
    );
    expect(countByProvider([])).toEqual(new Map());
  });
});

describe('backgroundCount', () => {
  it('counts tool runs for the chosen provider only', () => {
    const sessions = [
      session({ id: 'a', background: true }),
      session({ id: 'b', background: true, provider: 'codex' }),
      session({ id: 'c', provider: 'codex' }),
      session({ id: 'd' }),
    ];
    expect(backgroundCount(sessions, 'all')).toBe(2);
    expect(backgroundCount(sessions, 'codex')).toBe(1);
    expect(backgroundCount(sessions, 'claude-code')).toBe(1);
  });
});

describe('dayBucket', () => {
  it.each([
    [startOfToday + 1, 'Today'],
    [startOfToday, 'Today'],
    [startOfToday - 1, 'Yesterday'],
    [startOfToday - DAY, 'Yesterday'],
    [startOfToday - DAY - 1, 'This week'],
    [startOfToday - 6 * DAY, 'This week'],
    [startOfToday - 7 * DAY, 'This month'],
    [startOfToday - 29 * DAY, 'This month'],
    [startOfToday - 30 * DAY, 'Older'],
  ])('puts %d in %s', (at, label) => {
    expect(dayBucket(at, now)).toBe(label);
  });
});

describe('groupByDay', () => {
  it('runs of the same day share one group, in the order given', () => {
    const sessions = [
      session({ id: 't1', updatedAt: startOfToday + 2000 }),
      session({ id: 't2', updatedAt: startOfToday + 1000 }),
      session({ id: 'y1', updatedAt: startOfToday - 1000 }),
      session({ id: 'o1', updatedAt: startOfToday - 60 * DAY }),
    ];
    expect(groupByDay(sessions, now).map((g) => [g.label, g.items.map((s) => s.id)])).toEqual([
      ['Today', ['t1', 't2']],
      ['Yesterday', ['y1']],
      ['Older', ['o1']],
    ]);
  });

  it('gives nothing for no sessions', () => {
    expect(groupByDay([], now)).toEqual([]);
  });
});

describe('groupByFolder', () => {
  it('orders folders by their newest conversation and keeps each folder in input order', () => {
    const sessions = [
      session({ id: 'a-old', cwd: '/srv/a', updatedAt: 100 }),
      session({ id: 'b-new', cwd: '/srv/b', updatedAt: 500 }),
      session({ id: 'a-new', cwd: '/srv/a/', updatedAt: 300 }),
      session({ id: 'b-old', cwd: '/srv/b', updatedAt: 200 }),
    ];
    const groups = groupByFolder(sessions);
    expect(groups.map((g) => [g.folder, g.latest, g.items.map((s) => s.id)])).toEqual([
      ['/srv/b', 500, ['b-new', 'b-old']],
      ['/srv/a', 300, ['a-old', 'a-new']],
    ]);
  });

  it('collects sessions without a folder in one group, always last', () => {
    const sessions = [
      session({ id: 'none-1', cwd: null, updatedAt: 900 }),
      session({ id: 'app', cwd: '/srv/app', updatedAt: 100 }),
      session({ id: 'none-2', cwd: '', updatedAt: 800 }),
    ];
    const groups = groupByFolder(sessions);
    expect(groups.map((g) => [g.folder, g.latest, g.items.map((s) => s.id)])).toEqual([
      ['/srv/app', 100, ['app']],
      [null, 900, ['none-1', 'none-2']],
    ]);
  });

  it('keeps the root folder as is', () => {
    expect(groupByFolder([session({ cwd: '/' })])[0]?.folder).toBe('/');
  });
});

describe('displayPath', () => {
  it('shortens the home folder to a tilde', () => {
    expect(displayPath('/home/ubuntu/app', '/home/ubuntu')).toBe('~/app');
    expect(displayPath('/home/ubuntu', '/home/ubuntu')).toBe('~');
    expect(displayPath('/home/ubuntu/app', '/home/ubuntu/')).toBe('~/app');
  });

  it('only matches home on a whole path segment', () => {
    expect(displayPath('/home/ubuntu2/app', '/home/ubuntu')).toBe('/home/ubuntu2/app');
  });

  it('leaves the path alone without a usable home', () => {
    expect(displayPath('/srv/app')).toBe('/srv/app');
    expect(displayPath('/srv/app', '')).toBe('/srv/app');
    expect(displayPath('/srv/app', '/')).toBe('/srv/app');
    expect(displayPath('/srv/app', '/home/ubuntu')).toBe('/srv/app');
  });
});

describe('PROVIDER_LABEL', () => {
  it('names every history provider', async () => {
    const { AGENT_HISTORY_PROVIDERS } = await import('@runova/core');
    expect(Object.keys(PROVIDER_LABEL).sort()).toEqual([...AGENT_HISTORY_PROVIDERS].sort());
    expect(PROVIDER_LABEL['claude-code']).toBe('Claude');
    expect(PROVIDER_LABEL.codex).toBe('Codex');
  });

  it('filters each provider independently', async () => {
    const { AGENT_HISTORY_PROVIDERS } = await import('@runova/core');
    for (const provider of AGENT_HISTORY_PROVIDERS) {
      const sessions = [session({ id: `${provider}-1`, provider })];
      expect(filterSessions(sessions, { ...all, provider }).map((s) => s.id)).toEqual([
        `${provider}-1`,
      ]);
      expect(backgroundCount(sessions, provider)).toBe(0);
    }
  });
});
