import { describe, expect, it } from 'vitest';
import { useWorkspaceSearchStore } from './workspaceSearchStore';

function store() {
  return useWorkspaceSearchStore.getState();
}

describe('workspaceSearchStore', () => {
  it('opens for a project with the query it had last time', () => {
    store().openSearch('p1');
    store().setQuery('p1', 'store');
    store().close();
    expect(store().open).toBe(false);
    store().openSearch('p1');
    expect(store()).toMatchObject({ open: true, projectId: 'p1' });
    expect(store().queries.p1).toBe('store');
  });

  it('starts from what the caller typed when it has something', () => {
    store().setQuery('p1', 'old');
    store().openSearch('p1', 'x:needle');
    expect(store().queries.p1).toBe('x:needle');
  });

  it('toggles closed for the same project and moves to another', () => {
    store().toggle('p1');
    expect(store().open).toBe(true);
    store().toggle('p2');
    expect(store()).toMatchObject({ open: true, projectId: 'p2' });
    store().toggle('p2');
    expect(store().open).toBe(false);
  });

  it('flips the text options', () => {
    store().setOption('matchCase', true);
    store().setOption('regex', true);
    expect(store().options).toEqual({ matchCase: true, wholeWord: false, regex: true });
  });

  it('keeps the preview split within reason', () => {
    store().setPreview({ ratio: 0.95 });
    expect(store().preview.ratio).toBe(0.75);
    store().setPreview({ ratio: 0.1 });
    expect(store().preview.ratio).toBe(0.25);
    store().setPreview({ visible: false });
    expect(store().preview).toEqual({ visible: false, ratio: 0.25, images: true });
  });

  it('shows pictures in the preview until told not to', () => {
    expect(store().preview.images).toBe(true);
    store().setPreview({ images: false });
    expect(store().preview.images).toBe(false);
  });

  it('keeps picture previews on for a layout saved before the option existed', async () => {
    localStorage.setItem(
      'runova-workspace-search',
      JSON.stringify({ state: { preview: { visible: true, ratio: 0.5 } }, version: 1 }),
    );
    await useWorkspaceSearchStore.persist.rehydrate();
    expect(store().preview).toEqual({ visible: true, ratio: 0.5, images: true });
  });

  it('remembers the options and queries, but never that it was open', () => {
    store().openSearch('p1', 'abc');
    store().setOption('wholeWord', true);
    const saved = JSON.parse(localStorage.getItem('runova-workspace-search') ?? '{}').state;
    expect(saved.queries).toEqual({ p1: 'abc' });
    expect(saved.options.wholeWord).toBe(true);
    expect(saved.open).toBeUndefined();
    expect(saved.projectId).toBeUndefined();
  });
});
