import { describe, expect, it } from 'vitest';
import { useVaultStore } from './vaultStore';

const state = () => useVaultStore.getState();

describe('vaultStore categories', () => {
  it('starts on every category and remembers the one picked', () => {
    expect(state().categoryFilter).toBe('all');
    state().setCategoryFilter('work');
    expect(state().categoryFilter).toBe('work');
  });

  it('drops the category filter with the other filters and on lock', () => {
    state().setCategoryFilter('work');
    state().clearFilters();
    expect(state().categoryFilter).toBe('all');
    state().setCategoryFilter('uncategorized');
    state().resetView();
    expect(state().categoryFilter).toBe('all');
  });

  it('never persists the category filter, since it names vault contents', () => {
    state().setCategoryFilter('work');
    const saved = JSON.parse(localStorage.getItem('runova-vault-view') ?? '{}');
    expect(JSON.stringify(saved)).not.toContain('work');
  });
});

describe('vaultStore one-click login', () => {
  it('opens logins in the Runova window until another place is picked, and remembers it', () => {
    expect(state().loginTarget).toEqual({ kind: 'window' });
    state().setLoginTarget({ kind: 'workspace', projectId: 'p1' });
    expect(state().loginTarget).toEqual({ kind: 'workspace', projectId: 'p1' });
    const saved = JSON.parse(localStorage.getItem('runova-vault-view') ?? '{}');
    expect(saved.state.loginTarget).toEqual({ kind: 'workspace', projectId: 'p1' });
  });

  it('keeps the choice when the vault locks', () => {
    state().setLoginTarget({ kind: 'system' });
    state().resetView();
    expect(state().loginTarget).toEqual({ kind: 'system' });
  });
});
