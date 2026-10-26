import { beforeEach, describe, expect, it } from 'vitest';
import { useUiStore } from './uiStore';

function mode() {
  return useUiStore.getState().sidebarMode;
}

beforeEach(() => {
  useUiStore.setState({ sidebarMode: 'expanded' });
});

describe('useUiStore', () => {
  it('starts with the sidebar showing its labels', () => {
    expect(mode()).toBe('expanded');
  });

  it('cycles labels, icons, then closed, and back round', () => {
    // "hidden" takes the width away entirely rather than floating a panel over the page.
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('collapsed');
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('hidden');
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('expanded');
  });

  it('cycles on from whatever was restored', () => {
    useUiStore.setState({ sidebarMode: 'hidden' });
    useUiStore.getState().cycleSidebarMode();
    expect(mode()).toBe('expanded');
  });
});

describe('coming back from a saved preference', () => {
  it('restores the mode the sidebar was left in', async () => {
    localStorage.setItem(
      'runova-ui',
      JSON.stringify({ state: { sidebarMode: 'collapsed' }, version: 0 }),
    );
    await useUiStore.persist.rehydrate();
    expect(mode()).toBe('collapsed');
  });

  it('saves the mode whenever it changes', () => {
    useUiStore.getState().cycleSidebarMode();
    const saved = JSON.parse(localStorage.getItem('runova-ui') ?? '{}');
    expect(saved.state.sidebarMode).toBe('collapsed');
  });
});
