import type { Project } from '@runova/core';
import {
  parseVaultQuery,
  searchEntries,
  type VaultCategory,
  type VaultEntrySummary,
  type VaultSearchHit,
} from '@runova/core';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import { Vault } from '@/components/icons';
import { ResizeHandle } from '@/components/ui/ResizeHandle';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import type { VaultShortcutCommandId } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { categoryCounts, inCategory } from '@/lib/vault/categories';
import { resolveLoginChoice, runOneClickLogin } from '@/lib/vault/oneClickLogin';
import { PANEL_WIDTHS, usePanelWidth } from '@/stores/panelWidthStore';
import { commandForEvent, useShortcutLabel, useShortcutStore } from '@/stores/shortcutStore';
import { useVaultStore } from '@/stores/vaultStore';
import { ChangeMasterPasswordDialog } from './ChangeMasterPasswordDialog';
import { primarySecret } from './entryTypes';
import { useVaultActions } from './useVaultActions';
import { useVaultCategories } from './useVaultCategories';
import { useVaultCategoryActions } from './useVaultCategoryActions';
import { VaultCategoryDialog } from './VaultCategoryDialog';
import { VaultCategoryRail, type VaultCategoryRailProps } from './VaultCategoryRail';
import { VaultDetailPane } from './VaultDetailPane';
import { VaultEntryDialog, type VaultEntryDialogTarget } from './VaultEntryDialog';
import { vaultOptionId } from './VaultEntryRow';
import { VaultExportDialog } from './VaultExportDialog';
import { VaultImportDialog } from './VaultImportDialog';
import { type VaultListGroup, VaultListPane } from './VaultListPane';

type VaultDialogState =
  | { kind: 'entry'; target: VaultEntryDialogTarget }
  | { kind: 'import' }
  | { kind: 'export' }
  | { kind: 'password' }
  | { kind: 'category'; category?: VaultCategory }
  | null;

function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function isDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/** The list and the detail are two glass cards, rounded like the API Client's. */
const PANEL = 'glass flex min-h-0 flex-col overflow-hidden rounded-[calc(var(--radius)+2px)]';

function ListSkeleton(): React.JSX.Element {
  return (
    <div role="status" aria-label="Loading entries" className="flex flex-col gap-1 p-2">
      <Skeleton className="mb-1 h-8 w-full rounded-full" />
      {Array.from({ length: 6 }, (_, i) => (
        <div key={i} className="flex h-12 items-center gap-3 px-2.5">
          <Skeleton className="h-8 w-8 rounded-lg" />
          <div className="flex-1 space-y-1.5">
            <Skeleton className="h-3.5 w-2/3" />
            <Skeleton className="h-3 w-1/3" />
          </div>
        </div>
      ))}
    </div>
  );
}

function EmptyDetail(): React.JSX.Element {
  const shortcuts = [
    ['Search', useShortcutLabel('vault.search')],
    ['New entry', useShortcutLabel('vault.new')],
    ['Copy password', useShortcutLabel('vault.copyPassword')],
    ['Lock', useShortcutLabel('vault.lock')],
  ].filter((pair): pair is [string, string] => Boolean(pair[1]));
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-4 p-8 text-center">
      <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
        <Vault className="h-6 w-6" />
      </div>
      <div className="max-w-sm space-y-1.5">
        <p className="text-base font-semibold tracking-tight">Pick an entry to see its details</p>
        <p className="text-sm text-muted-foreground">
          Passwords stay hidden until you ask for them.
        </p>
      </div>
      {shortcuts.length > 0 && (
        <dl className="grid grid-cols-[auto_auto] gap-x-4 gap-y-1.5 text-xs">
          {shortcuts.map(([label, keys]) => (
            <div key={label} className="contents">
              <dt className="text-right text-muted-foreground">{label}</dt>
              <dd className="text-left">
                <kbd className="rounded-md border border-border bg-foreground/[0.05] px-1.5 py-0.5 font-sans text-[10px] font-medium">
                  {keys}
                </kbd>
              </dd>
            </div>
          ))}
        </dl>
      )}
    </div>
  );
}

