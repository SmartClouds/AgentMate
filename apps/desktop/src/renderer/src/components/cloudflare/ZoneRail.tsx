import type { CloudflareZone } from '@shared/cloudflareTypes';
import { motion, useReducedMotion } from 'framer-motion';
import { useState } from 'react';
import { Globe } from '@/components/icons';
import { EmptyState, NoMatches, SECTION_HEADING, SearchPill } from '@/components/pageKit';
import { Skeleton } from '@/components/ui/skeleton';
import { filterZoneGroups, matchRange } from '@/lib/cloudflare/zoneSearch';
import { cn } from '@/lib/utils';
import { Problem } from './fields';

/** Marks the rows the arrow keys move between. */
const ROW_ATTRIBUTE = 'data-zone-row';

/** What a zone's state means, in words. */
export function zoneStateText(zone: CloudflareZone): string {
  if (zone.paused) return 'Paused';
  switch (zone.status) {
    case 'active':
      return 'Active';
    case 'pending':
      return 'Waiting for name servers';
    case 'initializing':
      return 'Setting up';
    case 'moved':
      return 'Moved away';
    default:
      return zone.status;
  }
}

function isLive(zone: CloudflareZone): boolean {
  return zone.status === 'active' && !zone.paused;
}

/** The name with the searched part marked, so it is clear why a domain is still listed. */
function HighlightedName({ name, query }: { name: string; query: string }): React.JSX.Element {
  const range = matchRange(name, query);
  if (!range) return <>{name}</>;
  const [start, end] = range;
  return (
    <>
      {name.slice(0, start)}
      <mark className="rounded-[3px] bg-primary/20 px-px text-inherit">
        {name.slice(start, end)}
      </mark>
      {name.slice(end)}
    </>
  );
}

/**
 * One domain in the rail: the main menu's row with a second line for the zone's state, so a zone
 * waiting for its name servers stands out before it is opened.
 */
function ZoneRow({
  zone,
  query,
  selected,
  onSelect,
}: {
  zone: CloudflareZone;
  query: string;
  selected: boolean;
  onSelect: () => void;
}): React.JSX.Element {
  const reduceMotion = useReducedMotion();
  const live = isLive(zone);
  return (
    <button
      type="button"
      data-zone-row=""
      aria-current={selected ? 'true' : undefined}
      onClick={onSelect}
      className={cn(
        // `isolate` keeps the pill behind the text without lifting every child.
        'relative isolate flex w-full cursor-pointer select-none items-center gap-2.5 rounded-lg py-1.5 pl-2.5 pr-2 text-left outline-none transition-colors focus-visible:ring-2 focus-visible:ring-ring',
        selected ? 'text-primary' : 'text-foreground/85 hover:bg-foreground/[0.06]',
      )}
    >
      {selected && (
        <motion.span
          aria-hidden
          layoutId="cloudflare-zone-active"
          transition={
            reduceMotion ? { duration: 0 } : { type: 'spring', stiffness: 420, damping: 32 }
          }
          className="absolute inset-0 -z-10 rounded-lg bg-primary/12"
        >
          <span className="absolute left-0 top-1/2 h-4 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]" />
        </motion.span>
      )}
      <Globe
        className={cn(
          'h-3.5 w-3.5 shrink-0',
          selected ? 'text-primary' : live ? 'text-foreground/70' : 'text-muted-foreground',
        )}
      />
      <span className="min-w-0 flex-1">
        <span
          className={cn(
            'block truncate text-[13px]',
            selected ? 'font-medium text-primary' : 'text-foreground',
          )}
        >
          <HighlightedName name={zone.name} query={query} />
        </span>
        <span className="flex min-w-0 items-center gap-1.5 text-[11px] text-muted-foreground">
          <span
            aria-hidden
            className={cn('h-1.5 w-1.5 shrink-0 rounded-full', live ? 'bg-success' : 'bg-warning')}
          />
          <span className="truncate">{zoneStateText(zone)}</span>
        </span>
      </span>
    </button>
  );
}

/** One account's zones as the rail shows them: loading, failed, or the list (possibly empty). */
export interface ZoneGroup {
  accountId: string;
  label: string;
  /** Undefined while the list loads. */
  zones: CloudflareZone[] | undefined;
  error: string | null;
  onRetry: () => void;
}

