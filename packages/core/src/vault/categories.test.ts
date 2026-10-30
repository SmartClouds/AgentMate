import { describe, expect, it } from 'vitest';
import {
  applyCategoryInput,
  moveToCategory,
  removeCategory,
  reorderCategories,
  sortCategories,
  VAULT_CATEGORY_LIMITS,
  type VaultCategory,
  VaultCategorySchema,
} from './categories.js';
import type { VaultEntry } from './entries.js';

const NOW = 1_700_000_000_000;
let ids = 0;
const clock = { now: NOW, newId: () => `c${++ids}` };

function category(overrides: Partial<VaultCategory> = {}): VaultCategory {
  return {
    id: 'work',
    name: 'Work',
    color: 'blue',
    icon: 'briefcase',
    order: 0,
    createdAt: NOW,
    ...overrides,
  };
}

function note(id: string, categoryId?: string): VaultEntry {
  return {
    id,
    type: 'note',
    title: id,
    tags: [],
    favorite: false,
    notes: '',
    createdAt: NOW,
    updatedAt: NOW,
    lastUsedAt: null,
    ...(categoryId ? { categoryId } : {}),
  };
}

describe('VaultCategorySchema', () => {
  it('accepts a known color and icon', () => {
    expect(VaultCategorySchema.safeParse(category()).success).toBe(true);
  });

  it('refuses colors and icons it does not know', () => {
    expect(VaultCategorySchema.safeParse(category({ color: 'plaid' as never })).success).toBe(
      false,
    );
    expect(VaultCategorySchema.safeParse(category({ icon: 'rocket' as never })).success).toBe(
      false,
    );
  });

  it('refuses a name that is blank or too long', () => {
    expect(VaultCategorySchema.safeParse(category({ name: '' })).success).toBe(false);
    const long = 'x'.repeat(VAULT_CATEGORY_LIMITS.name + 1);
    expect(VaultCategorySchema.safeParse(category({ name: long })).success).toBe(false);
  });
});

describe('applyCategoryInput', () => {
  it('creates a category at the end of the list with a tidied name', () => {
    const { category: made, categories } = applyCategoryInput(
      [category()],
      { name: '  Home   stuff ', color: 'green', icon: 'home' },
      clock,
    );
    expect(made).toMatchObject({ name: 'Home stuff', color: 'green', icon: 'home', order: 1 });
    expect(made.id).toMatch(/^c\d+$/);
    expect(made.createdAt).toBe(NOW);
    expect(categories).toHaveLength(2);
  });

  it('updates an existing category in place, keeping its order and creation time', () => {
    const existing = category({ order: 3, createdAt: 5 });
    const { category: updated, categories } = applyCategoryInput(
      [existing],
      { id: 'work', name: 'Job', color: 'red', icon: 'code' },
      clock,
    );
    expect(updated).toEqual({ ...existing, name: 'Job', color: 'red', icon: 'code' });
    expect(categories).toEqual([updated]);
  });

  it('refuses a second category with the same name in a different case', () => {
    expect(() =>
      applyCategoryInput([category()], { name: 'WORK', color: 'red', icon: 'folder' }, clock),
    ).toThrow(/already/);
  });

  it('lets a category keep its own name when only the color changes', () => {
    const { category: updated } = applyCategoryInput(
      [category()],
      { id: 'work', name: 'work', color: 'pink', icon: 'briefcase' },
      clock,
    );
    expect(updated.name).toBe('work');
  });

  it('refuses a blank name', () => {
    expect(() =>
      applyCategoryInput([], { name: '   ', color: 'red', icon: 'folder' }, clock),
    ).toThrow(/name/i);
  });

  it('refuses to update a category that is gone', () => {
    expect(() =>
      applyCategoryInput([], { id: 'nope', name: 'x', color: 'red', icon: 'folder' }, clock),
    ).toThrow(/no longer exists/);
  });

  it('stops at the category limit', () => {
    const full = Array.from({ length: VAULT_CATEGORY_LIMITS.categories }, (_, i) =>
      category({ id: `k${i}`, name: `K${i}`, order: i }),
    );
    expect(() =>
      applyCategoryInput(full, { name: 'One more', color: 'red', icon: 'folder' }, clock),
    ).toThrow(/up to/);
  });
});

describe('removeCategory', () => {
  it('drops the category and moves its entries to no category', () => {
    const result = removeCategory(
      [category(), category({ id: 'home', name: 'Home', order: 1 })],
      [note('a', 'work'), note('b', 'home'), note('c')],
      'work',
      NOW + 1,
    );
    expect(result.categories.map((c) => c.id)).toEqual(['home']);
    expect(result.moved).toBe(1);
    expect(result.entries.find((e) => e.id === 'a')).not.toHaveProperty('categoryId');
    expect(result.entries.find((e) => e.id === 'a')?.updatedAt).toBe(NOW + 1);
    expect(result.entries.find((e) => e.id === 'b')?.categoryId).toBe('home');
  });

  it('throws for a category that is not there', () => {
    expect(() => removeCategory([], [], 'work', NOW)).toThrow(/no longer exists/);
  });
});

describe('reorderCategories', () => {
  it('puts the given ids first, keeps the rest after them, and renumbers', () => {
    const list = [
      category({ id: 'a', name: 'A', order: 0 }),
      category({ id: 'b', name: 'B', order: 1 }),
      category({ id: 'c', name: 'C', order: 2 }),
    ];
    const next = reorderCategories(list, ['c', 'a', 'unknown']);
    expect(next.map((c) => [c.id, c.order])).toEqual([
      ['c', 0],
      ['a', 1],
      ['b', 2],
    ]);
  });
});

describe('sortCategories', () => {
  it('sorts by order, then by name', () => {
    const sorted = sortCategories([
      category({ id: 'z', name: 'Zed', order: 1 }),
      category({ id: 'b', name: 'Beta', order: 0 }),
      category({ id: 'a', name: 'Alpha', order: 1 }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(['b', 'a', 'z']);
  });
});

describe('moveToCategory', () => {
  it('moves the listed entries and leaves the others alone', () => {
    const { entries, moved } = moveToCategory(
      [note('a'), note('b', 'home'), note('c')],
      ['a', 'b'],
      'work',
      NOW + 5,
    );
    expect(moved).toBe(2);
    expect(entries.map((e) => e.categoryId)).toEqual(['work', 'work', undefined]);
    expect(entries[0].updatedAt).toBe(NOW + 5);
    expect(entries[2].updatedAt).toBe(NOW);
  });

  it('clears the category when moving to none, and skips entries already there', () => {
    const { entries, moved } = moveToCategory(
      [note('a', 'work'), note('b')],
      ['a', 'b'],
      null,
      NOW + 5,
    );
    expect(moved).toBe(1);
    expect(entries[0]).not.toHaveProperty('categoryId');
    expect(entries[1].updatedAt).toBe(NOW);
  });
});
