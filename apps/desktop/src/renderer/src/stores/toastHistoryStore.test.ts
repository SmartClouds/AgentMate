import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useToastHistoryStore } from './toastHistoryStore';

function state() {
  return useToastHistoryStore.getState();
}

function items() {
  return state().items;
}

beforeEach(() => {
  useToastHistoryStore.setState({ items: [], open: false });
});

afterEach(() => {
  vi.useRealTimers();
});

describe('add', () => {
  it('puts the newest flash at the top, unread', () => {
    state().add({ kind: 'success', title: 'Saved', description: '' });
    state().add({ kind: 'error', title: 'Push failed', description: 'rejected' });
    expect(items().map((item) => item.title)).toEqual(['Push failed', 'Saved']);
    expect(items().every((item) => !item.read)).toBe(true);
    expect(items()[0].count).toBe(1);
  });

  it('gives each row an id and a timestamp', () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date('2026-03-01T12:00:00.000Z'));
    state().add({ kind: 'info', title: 'Hello', description: '' });
    expect(items()[0].id).toBeTruthy();
    expect(items()[0].createdAt).toBe('2026-03-01T12:00:00.000Z');
  });

  it('rolls a repeat of the newest flash into one row with a count', () => {
    state().add({ kind: 'error', title: 'Push failed', description: 'rejected' });
    state().add({ kind: 'error', title: 'Push failed', description: 'rejected' });
    state().add({ kind: 'error', title: 'Push failed', description: 'rejected' });
    expect(items()).toHaveLength(1);
    expect(items()[0].count).toBe(3);
  });

  it('only rolls up a flash identical to the one at the top', () => {
    state().add({ kind: 'error', title: 'Push failed', description: 'rejected' });
    state().add({ kind: 'error', title: 'Push failed', description: 'timed out' });
    state().add({ kind: 'success', title: 'Push failed', description: 'rejected' });
    expect(items()).toHaveLength(3);
  });

  it('does not roll up a repeat that something else came between', () => {
    state().add({ kind: 'error', title: 'A', description: '' });
    state().add({ kind: 'info', title: 'B', description: '' });
    state().add({ kind: 'error', title: 'A', description: '' });
    expect(items().map((item) => item.title)).toEqual(['A', 'B', 'A']);
  });

  it('marks a flash read when the panel is already open', () => {
    // The user is looking at the list, so a new row is not something they missed.
    state().setOpen(true);
    state().add({ kind: 'info', title: 'Seen', description: '' });
    expect(items()[0].read).toBe(true);
  });

  it('keeps a rolled-up row read while the panel is open', () => {
    state().add({ kind: 'info', title: 'Twice', description: '' });
    state().setOpen(true);
    state().add({ kind: 'info', title: 'Twice', description: '' });
    expect(items()[0]).toMatchObject({ count: 2, read: true });
  });

  it('keeps only the last eighty rows', () => {
    for (let i = 0; i < 90; i++) {
      state().add({ kind: 'info', title: `Row ${i}`, description: '' });
    }
    expect(items()).toHaveLength(80);
    expect(items()[0].title).toBe('Row 89');
    expect(items().at(-1)?.title).toBe('Row 10');
  });
});

describe('setOpen', () => {
  it('marks everything read when the panel opens', () => {
    state().add({ kind: 'info', title: 'A', description: '' });
    state().add({ kind: 'info', title: 'B', description: '' });
    state().setOpen(true);
    expect(state().open).toBe(true);
    expect(items().every((item) => item.read)).toBe(true);
  });

  it('leaves the rows alone when the panel closes', () => {
    state().add({ kind: 'info', title: 'A', description: '' });
    state().setOpen(true);
    const before = items();
    state().setOpen(false);
    expect(state().open).toBe(false);
    expect(items()).toBe(before);
  });
});

describe('remove and clear', () => {
  it('removes one row by its id', () => {
    state().add({ kind: 'info', title: 'A', description: '' });
    state().add({ kind: 'info', title: 'B', description: '' });
    state().remove(items()[0].id);
    expect(items().map((item) => item.title)).toEqual(['A']);
  });

  it('does nothing for an id that is not there', () => {
    state().add({ kind: 'info', title: 'A', description: '' });
    state().remove('nope');
    expect(items()).toHaveLength(1);
  });

  it('empties the whole list', () => {
    state().add({ kind: 'info', title: 'A', description: '' });
    state().clear();
    expect(items()).toEqual([]);
  });
});

describe('coming back from a saved history', () => {
  it('restores the rows but not the panel', async () => {
    localStorage.setItem(
      'runova-toast-history',
      JSON.stringify({
        state: {
          items: [
            {
              id: 'x',
              kind: 'error',
              title: 'Push failed',
              description: '',
              createdAt: '2026-01-01T00:00:00.000Z',
              read: true,
              count: 2,
            },
          ],
        },
        version: 0,
      }),
    );
    await useToastHistoryStore.persist.rehydrate();
    expect(items()).toHaveLength(1);
    expect(items()[0]).toMatchObject({ title: 'Push failed', count: 2 });
    // Only the rows are persisted; the panel is a mode, not a preference.
    expect(state().open).toBe(false);
  });

  it('saves the rows as they come in', () => {
    state().add({ kind: 'info', title: 'A', description: '' });
    const saved = JSON.parse(localStorage.getItem('runova-toast-history') ?? '{}');
    expect(saved.state.items[0].title).toBe('A');
    expect(saved.state.open).toBeUndefined();
  });
});
