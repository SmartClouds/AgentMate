import { describe, expect, it } from 'vitest';
import { markNews, normalizeNewsState, pruneNewsState } from './state';

/** Read, dismissed and notified ids, as kept in settings.json (E42). */

const NOW = new Date('2026-10-31T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;
const ago = (days: number) => new Date(NOW.getTime() - days * DAY).toISOString();

describe('normalizeNewsState', () => {
  it('starts empty for a profile that never had any', () => {
    expect(normalizeNewsState(undefined)).toEqual({ read: {}, dismissed: {}, notified: {} });
  });

  it('keeps only id keys with a time, so a hand-edited file cannot inject anything else', () => {
    const state = normalizeNewsState({
      read: { '1': ago(1), x: ago(1), '2': 42 },
      dismissed: 'nope',
      notified: { '3': ago(2) },
    });
    expect(state).toEqual({ read: { '1': ago(1) }, dismissed: {}, notified: { '3': ago(2) } });
  });
});

describe('pruneNewsState', () => {
  it('drops ids older than 180 days and keeps the rest', () => {
    const state = {
      read: { '1': ago(181), '2': ago(179) },
      dismissed: { '3': ago(200) },
      notified: { '4': ago(10), '5': 'not a time' },
    };
    expect(pruneNewsState(state, NOW)).toEqual({
      read: { '2': ago(179) },
      dismissed: {},
      notified: { '4': ago(10) },
    });
  });
});

describe('markNews', () => {
  it('records the time and keeps the first one', () => {
    const once = markNews(normalizeNewsState(undefined), 'read', [7], NOW);
    expect(once.read).toEqual({ '7': NOW.toISOString() });
    const again = markNews(once, 'read', [7], new Date(NOW.getTime() + DAY));
    expect(again.read).toEqual({ '7': NOW.toISOString() });
  });
});