export function VaultUnlockedView(): React.JSX.Element {
  const entriesQuery = useQuery({
    queryKey: queryKeys.vaultEntries,
    queryFn: () => window.runova.vault.list(),
    meta: { silentLoading: true },
  });
  const actions = useVaultActions();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const searchRef = useRef<HTMLInputElement>(null);
  const [dialog, setDialog] = useState<VaultDialogState>(null);
  const [detailOpen, setDetailOpen] = useState(false);
  const [listWidth, setListWidth] = usePanelWidth('vaultList');

  const query = useVaultStore((s) => s.query);
  const setQuery = useVaultStore((s) => s.setQuery);
  const typeFilter = useVaultStore((s) => s.typeFilter);
  const tagFilters = useVaultStore((s) => s.tagFilters);
  const favoritesOnly = useVaultStore((s) => s.favoritesOnly);
  const sort = useVaultStore((s) => s.sort);
  const selectedId = useVaultStore((s) => s.selectedId);
  const select = useVaultStore((s) => s.select);
  const toggleTag = useVaultStore((s) => s.toggleTag);
  const categoryFilter = useVaultStore((s) => s.categoryFilter);
  const setCategoryFilter = useVaultStore((s) => s.setCategoryFilter);
  const { categories } = useVaultCategories();
  const categoryActions = useVaultCategoryActions();

  const entries = entriesQuery.data ?? [];
  const counts = useMemo(() => categoryCounts(entries, categories), [entries, categories]);
  const categoryById = useMemo(() => new Map(categories.map((c) => [c.id, c])), [categories]);
  // A category deleted elsewhere drops back to every entry instead of an empty list.
  const activeCategory =
    categoryFilter === 'all' || categoryFilter === 'uncategorized'
      ? categoryFilter
      : categoryById.has(categoryFilter)
        ? categoryFilter
        : 'all';
  const knownTags = useMemo(
    () =>
      [...new Set(entries.flatMap((entry) => entry.tags))].sort((a, b) =>
        a.localeCompare(b, undefined, { sensitivity: 'base' }),
      ),
    [entries],
  );
  const searching = parseVaultQuery(query).terms.length > 0;

  const hits = useMemo(() => {
    const known = new Set(categoryById.keys());
    return searchEntries(
      entries.filter((entry) => inCategory(entry, activeCategory, known)),
      query,
      {
        types: typeFilter === 'all' ? undefined : [typeFilter],
        tags: tagFilters,
        favoritesOnly,
        sort,
      },
    );
  }, [entries, categoryById, activeCategory, query, typeFilter, tagFilters, favoritesOnly, sort]);

  // Favorites are pinned on top while browsing. A search is ranked as one list instead.
  const groups = useMemo<VaultListGroup[]>(() => {
    if (searching || favoritesOnly) return [{ label: null, hits }];
    const favorites = hits.filter((hit) => hit.summary.favorite);
    if (favorites.length === 0) return [{ label: null, hits }];
    const rest = hits.filter((hit) => !hit.summary.favorite);
    const result: VaultListGroup[] = [{ label: 'Favorites', hits: favorites }];
    if (rest.length) result.push({ label: 'All entries', hits: rest });
    return result;
  }, [hits, searching, favoritesOnly]);

  const ordered = useMemo<VaultSearchHit[]>(() => groups.flatMap((group) => group.hits), [groups]);
  // Only what the list shows can be selected, so the detail pane never describes a hidden entry.
  const selected: VaultEntrySummary | undefined = ordered.find(
    (hit) => hit.summary.id === selectedId,
  )?.summary;

  const openEntry = useCallback(
    (target: VaultEntryDialogTarget) => setDialog({ kind: 'entry', target }),
    [],
  );
  // A new entry starts in the category the list is showing.
  const newEntry = useCallback(
    (title?: string) =>
      openEntry({
        mode: 'new',
        title,
        ...(categoryById.has(activeCategory) ? { categoryId: activeCategory } : {}),
      }),
    [openEntry, categoryById, activeCategory],
  );
  const categoryProps: Omit<VaultCategoryRailProps, 'variant' | 'className'> = {
    categories,
    counts,
    active: activeCategory,
    onSelect: setCategoryFilter,
    onNew: () => setDialog({ kind: 'category' }),
    onEdit: (category) => setDialog({ kind: 'category', category }),
    onDelete: (category) =>
      void categoryActions.remove(category, counts.byId.get(category.id) ?? 0),
    onReorder: (ids) => void categoryActions.reorder(ids),
    onDropEntries: (ids, categoryId) => void categoryActions.move(ids, categoryId),
  };

  const moveSelection = useCallback(
    (delta: number, edge?: 'first' | 'last') => {
      if (ordered.length === 0) return;
      let index: number;
      if (edge === 'first') index = 0;
      else if (edge === 'last') index = ordered.length - 1;
      else {
        const at = ordered.findIndex((hit) => hit.summary.id === selectedId);
        index = at === -1 ? (delta > 0 ? 0 : ordered.length - 1) : at + delta;
        index = Math.max(0, Math.min(ordered.length - 1, index));
      }
      const id = ordered[index].summary.id;
      select(id);
      document.getElementById(vaultOptionId(id))?.scrollIntoView({ block: 'nearest' });
    },
    [ordered, selectedId, select],
  );

  function onSearchKeyDown(event: React.KeyboardEvent<HTMLInputElement>): void {
    switch (event.key) {
      case 'ArrowDown':
        event.preventDefault();
        moveSelection(1);
        break;
      case 'ArrowUp':
        event.preventDefault();
        moveSelection(-1);
        break;
      case 'Enter':
        if (event.ctrlKey || event.metaKey) return;
        event.preventDefault();
        if (!ordered.some((hit) => hit.summary.id === selectedId)) moveSelection(0, 'first');
        else setDetailOpen(true);
        break;
      case 'Escape':
        if (query) {
          event.preventDefault();
          event.stopPropagation();
          setQuery('');
        } else {
          searchRef.current?.blur();
        }
        break;
    }
  }

  // Keys on the list itself, once it has focus.
  function onListKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (
      isTypingTarget(event.target) ||
      !(event.target as HTMLElement).closest('[role="listbox"]')
    ) {
      return;
    }
    const keys: Record<string, () => void> = {
      ArrowDown: () => moveSelection(1),
      ArrowUp: () => moveSelection(-1),
      Home: () => moveSelection(0, 'first'),
      End: () => moveSelection(0, 'last'),
      Enter: () => selected && setDetailOpen(true),
      Delete: () => selected && void actions.remove(selected),
    };
    const run = keys[event.key];
    if (!run) return;
    event.preventDefault();
    run();
  }

  // The Vault page's own shortcuts. They step aside for open dialogs and for the terminal drawer,
  // which uses Ctrl+L and Ctrl+Shift+C itself.
  useEffect(() => {
    const run: Record<VaultShortcutCommandId, () => void> = {
      'vault.search': () => {
        searchRef.current?.focus();
        searchRef.current?.select();
      },
      'vault.new': () => newEntry(),
      'vault.edit': () => selected && openEntry({ mode: 'edit', id: selected.id }),
      'vault.lock': () => void actions.lock(),
      'vault.copyPassword': () => {
        const secret = selected && primarySecret(selected);
        if (selected && secret) void actions.copy(selected.id, secret.ref, secret.label);
      },
      'vault.copyUsername': () => {
        if (selected?.type === 'login' && selected.username) {
          void actions.copy(selected.id, 'username', 'Username');
        }
      },
      'vault.login': () => {
        if (!selected) return;
        const choice = resolveLoginChoice(
          useVaultStore.getState().loginTarget,
          queryClient.getQueryData<Project[]>(queryKeys.projects),
        );
        void runOneClickLogin({ entry: selected, choice, navigate });
      },
    };
    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing || isDialogOpen()) return;
      if (event.target instanceof Element && event.target.closest('.xterm')) return;
      const id = commandForEvent(
        event,
        useShortcutStore.getState().overrides,
        isTypingTarget(event.target),
        'vault',
      );
      if (!id) return;
      event.preventDefault();
      run[id]();
    }
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [actions, openEntry, newEntry, selected, queryClient, navigate]);

  // Anything that isn't a click or key in the page still counts as "using the vault" for auto-lock.
  useEffect(() => {
    let last = 0;
    function onActivity(): void {
      const now = Date.now();
      if (now - last < 30_000) return;
      last = now;
      void window.runova.vault.touch();
    }
    window.addEventListener('pointerdown', onActivity);
    window.addEventListener('keydown', onActivity);
    return () => {
      window.removeEventListener('pointerdown', onActivity);
      window.removeEventListener('keydown', onActivity);
    };
  }, []);

  // `/vault` with `{ entryId }` state, from the command palette: select it and clear the state so
  // a reload or going back doesn't jump there again.
  const deepLinkId = (location.state as { entryId?: string } | null)?.entryId;
  useEffect(() => {
    if (!deepLinkId || !entriesQuery.data) return;
    if (entriesQuery.data.some((entry) => entry.id === deepLinkId)) {
      useVaultStore.getState().clearFilters();
      select(deepLinkId);
      setDetailOpen(true);
    }
    navigate(location.pathname, { replace: true, state: null });
  }, [deepLinkId, entriesQuery.data, select, navigate, location.pathname]);

  const closeDialog = useCallback(() => setDialog(null), []);

  return (
    <div className="@container/vault relative flex-1">
      {/* Two glass cards with the resize handle as the gap between them, like the API Client.
          On a narrow island only one shows at a time, and the detail has a back button. */}
      <div className="absolute inset-0 flex p-2">
        {/* The categories get their own card on a wide window, and a strip of pills otherwise. */}
        <div className={cn(PANEL, 'mr-2 hidden w-52 shrink-0 @5xl/vault:flex')}>
          <VaultCategoryRail variant="rail" className="flex-1" {...categoryProps} />
        </div>
        <div
          // The width only applies side by side. The cap keeps a wide saved width from
          // squeezing the detail card on a narrow window.
          style={{ '--vault-list-w': `${listWidth}px` } as React.CSSProperties}
          className={cn(
            PANEL,
            'w-full shrink-0 @3xl/vault:w-[var(--vault-list-w)] @3xl/vault:max-w-[46%]',
            detailOpen && selected && 'hidden @3xl/vault:flex',
          )}
          onKeyDown={onListKeyDown}
        >
          {entriesQuery.isLoading ? (
            <ListSkeleton />
          ) : (
            <VaultListPane
              ref={searchRef}
              className="flex-1"
              entries={entries}
              groups={groups}
              visibleCount={ordered.length}
              searching={searching}
              knownTags={knownTags}
              categoryStrip={
                <VaultCategoryRail
                  variant="strip"
                  className="@5xl/vault:hidden"
                  {...categoryProps}
                />
              }
              categoryOf={(entry) =>
                entry.categoryId ? categoryById.get(entry.categoryId) : undefined
              }
              showCategories={activeCategory === 'all'}
              emptyCategory={
                categoryById.has(activeCategory) && (counts.byId.get(activeCategory) ?? 0) === 0
                  ? categoryById.get(activeCategory)
                  : undefined
              }
              selectedId={selectedId}
              actions={actions}
              onSelect={(id) => {
                select(id);
                setDetailOpen(true);
              }}
              onSearchKeyDown={onSearchKeyDown}
              onNew={newEntry}
              onImport={() => setDialog({ kind: 'import' })}
              onExport={() => setDialog({ kind: 'export' })}
              onChangePassword={() => setDialog({ kind: 'password' })}
            />
          )}
        </div>
        <ResizeHandle
          orientation="vertical"
          label="Resize entry list"
          size={listWidth}
          min={PANEL_WIDTHS.vaultList.min}
          max={PANEL_WIDTHS.vaultList.max}
          defaultSize={PANEL_WIDTHS.vaultList.default}
          onSizeChange={setListWidth}
          quiet
          className="hidden w-2 @3xl/vault:flex"
        />

        <div
          className={cn(
            PANEL,
            'min-w-0 flex-1',
            detailOpen && selected ? 'flex' : 'hidden @3xl/vault:flex',
          )}
        >
          {selected ? (
            <VaultDetailPane
              key={selected.id}
              entry={selected}
              actions={actions}
              category={selected.categoryId ? categoryById.get(selected.categoryId) : undefined}
              categories={categories}
              onCategoryClick={(id) => {
                setCategoryFilter(id);
                setDetailOpen(false);
              }}
              onMove={(categoryId) => void categoryActions.move([selected.id], categoryId)}
              onEdit={() => openEntry({ mode: 'edit', id: selected.id })}
              onTagClick={(tag) => {
                if (!useVaultStore.getState().tagFilters.includes(tag)) toggleTag(tag);
                setDetailOpen(false);
              }}
              onBack={() => setDetailOpen(false)}
            />
          ) : (
            <EmptyDetail />
          )}
        </div>
      </div>

      {dialog?.kind === 'entry' && (
        <VaultEntryDialog
          key={
            dialog.target.mode === 'edit' ? dialog.target.id : `new-${dialog.target.title ?? ''}`
          }
          open
          onOpenChange={(open) => !open && closeDialog()}
          target={dialog.target}
          knownTags={knownTags}
          onSaved={(summary) => {
            select(summary.id);
            setDetailOpen(true);
          }}
        />
      )}
      {dialog?.kind === 'import' && (
        <VaultImportDialog open onOpenChange={(open) => !open && closeDialog()} />
      )}
      {dialog?.kind === 'export' && (
        <VaultExportDialog open onOpenChange={(open) => !open && closeDialog()} />
      )}
      {dialog?.kind === 'category' && (
        <VaultCategoryDialog
          key={dialog.category?.id ?? 'new'}
          open
          onOpenChange={(open) => !open && closeDialog()}
          category={dialog.category}
          onSaved={(category) => !dialog.category && setCategoryFilter(category.id)}
        />
      )}
      {dialog?.kind === 'password' && (
        <ChangeMasterPasswordDialog open onOpenChange={(open) => !open && closeDialog()} />
      )}
    </div>
  );
}
