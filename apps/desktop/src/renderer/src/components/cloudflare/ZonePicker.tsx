import type { CloudflareZone } from '@shared/cloudflareTypes';
import { ChevronsUpDown, Globe, Plus } from '@/components/icons';
import { FOOTER_HAIRLINE } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { FIELD_SURFACE } from '@/components/ui/input';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { cn } from '@/lib/utils';
import { type ZoneGroup, ZoneRail, zoneStateText } from './ZoneRail';

/** Marks the list's popover, so the page's Ctrl+F still works from inside it. */
export const PICKER_ATTRIBUTE = 'data-zone-picker';

function StateDot({ zone }: { zone: CloudflareZone }): React.JSX.Element {
  const live = zone.status === 'active' && !zone.paused;
  return (
    <span
      aria-hidden
      className={cn('h-1.5 w-1.5 shrink-0 rounded-full', live ? 'bg-success' : 'bg-warning')}
    />
  );
}

/**
 * The domain being managed, and the way to switch to another. The list is the one the dialog
 * used to keep in a side column (search, account names, arrow keys), opened from a pill instead,
 * so the zone below gets the page's whole width.
 */
export function ZonePicker({
  groups,
  selected,
  open,
  onOpenChange,
  onSelect,
  onManageAccount,
  onAddAccount,
  searchRef,
}: {
  groups: ZoneGroup[];
  selected: CloudflareZone | undefined;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onSelect: (zone: CloudflareZone) => void;
  onManageAccount: (accountId: string) => void;
  onAddAccount: () => void;
  /** The search box, so Ctrl+F lands in it and Escape can clear it before closing the list. */
  searchRef: React.RefObject<HTMLInputElement | null>;
}): React.JSX.Element {
  const total = groups.reduce((sum, group) => sum + (group.zones?.length ?? 0), 0);
  const failed = groups.filter((group) => group.error).length;
  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      <PopoverTrigger asChild>
        <button
          type="button"
          aria-label={selected ? `Choose a domain, ${selected.name} is open` : 'Choose a domain'}
          className={cn(
            FIELD_SURFACE,
            'flex h-9 w-72 max-w-full cursor-pointer items-center gap-2 rounded-full py-2 pl-3 pr-2.5 text-left text-sm focus:outline-none',
          )}
        >
          <Globe className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
          <span className="min-w-0 flex-1 truncate">
            {selected ? selected.name : 'Choose a domain'}
          </span>
          {selected && (
            <span className="flex shrink-0 items-center gap-1.5 text-[11px] text-muted-foreground">
              <StateDot zone={selected} />
              <span className="sr-only">{zoneStateText(selected)}</span>
            </span>
          )}
          {failed > 0 ? (
            <span className="shrink-0 rounded-full bg-warning/15 px-1.5 text-[10px] leading-4 text-warning">
              {failed === 1 ? '1 account failed' : `${failed} accounts failed`}
            </span>
          ) : (
            total > 1 && (
              <span className="shrink-0 rounded-full bg-foreground/[0.06] px-1.5 text-[10px] leading-4 tabular-nums text-muted-foreground">
                {total}
              </span>
            )
          )}
          <ChevronsUpDown className="h-4 w-4 shrink-0 opacity-50" />
        </button>
      </PopoverTrigger>
      <PopoverContent
        {...{ [PICKER_ATTRIBUTE]: '' }}
        align="end"
        className="flex max-h-[min(28rem,70vh)] w-80 max-w-[calc(100vw-2rem)] flex-col p-0"
        onOpenAutoFocus={(event) => {
          // Straight into the search, the way the dialog's Ctrl+F used to work.
          const search = searchRef.current;
          if (!search) return;
          event.preventDefault();
          search.focus();
        }}
        onEscapeKeyDown={(event) => {
          // Escape in the search with text in it clears the search, not the list. Radix hears
          // Escape before the box does, so the box cannot stop it on its own.
          const search = searchRef.current;
          if (search && event.target === search && search.value) event.preventDefault();
        }}
      >
        <ZoneRail
          groups={groups}
          searchRef={searchRef}
          selectedId={selected?.id ?? null}
          onSelect={onSelect}
          onManageAccount={onManageAccount}
        />
        <div className={cn(FOOTER_HAIRLINE, 'shrink-0 p-2')}>
          <Button variant="soft" size="sm" className="w-full" onClick={onAddAccount}>
            <Plus className="h-3.5 w-3.5" /> Add account
          </Button>
        </div>
      </PopoverContent>
    </Popover>
  );
}
