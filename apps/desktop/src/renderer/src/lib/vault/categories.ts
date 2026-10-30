import type { VaultCategory, VaultEntrySummary } from '@runova/core';

/** Which entries the list shows: every one, one category's, or the ones filed nowhere. */
export type VaultCategoryFilter = 'all' | 'uncategorized' | (string & {});

export interface VaultCategoryCounts {
  all: number;
  uncategorized: number;
  byId: Map<string, number>;
}

/** An entry pointing at a category that no longer exists counts as having none. */
function categoryOf(entry: VaultEntrySummary, known: ReadonlySet<string>): string | null {
  return entry.categoryId && known.has(entry.categoryId) ? entry.categoryId : null;
}

export function categoryCounts(
  entries: VaultEntrySummary[],
  categories: VaultCategory[],
): VaultCategoryCounts {
  const known = new Set(categories.map((c) => c.id));
  const byId = new Map<string, number>();
  let uncategorized = 0;
  for (const entry of entries) {
    const id = categoryOf(entry, known);
    if (id === null) uncategorized += 1;
    else byId.set(id, (byId.get(id) ?? 0) + 1);
  }
  return { all: entries.length, uncategorized, byId };
}

export function inCategory(
  entry: VaultEntrySummary,
  filter: VaultCategoryFilter,
  known: ReadonlySet<string>,
): boolean {
  if (filter === 'all') return true;
  const id = categoryOf(entry, known);
  return filter === 'uncategorized' ? id === null : id === filter;
}
