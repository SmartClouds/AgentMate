import type { ProjectDraft, ScheduledTask } from '@runova/core';
import type { PromptHistoryEntry } from '@shared/apiTypes';
import { describe, expect, it } from 'vitest';
import {
  dayLabel,
  draftPromptText,
  groupByDay,
  groupScheduled,
  isPromptView,
  matchesSearch,
  mergePromptItems,
  timeUntil,
  toLocalInputValue,
} from './promptItems';

function entry(id: string, createdAt: string, content = `prompt ${id}`): PromptHistoryEntry {
  return {
    id,
    rawInput: '',
    promptType: 'Feature',
    targetAI: 'Claude Code',
    content,
    source: 'generate',
    tags: ['auth'],
    projectId: 'p1',
    createdAt,
  };
}

function draft(id: string, overrides: Partial<ProjectDraft> = {}): ProjectDraft {
  return {
    id,
    projectId: 'p1',
    rawInput: `request ${id}`,
    promptType: '',
    targetAI: 'Claude Code',
    content: '',
    status: 'draft',
    createdAt: '2026-09-20T10:00:00.000Z',
    implementedAt: null,
    ...overrides,
  };
}

function task(id: string, overrides: Partial<ScheduledTask> = {}): ScheduledTask {
  return {
    id,
    projectId: 'p1',
    rawInput: '',
    promptType: '',
    targetAI: 'Claude Code',
    content: `task ${id}`,
    runAt: '2026-09-25T09:00:00.000Z',
    status: 'pending',
    createdAt: '2026-09-20T10:00:00.000Z',
    ...overrides,
  };
}

describe('mergePromptItems', () => {
  it('puts history, drafts and scheduled prompts in one newest-first list', () => {
    const items = mergePromptItems(
      [entry('h1', '2026-09-21T10:00:00.000Z')],
      [draft('d1', { createdAt: '2026-09-22T10:00:00.000Z' })],
      [task('t1', { createdAt: '2026-09-20T10:00:00.000Z', ranAt: '2026-09-23T10:00:00.000Z' })],
    );
    expect(items.map((item) => item.id)).toEqual(['scheduled:t1', 'draft:d1', 'history:h1']);
  });
});

describe('matchesSearch', () => {
  it('matches text, tags and the chosen model, ignoring case', () => {
    const [history] = mergePromptItems(
      [entry('h1', '2026-09-21T10:00:00.000Z', 'Add OAuth')],
      [],
      [],
    );
    const [scheduled] = mergePromptItems([], [], [task('t1', { model: 'opus' })]);
    expect(matchesSearch(history, 'oauth')).toBe(true);
    expect(matchesSearch(history, 'AUTH')).toBe(true);
    expect(matchesSearch(scheduled, 'opus')).toBe(true);
    expect(matchesSearch(scheduled, 'sonnet')).toBe(false);
    expect(matchesSearch(scheduled, '  ')).toBe(true);
  });
});

describe('groupByDay', () => {
  it('labels today and yesterday and keeps each day together', () => {
    const now = new Date(2026, 8, 23, 15, 0);
    const items = mergePromptItems(
      [
        entry('a', new Date(2026, 8, 23, 9, 0).toISOString()),
        entry('b', new Date(2026, 8, 23, 8, 0).toISOString()),
        entry('c', new Date(2026, 8, 22, 20, 0).toISOString()),
      ],
      [],
      [],
    );
    const groups = groupByDay(items, now);
    expect(groups.map((g) => [g.label, g.items.length])).toEqual([
      ['Today', 2],
      ['Yesterday', 1],
    ]);
    expect(dayLabel(new Date(2026, 8, 10).toISOString(), now)).not.toMatch(/Today|Yesterday/);
  });
});

describe('groupScheduled', () => {
  it('splits missed, upcoming (timed first) and done', () => {
    const groups = groupScheduled([
      task('manual', { runMode: 'manual', createdAt: '2026-09-19T00:00:00.000Z' }),
      task('later', { runMode: 'auto', runAt: '2026-09-26T09:00:00.000Z' }),
      task('sooner', { runMode: 'auto', runAt: '2026-09-24T09:00:00.000Z' }),
      task('missed', { runMode: 'auto', status: 'missed' }),
      task('old', { status: 'completed', ranAt: '2026-09-21T00:00:00.000Z' }),
      task('newer', { status: 'cancelled', createdAt: '2026-09-22T00:00:00.000Z' }),
    ]);
    expect(groups.attention.map((t) => t.id)).toEqual(['missed']);
    expect(groups.upcoming.map((t) => t.id)).toEqual(['sooner', 'later', 'manual']);
    expect(groups.past.map((t) => t.id)).toEqual(['newer', 'old']);
  });
});

describe('small helpers', () => {
  it('reads the prompt a draft would run', () => {
    expect(draftPromptText(draft('d1'))).toBe('request d1');
    expect(draftPromptText(draft('d1', { content: 'generated' }))).toBe('generated');
  });

  it('describes how long until a run', () => {
    const now = Date.parse('2026-09-23T12:00:00.000Z');
    expect(timeUntil('2026-09-23T11:00:00.000Z', now)).toBe('now');
    expect(timeUntil('2026-09-23T12:10:00.000Z', now)).toBe('in 10m');
    expect(timeUntil('2026-09-23T15:00:00.000Z', now)).toBe('in 3h');
    expect(timeUntil('2026-09-26T12:00:00.000Z', now)).toBe('in 3d');
  });

  it('formats a local datetime-local value on the minute', () => {
    expect(toLocalInputValue(new Date(2026, 6, 19, 10, 5, 42))).toBe('2026-07-19T10:05');
  });

  it('knows the sub-tab names', () => {
    expect(isPromptView('drafts')).toBe(true);
    expect(isPromptView('history')).toBe(false);
    expect(isPromptView(null)).toBe(false);
  });
});
