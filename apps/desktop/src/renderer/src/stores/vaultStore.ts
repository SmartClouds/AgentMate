import {
  DEFAULT_PASSWORD_OPTIONS,
  type PasswordOptions,
  type VaultEntryType,
  type VaultSort,
} from '@runova/core';
import type { VaultLockReason } from '@shared/apiTypes';
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import type { VaultCategoryFilter } from '@/lib/vault/categories';

export type VaultTypeFilter = VaultEntryType | 'all';

/** Where the Log in button opens a site: Runova's login window, a project's tab, or the browser. */
export type VaultLoginChoice =
  | { kind: 'window' }
  | { kind: 'workspace'; projectId: string }
  | { kind: 'system' };

interface VaultViewState {
  selectedId: string | null;
  query: string;
  typeFilter: VaultTypeFilter;
  tagFilters: string[];
  favoritesOnly: boolean;
  categoryFilter: VaultCategoryFilter;
  sort: VaultSort;
  /** Why the vault last locked, shown on the lock screen. Cleared on unlock. */
  lastLockReason: VaultLockReason | null;
  generator: PasswordOptions;
  loginTarget: VaultLoginChoice;
  select: (id: string | null) => void;
  setQuery: (query: string) => void;
  setTypeFilter: (filter: VaultTypeFilter) => void;
  toggleTag: (tag: string) => void;
  setFavoritesOnly: (value: boolean) => void;
  setCategoryFilter: (filter: VaultCategoryFilter) => void;
  clearFilters: () => void;
  setSort: (sort: VaultSort) => void;
  setLastLockReason: (reason: VaultLockReason | null) => void;
  setGenerator: (options: PasswordOptions) => void;
  setLoginTarget: (target: VaultLoginChoice) => void;
  /** Drops everything tied to the unlocked vault: selection, search text and filters. */
  resetView: () => void;
}

const VIEW_DEFAULTS = {
  selectedId: null,
  query: '',
  typeFilter: 'all',
  tagFilters: [],
  favoritesOnly: false,
  categoryFilter: 'all',
} satisfies Partial<VaultViewState>;

export const useVaultStore = create<VaultViewState>()(
  persist(
    (set) => ({
      ...VIEW_DEFAULTS,
      sort: 'title',
      lastLockReason: null,
      generator: { ...DEFAULT_PASSWORD_OPTIONS },
      loginTarget: { kind: 'window' },
      select: (selectedId) => set({ selectedId }),
      setQuery: (query) => set({ query }),
      setTypeFilter: (typeFilter) => set({ typeFilter }),
      toggleTag: (tag) =>
        set((state) => ({
          tagFilters: state.tagFilters.includes(tag)
            ? state.tagFilters.filter((t) => t !== tag)
            : [...state.tagFilters, tag],
        })),
      setFavoritesOnly: (favoritesOnly) => set({ favoritesOnly }),
      setCategoryFilter: (categoryFilter) => set({ categoryFilter }),
      clearFilters: () =>
        set({
          typeFilter: 'all',
          tagFilters: [],
          favoritesOnly: false,
          categoryFilter: 'all',
          query: '',
        }),
      setSort: (sort) => set({ sort }),
      setLastLockReason: (lastLockReason) => set({ lastLockReason }),
      setGenerator: (generator) => set({ generator }),
      setLoginTarget: (loginTarget) => set({ loginTarget }),
      resetView: () => set({ ...VIEW_DEFAULTS }),
    }),
    {
      name: 'runova-vault-view',
      // Only preferences. The search text, tags, category and selection describe vault contents.
      partialize: (state) => ({
        sort: state.sort,
        generator: state.generator,
        loginTarget: state.loginTarget,
      }),
    },
  ),
);
