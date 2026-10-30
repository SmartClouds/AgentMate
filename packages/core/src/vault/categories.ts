import { z } from 'zod';
import type { EntryClock, VaultEntry } from './entries.js';

/**
 * Categories are folders for entries: each entry sits in at most one. They live inside the
 * encrypted payload next to the entries, so their names are as private as everything else.
 */

export const VAULT_CATEGORY_COLORS = [
  'slate',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type VaultCategoryColor = (typeof VAULT_CATEGORY_COLORS)[number];

export const VAULT_CATEGORY_ICONS = [
  'folder',
  'briefcase',
  'home',
  'code',
  'server',
  'cloud',
  'bank',
  'cart',
  'gamepad',
  'heart',
  'school',
  'globe',
] as const;
export type VaultCategoryIcon = (typeof VAULT_CATEGORY_ICONS)[number];

export const VAULT_CATEGORY_LIMITS = {
  categories: 200,
  name: 40,
  id: 64,
} as const;

const id = z.string().min(1).max(VAULT_CATEGORY_LIMITS.id);

export const VaultCategorySchema = z.object({
  id,
  name: z.string().min(1).max(VAULT_CATEGORY_LIMITS.name),
  color: z.enum(VAULT_CATEGORY_COLORS),
  icon: z.enum(VAULT_CATEGORY_ICONS),
  order: z.number().int().nonnegative(),
  createdAt: z.number().int().nonnegative(),
});

export type VaultCategory = z.infer<typeof VaultCategorySchema>;

/** What the category dialog sends. No id means a new category. */
export const SaveVaultCategoryInputSchema = z.object({
  id: id.optional(),
  name: z.string().max(VAULT_CATEGORY_LIMITS.name * 2),
  color: z.enum(VAULT_CATEGORY_COLORS),
  icon: z.enum(VAULT_CATEGORY_ICONS),
});

export type SaveVaultCategoryInput = z.infer<typeof SaveVaultCategoryInputSchema>;

/** Trims and folds runs of spaces, so "Work " and "Work" are the same name. */
export function normalizeCategoryName(name: string): string {
  return name.trim().replace(/\s+/g, ' ');
}

/** Creates or updates one category. Throws a readable message when the input can't be used. */
export function applyCategoryInput(
  list: VaultCategory[],
  input: SaveVaultCategoryInput,
  clock: EntryClock,
): { category: VaultCategory; categories: VaultCategory[] } {
  const name = normalizeCategoryName(input.name);
  if (!name) throw new Error('Give the category a name.');
  if (name.length > VAULT_CATEGORY_LIMITS.name) {
    throw new Error(`Keep the name to ${VAULT_CATEGORY_LIMITS.name} characters.`);
  }
  const key = name.toLowerCase();
  if (list.some((c) => c.id !== input.id && c.name.toLowerCase() === key)) {
    throw new Error(`There is already a category called "${name}".`);
  }

  if (input.id) {
    const index = list.findIndex((c) => c.id === input.id);
    if (index === -1) throw new Error('That category no longer exists.');
    const category = VaultCategorySchema.parse({
      ...list[index],
      name,
      color: input.color,
      icon: input.icon,
    });
    const categories = [...list];
    categories[index] = category;
    return { category, categories };
  }

  if (list.length >= VAULT_CATEGORY_LIMITS.categories) {
    throw new Error(`The vault holds up to ${VAULT_CATEGORY_LIMITS.categories} categories.`);
  }
  const order = list.reduce((max, c) => Math.max(max, c.order + 1), 0);
  const category = VaultCategorySchema.parse({
    id: clock.newId(),
    name,
    color: input.color,
    icon: input.icon,
    order,
    createdAt: clock.now,
  });
  return { category, categories: [...list, category] };
}

function withoutCategory(entry: VaultEntry, now: number): VaultEntry {
  const { categoryId: _gone, ...rest } = entry;
  return { ...rest, updatedAt: now } as VaultEntry;
}

/** Deletes a category. Its entries are kept and end up with no category. */
export function removeCategory(
  categories: VaultCategory[],
  entries: VaultEntry[],
  categoryId: string,
  now: number,
): { categories: VaultCategory[]; entries: VaultEntry[]; moved: number } {
  if (!categories.some((c) => c.id === categoryId)) {
    throw new Error('That category no longer exists.');
  }
  let moved = 0;
  const next = entries.map((entry) => {
    if (entry.categoryId !== categoryId) return entry;
    moved += 1;
    return withoutCategory(entry, now);
  });
  return { categories: categories.filter((c) => c.id !== categoryId), entries: next, moved };
}

/** Puts `ids` first in that order, then every other category as it was, numbered from 0. */
export function reorderCategories(list: VaultCategory[], ids: string[]): VaultCategory[] {
  const byId = new Map(list.map((c) => [c.id, c]));
  const front = ids.flatMap((id) => {
    const found = byId.get(id);
    if (!found) return [];
    byId.delete(id);
    return [found];
  });
  const rest = sortCategories([...byId.values()]);
  return [...front, ...rest].map((c, order) => ({ ...c, order }));
}

export function sortCategories(list: VaultCategory[]): VaultCategory[] {
  return [...list].sort((a, b) => a.order - b.order || a.name.localeCompare(b.name));
}

/** Moves entries into a category, or out of every category with `null`. */
export function moveToCategory(
  entries: VaultEntry[],
  ids: string[],
  categoryId: string | null,
  now: number,
): { entries: VaultEntry[]; moved: number } {
  const wanted = new Set(ids);
  let moved = 0;
  const next = entries.map((entry) => {
    if (!wanted.has(entry.id) || (entry.categoryId ?? null) === categoryId) return entry;
    moved += 1;
    return categoryId === null
      ? withoutCategory(entry, now)
      : { ...entry, categoryId, updatedAt: now };
  });
  return { entries: next, moved };
}