function GroupContent({
  group,
  query,
  selectedId,
  onSelect,
}: {
  group: ZoneGroup;
  query: string;
  selectedId: string | null;
  onSelect: (zone: CloudflareZone) => void;
}): React.JSX.Element {
  const { zones, error } = group;
  if (error) {
    return (
      <div className="px-1">
        <Problem message={error} onRetry={group.onRetry} />
      </div>
    );
  }
  if (!zones) {
    return (
      <div className="space-y-1 px-1">
        {Array.from({ length: 3 }, (_, index) => (
          <div key={index} className="flex items-center gap-2.5 px-1.5 py-1.5">
            <Skeleton className="h-3.5 w-3.5 rounded-full" />
            <div className="min-w-0 flex-1 space-y-1.5">
              <Skeleton className="h-3 w-3/4" />
              <Skeleton className="h-2.5 w-1/2" />
            </div>
          </div>
        ))}
      </div>
    );
  }
  if (zones.length === 0) {
    return (
      <EmptyState
        size="sm"
        icon={Globe}
        title="No domains yet"
        description="This token cannot see any domains yet. Add a domain on Cloudflare, or include it under Zone Resources on the token."
      />
    );
  }
  return (
    <ul className="flex flex-col gap-px">
      {zones.map((zone) => (
        <li key={zone.id}>
          <ZoneRow
            zone={zone}
            query={query}
            selected={zone.id === selectedId}
            onSelect={() => onSelect(zone)}
          />
        </li>
      ))}
    </ul>
  );
}

/** Moves focus along the rows, and from the first row back up to the search box. */
function moveFocus(event: React.KeyboardEvent<HTMLElement>, search: HTMLInputElement | null): void {
  if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
  const rows = [...event.currentTarget.querySelectorAll<HTMLElement>(`[${ROW_ATTRIBUTE}]`)];
  const target = event.target as HTMLElement;
  const at = target === search ? -1 : rows.indexOf(target);
  if (at === -1 && target !== search) return;
  event.preventDefault();
  const next = event.key === 'ArrowDown' ? at + 1 : at - 1;
  if (next < 0) search?.focus();
  else rows[Math.min(next, rows.length - 1)]?.focus();
}

/**
 * Every zone the connected tokens can see, so the one being managed is always in view. With more
 * than one account the zones sit under the account's name, and picking the name opens that
 * account's token card.
 *
 * Once there are two domains or more a search box sits on top. It takes part of a name or a whole
 * pasted address, Enter opens the first match, and the arrow keys walk from the box down the list.
 */
export function ZoneRail({
  groups,
  selectedId,
  onSelect,
  onManageAccount,
  searchRef,
}: {
  groups: ZoneGroup[];
  selectedId: string | null;
  onSelect: (zone: CloudflareZone) => void;
  onManageAccount: (accountId: string) => void;
  /** The search box, for the dialog's Ctrl+F. */
  searchRef?: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const [query, setQuery] = useState('');
  const loading = groups.some((group) => !group.zones && !group.error);
  const total = groups.reduce((sum, group) => sum + (group.zones?.length ?? 0), 0);
  const counted = groups.every((group) => group.zones);
  const grouped = groups.length > 1;
  const searchable = total > 1;
  const searching = searchable && query.trim() !== '';
  const shown = searching ? filterZoneGroups(groups, query) : groups;
  const matches = shown.flatMap((group) => (group.error ? [] : (group.zones ?? [])));
  return (
    <nav
      aria-label="Zones"
      aria-busy={loading ? 'true' : undefined}
      className="flex min-h-0 flex-1 flex-col"
      onKeyDown={(event) => moveFocus(event, searchRef?.current ?? null)}
    >
      <div className="flex h-10 shrink-0 items-center gap-2 pl-3.5 pr-3">
        <h2 className={cn(SECTION_HEADING, 'min-w-0 flex-1 truncate')}>Domains</h2>
        {counted && (
          <span
            className={cn(
              'rounded-full px-1.5 text-[10px] leading-4 tabular-nums transition-colors',
              searching
                ? 'bg-primary/12 text-primary'
                : 'bg-foreground/[0.06] text-muted-foreground',
            )}
          >
            {searching ? `${matches.length} of ${total}` : total}
          </span>
        )}
      </div>
      {searchable && (
        <div className="shrink-0 px-2 pb-2">
          <SearchPill
            ref={searchRef}
            type="search"
            value={query}
            onValueChange={setQuery}
            label="Search domains"
            clearLabel="Clear filter"
            placeholder="Search domains"
            onKeyDown={(event) => {
              if (event.key === 'Enter' && matches[0]) {
                event.preventDefault();
                onSelect(matches[0]);
              }
            }}
          />
        </div>
      )}
      <div className="rail-scroll min-h-0 flex-1 space-y-2 overflow-y-auto px-2 pb-2">
        {shown.map((group) => (
          <section
            key={group.accountId}
            aria-label={grouped ? group.label : undefined}
            className="space-y-0.5"
          >
            {grouped && (
              <button
                type="button"
                onClick={() => onManageAccount(group.accountId)}
                className="block w-full cursor-pointer truncate rounded-md px-2.5 py-1 text-left text-[11px] font-medium uppercase tracking-wide text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
              >
                {group.label}
              </button>
            )}
            <GroupContent
              group={group}
              query={searching ? query : ''}
              selectedId={selectedId}
              onSelect={onSelect}
            />
          </section>
        ))}
        {searching && matches.length === 0 && <NoMatches query={query} />}
      </div>
    </nav>
  );
}
