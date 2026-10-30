import type { VaultCategory } from '@runova/core';
import { describe, expect, it } from 'vitest';
import { summary } from '@/components/vault/testing/mockVaultApi';
import { categoryCounts, inCategory } from './categories';

const work: VaultCategory = {
  id: 'work',
  name: 'Work',
  color: 'blue',
  icon: 'briefcase',
  order: 0,
  createdAt: 1,
};

describe('categoryCounts', () => {
  it('counts every entry, each category, and the ones with no category', () => {
    const counts = categoryCounts(
      [
        summary({ categoryId: 'work' }),
        summary({ categoryId: 'work' }),
        summary({ categoryId: null }),
        // Filed under a category that is gone, so it shows up as having none.
        summary({ categoryId: 'deleted' }),
      ],
      [work],
    );
    expect(counts.all).toBe(4);
    expect(counts.uncategorized).toBe(2);
    expect(counts.byId.get('work')).toBe(2);
    expect(counts.byId.has('deleted')).toBe(false);
  });
});

describe('inCategory', () => {
  const known = new Set(['work']);

  it('lets everything through for all', () => {
    expect(inCategory(summary({ categoryId: 'work' }), 'all', known)).toBe(true);
  });

  it('matches a category by id', () => {
    expect(inCategory(summary({ categoryId: 'work' }), 'work', known)).toBe(true);
    expect(inCategory(summary({ categoryId: null }), 'work', known)).toBe(false);
  });

  it('counts an unknown category as uncategorized', () => {
    expect(inCategory(summary({ categoryId: null }), 'uncategorized', known)).toBe(true);
    expect(inCategory(summary({ categoryId: 'deleted' }), 'uncategorized', known)).toBe(true);
    expect(inCategory(summary({ categoryId: 'work' }), 'uncategorized', known)).toBe(false);
  });
});
