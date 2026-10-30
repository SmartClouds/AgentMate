import type { VaultCategory, VaultEntrySummary, VaultSearchHit, VaultSort } from '@runova/core';
import { LayoutGroup, motion, useReducedMotion } from 'framer-motion';
import { forwardRef } from 'react';
import {
  ChevronsUpDown,
  Download,
  EllipsisVertical,
  Key,
  Lock,
  Plus,
  Search,
  Star,
  Upload,
  Vault,
  X,
} from '@/components/icons';
import { SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import { useShortcutLabel } from '@/stores/shortcutStore';
import { useVaultStore, type VaultTypeFilter } from '@/stores/vaultStore';
import { CategoryTile } from './CategoryTile';
import { ENTRY_TYPE_META, ENTRY_TYPE_ORDER } from './entryTypes';
import type { useVaultActions } from './useVaultActions';
import { VaultEntryRow, vaultOptionId } from './VaultEntryRow';

export const VAULT_LISTBOX_ID = 'vault-entries';

const SORT_LABELS: Record<VaultSort, string> = {
  title: 'Title, A to Z',
  recent: 'Recently used',
  updated: 'Recently updated',
  created: 'Newest first',
};

export interface VaultListGroup {
  label: string | null;
  hits: VaultSearchHit[];
}

/** A tag or favorites filter. Rings rather than borders, so the tint is not lost to the theme's border colour. */
function Chip({
  pressed,
  onClick,
  children,
}: {
  pressed: boolean;
  onClick: () => void;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <button
      type="button"
      aria-pressed={pressed}
      onClick={onClick}
      className={cn(
        'inline-flex h-6 shrink-0 cursor-pointer items-center gap-1 rounded-full px-2.5 text-[11px] font-medium ring-1 ring-inset transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
        pressed
          ? 'bg-primary/12 text-primary ring-primary/30'
          : 'text-muted-foreground ring-foreground/[0.1] hover:bg-foreground/[0.06] hover:text-foreground',
      )}
    >
      {children}
    </button>
  );
}

export const VaultListPane = forwardRef<
  HTMLInputElement,
  {
    entries: VaultEntrySummary[];
    groups: VaultListGroup[];
    visibleCount: number;
    searching: boolean;
    knownTags: string[];
    /** The category pills, shown above the type tabs when the window is too narrow for the rail. */
    categoryStrip?: React.ReactNode;
    categoryOf?: (entry: VaultEntrySummary) => VaultCategory | undefined;
    /** Whether rows show their category, which is pointless once the list is filtered to one. */
    showCategories?: boolean;
    /** Set when the list is filtered to a category that holds nothing yet. */
    emptyCategory?: VaultCategory;
    selectedId: string | null;
    actions: ReturnType<typeof useVaultActions>;
    onSelect: (id: string) => void;
    onSearchKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void;
    onNew: (title?: string) => void;
    onImport: () => void;
    onExport: () => void;
    onChangePassword: () => void;
    className?: string;
  }
>(function VaultListPane(
  {
    entries,
    groups,
    visibleCount,
    searching,
    knownTags,
    categoryStrip,
    categoryOf,
    showCategories = false,
    emptyCategory,
    selectedId,
    actions,
    onSelect,
    onSearchKeyDown,
    onNew,
    onImport,
    onExport,
    onChangePassword,
    className,
  },
  searchRef,
) {
  const query = useVaultStore((s) => s.query);
  const setQuery = useVaultStore((s) => s.setQuery);
  const typeFilter = useVaultStore((s) => s.typeFilter);
  const setTypeFilter = useVaultStore((s) => s.setTypeFilter);
  const tagFilters = useVaultStore((s) => s.tagFilters);
  const toggleTag = useVaultStore((s) => s.toggleTag);
  const favoritesOnly = useVaultStore((s) => s.favoritesOnly);
  const setFavoritesOnly = useVaultStore((s) => s.setFavoritesOnly);
  const clearFilters = useVaultStore((s) => s.clearFilters);
  const categoryFilter = useVaultStore((s) => s.categoryFilter);
  const sort = useVaultStore((s) => s.sort);
  const setSort = useVaultStore((s) => s.setSort);
  const newShortcut = useShortcutLabel('vault.new');
  const lockShortcut = useShortcutLabel('vault.lock');
  const searchShortcut = useShortcutLabel('vault.search');
  const reduceMotion = useReducedMotion();
  const pillTransition = reduceMotion
    ? { duration: 0 }
    : { type: 'spring' as const, stiffness: 420, damping: 32 };

  const counts = new Map<VaultTypeFilter, number>([['all', entries.length]]);
  for (const entry of entries) counts.set(entry.type, (counts.get(entry.type) ?? 0) + 1);
  const hasFavorites = entries.some((entry) => entry.favorite);
  const filtered =
    typeFilter !== 'all' || tagFilters.length > 0 || favoritesOnly || categoryFilter !== 'all';
  const trimmed = query.trim();

  return (
    <aside className={cn('flex min-h-0 flex-col', className)}>
      <div className="flex h-10 shrink-0 items-center gap-0.5 pl-3.5 pr-1.5">
        <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Vault</h2>
        <SimpleTooltip label={newShortcut ? `New entry (${newShortcut})` : 'New entry'}>
          <Button variant="ghost" size="icon-sm" aria-label="New entry" onClick={() => onNew()}>
            <Plus />
          </Button>
        </SimpleTooltip>
        <DropdownMenu>
          <SimpleTooltip label="More">
            <DropdownMenuTrigger asChild>
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label="More vault actions"
                className="data-[state=open]:bg-foreground/[0.06] data-[state=open]:text-foreground"
              >
                <EllipsisVertical />
              </Button>
            </DropdownMenuTrigger>
          </SimpleTooltip>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuItem onSelect={onImport}>
              <Upload className="h-3.5 w-3.5" />
              Import from CSV
            </DropdownMenuItem>
            <DropdownMenuItem onSelect={onExport} disabled={entries.length === 0}>
              <Download className="h-3.5 w-3.5" />
              Export to CSV
            </DropdownMenuItem>
            <DropdownMenuSeparator />
            <DropdownMenuItem onSelect={onChangePassword}>
              <Key className="h-3.5 w-3.5" />
              Change master password
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
        <SimpleTooltip label={lockShortcut ? `Lock vault (${lockShortcut})` : 'Lock vault'}>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label="Lock vault"
            onClick={() => void actions.lock()}
          >
            <Lock />
          </Button>
        </SimpleTooltip>
      </div>

      <div className="shrink-0 space-y-2.5 px-2 pb-2">
        <div className="search-pill flex h-8 items-center gap-1.5 rounded-full pl-3 pr-1 transition-colors">
          <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <input
            ref={searchRef}
            type="search"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onSearchKeyDown}
            placeholder={`Search${searchShortcut ? ` (${searchShortcut})` : ''}`}
            aria-label="Search the vault"
            aria-controls={VAULT_LISTBOX_ID}
            autoComplete="off"
            spellCheck={false}
            className="h-full min-w-0 flex-1 bg-transparent text-[13px] outline-none placeholder:text-muted-foreground/70 [&::-webkit-search-cancel-button]:appearance-none"
          />
          {query && (
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label="Clear search"
              className="shrink-0"
              onClick={() => setQuery('')}
            >
              <X />
            </Button>
          )}
        </div>

        {entries.length > 0 && categoryStrip}
        {entries.length > 0 && (
          <>
            {/* A pill group, the same shape as the segmented controls elsewhere. */}
            <LayoutGroup id="vault-types">
              <div
                role="tablist"
                aria-label="Entry types"
                className="search-pill flex gap-0.5 overflow-x-auto rounded-full p-0.5 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
              >
                {(['all', ...ENTRY_TYPE_ORDER] as VaultTypeFilter[])
                  .filter((type) => type === 'all' || (counts.get(type) ?? 0) > 0)
                  .map((type) => {
                    const selected = typeFilter === type;
                    const label = type === 'all' ? 'All' : ENTRY_TYPE_META[type].plural;
                    return (
                      <button
                        key={type}
                        type="button"
                        role="tab"
                        aria-selected={selected}
                        onClick={() => setTypeFilter(type)}
                        className={cn(
                          'relative isolate flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[11px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
                          selected ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                        )}
                      >
                        {selected && (
                          <motion.span
                            aria-hidden
                            layoutId="vault-type-active"
                            transition={pillTransition}
                            className="absolute inset-0 -z-10 rounded-full bg-primary/12 ring-1 ring-inset ring-primary/20"
                          />
                        )}
                        {label}
                        <span
                          className={cn(
                            'tabular-nums',
                            selected ? 'text-primary/70' : 'text-muted-foreground/70',
                          )}
                        >
                          {counts.get(type) ?? 0}
                        </span>
                      </button>
                    );
                  })}
              </div>
            </LayoutGroup>

            {(hasFavorites || knownTags.length > 0) && (
              <div className="flex flex-wrap items-center gap-1.5">
                {hasFavorites && (
                  <Chip pressed={favoritesOnly} onClick={() => setFavoritesOnly(!favoritesOnly)}>
                    <Star className="h-2.5 w-2.5 text-warning" />
                    Favorites
                  </Chip>
                )}
                {knownTags.map((tag) => (
                  <Chip key={tag} pressed={tagFilters.includes(tag)} onClick={() => toggleTag(tag)}>
                    {tag}
                  </Chip>
                ))}
              </div>
            )}

            <div className="flex items-center justify-between px-1 text-[11px] text-muted-foreground">
              <span aria-live="polite" className="tabular-nums">
                {searching || filtered
                  ? `${visibleCount} ${visibleCount === 1 ? 'result' : 'results'}`
                  : `${entries.length} ${entries.length === 1 ? 'entry' : 'entries'}`}
              </span>
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button
                    type="button"
                    className="inline-flex cursor-pointer items-center gap-1 rounded-full px-2 py-0.5 transition-colors hover:bg-foreground/[0.06] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                    aria-label={`Sort: ${SORT_LABELS[sort]}`}
                  >
                    {searching ? 'Best match' : SORT_LABELS[sort]}
                    <ChevronsUpDown className="h-2.5 w-2.5" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="end">
                  <DropdownMenuLabel>Sort by</DropdownMenuLabel>
                  {(Object.keys(SORT_LABELS) as VaultSort[]).map((option) => (
                    <DropdownMenuCheckboxItem
                      key={option}
                      checked={sort === option}
                      onCheckedChange={() => setSort(option)}
                    >
                      {SORT_LABELS[option]}
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>
            </div>
          </>
        )}
      </div>

      <div className="rail-scroll min-h-0 flex-1 overflow-y-auto px-2 pb-2">
        {entries.length === 0 ? (
          <div className="flex flex-col items-center gap-3 px-3 pb-6 pt-10 text-center">
            <div className="flex h-11 w-11 items-center justify-center rounded-2xl bg-primary/12 text-primary shadow-[0_0_40px_-12px_hsl(var(--primary)/0.7)]">
              <Vault className="h-5 w-5" />
            </div>
            <div className="space-y-1">
              <p className="text-sm font-medium">Your vault is empty</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Add logins, API keys and private notes, or bring them over from your browser or
                another password manager.
              </p>
            </div>
            <div className="flex flex-wrap justify-center gap-2">
              <Button onClick={() => onNew()}>
                <Plus className="h-3 w-3" />
                Add your first entry
              </Button>
              <Button variant="soft" onClick={onImport}>
                <Upload className="h-3 w-3" />
                Import from CSV
              </Button>
            </div>
          </div>
        ) : emptyCategory && !trimmed ? (
          <div className="flex flex-col items-center gap-3 px-4 pb-6 pt-10 text-center">
            <CategoryTile color={emptyCategory.color} icon={emptyCategory.icon} size="lg" />
            <div className="space-y-1">
              <p className="text-sm font-medium">Nothing in {emptyCategory.name} yet</p>
              <p className="text-xs leading-relaxed text-muted-foreground">
                Drag entries onto the category, or add a new one here.
              </p>
            </div>
            <Button aria-label={`Add an entry to ${emptyCategory.name}`} onClick={() => onNew()}>
              <Plus className="h-3 w-3" />
              Add entry
            </Button>
          </div>
        ) : visibleCount === 0 ? (
          <div className="flex flex-col items-center gap-3 px-4 py-10 text-center">
            <Search className="h-4 w-4 text-muted-foreground/60" />
            <p className="text-xs text-muted-foreground">
              {trimmed ? `Nothing matches "${trimmed}"` : 'Nothing matches these filters'}
            </p>
            <div className="flex flex-wrap justify-center gap-2">
              {trimmed && (
                <Button onClick={() => onNew(trimmed)}>
                  <Plus className="h-3 w-3" />
                  Create "{trimmed}"
                </Button>
              )}
              {filtered && (
                <Button variant="ghost" onClick={clearFilters}>
                  Clear filters
                </Button>
              )}
            </div>
          </div>
        ) : (
          <LayoutGroup id="vault-entries">
            <div
              id={VAULT_LISTBOX_ID}
              role="listbox"
              aria-label="Vault entries"
              aria-activedescendant={selectedId ? vaultOptionId(selectedId) : undefined}
              tabIndex={0}
              className="space-y-3 rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
            >
              {groups.map((group) => (
                <div
                  key={group.label ?? 'all'}
                  role="group"
                  aria-label={group.label ?? 'Entries'}
                  className="flex flex-col gap-px"
                >
                  {group.label && (
                    <p aria-hidden="true" className={cn(SECTION_HEADING, 'px-2.5 pb-1 pt-1')}>
                      {group.label}
                    </p>
                  )}
                  {group.hits.map((hit) => (
                    <VaultEntryRow
                      key={hit.summary.id}
                      entry={hit.summary}
                      titleRanges={hit.titleRanges}
                      selected={hit.summary.id === selectedId}
                      onSelect={() => onSelect(hit.summary.id)}
                      actions={actions}
                      category={showCategories ? categoryOf?.(hit.summary) : undefined}
                      pillTransition={pillTransition}
                    />
                  ))}
                </div>
              ))}
            </div>
          </LayoutGroup>
        )}
      </div>
    </aside>
  );
});
