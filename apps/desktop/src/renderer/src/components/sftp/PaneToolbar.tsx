import type { SftpLocalPlace } from '@shared/sftpTypes';
import { useId, useRef, useState } from 'react';
import {
  ArrowUp,
  Download,
  Eye,
  EyeOff,
  Filter,
  FolderOpen,
  FolderPlus,
  HardDrive,
  Monitor,
  RefreshCw,
  Upload,
  X,
} from '@/components/icons';
import { Button } from '@/components/ui/button';
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';

/** A house, drawn here because the app's icon set has none; sized and coloured like the rest. */
function HomeIcon({ className }: { className?: string }): React.JSX.Element {
  return (
    <svg aria-hidden viewBox="0 0 16 16" fill="currentColor" className={className}>
      <path d="M8 1.2 0.9 7.1a.6.6 0 0 0 .77.92L2.5 7.3V14a1 1 0 0 0 1 1h3V10.5h3V15h3a1 1 0 0 0 1-1V7.3l.83.72a.6.6 0 0 0 .77-.92z" />
    </svg>
  );
}

function IconButton({
  id,
  label,
  onClick,
  disabled,
  pressed,
  children,
}: {
  id?: string;
  label: string;
  onClick: () => void;
  disabled?: boolean;
  pressed?: boolean;
  children: React.ReactNode;
}): React.JSX.Element {
  return (
    <SimpleTooltip label={label} wrapTrigger={disabled}>
      <Button
        id={id}
        variant="ghost"
        size="icon-sm"
        aria-label={label}
        aria-pressed={pressed}
        disabled={disabled}
        onClick={onClick}
        className={cn('shrink-0', pressed && 'bg-primary/12 text-primary hover:text-primary')}
      >
        {children}
      </Button>
    </SimpleTooltip>
  );
}

const PLACE_ICON: Record<SftpLocalPlace['kind'], React.ComponentType<{ className?: string }>> = {
  drive: HardDrive,
  root: HardDrive,
  home: HomeIcon,
  desktop: Monitor,
  documents: FolderOpen,
  downloads: Download,
};

function PlacesMenu({
  places,
  onPlace,
}: {
  places: SftpLocalPlace[];
  onPlace: (place: SftpLocalPlace) => void;
}): React.JSX.Element {
  const drives = places.filter((place) => place.kind === 'drive' || place.kind === 'root');
  const folders = places.filter((place) => place.kind !== 'drive' && place.kind !== 'root');
  const row = (place: SftpLocalPlace) => {
    const Icon = PLACE_ICON[place.kind];
    return (
      <DropdownMenuItem key={place.id} onSelect={() => onPlace(place)}>
        <Icon className="size-3.5 text-muted-foreground" />
        <span className="truncate">{place.label}</span>
      </DropdownMenuItem>
    );
  };
  return (
    <DropdownMenu>
      <SimpleTooltip label="Places">
        <DropdownMenuTrigger asChild>
          <Button variant="ghost" size="icon-sm" aria-label="Places" className="shrink-0">
            <HardDrive />
          </Button>
        </DropdownMenuTrigger>
      </SimpleTooltip>
      <DropdownMenuContent align="start" className="min-w-[13rem]">
        {folders.length > 0 ? <DropdownMenuLabel>Folders</DropdownMenuLabel> : null}
        {folders.map(row)}
        {folders.length > 0 && drives.length > 0 ? <DropdownMenuSeparator /> : null}
        {drives.length > 0 ? <DropdownMenuLabel>Drives</DropdownMenuLabel> : null}
        {drives.map(row)}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** The text filter: a small search pill that narrows the list as you type. */
function FilterPill({
  side,
  value,
  onChange,
  autoFocus,
  onDone,
}: {
  side: 'local' | 'remote';
  value: string;
  onChange: (value: string) => void;
  autoFocus?: boolean;
  /** Enter or Escape: the compact toolbar folds the field back into its icon. */
  onDone?: () => void;
}): React.JSX.Element {
  const inputRef = useRef<HTMLInputElement | null>(null);
  return (
    <div
      className={cn(
        'search-pill flex h-7 min-w-0 shrink items-center gap-1.5 rounded-full pl-2.5 pr-1 transition-[width] duration-150 motion-reduce:transition-none',
        value ? 'w-40' : 'w-28 focus-within:w-40',
      )}
    >
      <Filter aria-hidden className="h-3 w-3 shrink-0 text-muted-foreground" />
      <input
        ref={inputRef}
        autoFocus={autoFocus}
        aria-label={
          side === 'remote' ? 'Filter files on the server' : 'Filter files on this computer'
        }
        placeholder="Filter"
        value={value}
        spellCheck={false}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === 'Escape') {
            event.preventDefault();
            onChange('');
            onDone?.();
          } else if (event.key === 'Enter') {
            event.preventDefault();
            onDone?.();
          }
        }}
        className="min-w-0 flex-1 bg-transparent text-[12px] outline-none placeholder:text-muted-foreground"
      />
      {value ? (
        <SimpleTooltip label="Clear the filter">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Clear the filter"
            onClick={() => {
              onChange('');
              inputRef.current?.focus();
            }}
            className="h-5 w-5 shrink-0"
          >
            <X />
          </Button>
        </SimpleTooltip>
      ) : null}
    </div>
  );
}

/**
 * The filter of the compact toolbar: an icon that opens the field. While a filter is on the
 * icon stays lit and names it, with a way to clear it, so a filter set on the page never hides
 * files in the dock unseen.
 */
function CompactFilter({
  side,
  value,
  onChange,
}: {
  side: 'local' | 'remote';
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const [editing, setEditing] = useState(false);
  const buttonId = useId();

  function done(): void {
    setEditing(false);
    // The field goes away under the focus, so it goes back to the icon.
    requestAnimationFrame(() => document.getElementById(buttonId)?.focus());
  }

  if (editing) {
    return (
      <div
        className="flex min-w-0 shrink"
        onBlur={(event) => {
          if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setEditing(false);
        }}
      >
        <FilterPill side={side} value={value} onChange={onChange} autoFocus onDone={done} />
      </div>
    );
  }
  return (
    <>
      <IconButton
        id={buttonId}
        label={value ? `Filtered: ${value}` : 'Filter'}
        pressed={value !== ''}
        onClick={() => setEditing(true)}
      >
        <Filter />
      </IconButton>
      {value ? (
        <IconButton label="Clear the filter" onClick={() => onChange('')}>
          <X />
        </IconButton>
      ) : null}
    </>
  );
}

export interface PaneToolbarProps {
  side: 'local' | 'remote';
  /** The card's title: an icon and what the pane shows. */
  heading: React.ReactNode;
  /** Extra controls at the end of the title row, like Disconnect. */
  actions?: React.ReactNode;
  canGoUp: boolean;
  loading: boolean;
  onUp: () => void;
  onHome: () => void;
  onRefresh: () => void;
  onNewFolder: () => void;
  /** Off while nothing is selected or the other side has no folder open. */
  transferDisabled: boolean;
  onTransfer: () => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  filter: string;
  onFilterChange: (value: string) => void;
  /** The local pane's Places menu. */
  places?: SftpLocalPlace[] | null;
  onPlace?: (place: SftpLocalPlace) => void;
  /** The path bar, which sits after Up, Home and Refresh. */
  children: React.ReactNode;
  /** The docked pane's single row, for the short terminal drawer. */
  compact?: boolean;
}

/**
 * The two rows at the top of a pane: the title with the pane's actions (transfer, new folder,
 * hidden files, filter, places), then Up, Home and Refresh beside the path bar. Compact puts
 * all of it on one row.
 */
export function PaneToolbar({
  side,
  heading,
  actions,
  canGoUp,
  loading,
  onUp,
  onHome,
  onRefresh,
  onNewFolder,
  transferDisabled,
  onTransfer,
  showHidden,
  onToggleHidden,
  filter,
  onFilterChange,
  places,
  onPlace,
  children,
  compact = false,
}: PaneToolbarProps): React.JSX.Element {
  const transferLabel = side === 'local' ? 'Upload to server' : 'Download to this computer';
  const TransferIcon = side === 'local' ? Upload : Download;
  const hiddenLabel = showHidden ? 'Hide hidden files' : 'Show hidden files';

  const filterPill = <FilterPill side={side} value={filter} onChange={onFilterChange} />;
  const tools = (
    <>
      <IconButton label={hiddenLabel} pressed={showHidden} onClick={onToggleHidden}>
        {showHidden ? <Eye /> : <EyeOff />}
      </IconButton>
      <IconButton label="New folder" onClick={onNewFolder}>
        <FolderPlus />
      </IconButton>
      {side === 'local' && places && places.length > 0 && onPlace ? (
        <PlacesMenu places={places} onPlace={onPlace} />
      ) : null}
      <SimpleTooltip
        label={transferDisabled ? `${transferLabel}: select files first` : transferLabel}
        wrapTrigger={transferDisabled}
      >
        <Button
          variant="tint"
          size="sm"
          aria-label={transferLabel}
          disabled={transferDisabled}
          onClick={onTransfer}
          className="shrink-0 px-2.5"
        >
          <TransferIcon className="size-3.5" />
          {/* The words go first on a narrow pane; the tooltip still says them. */}
          <span className="hidden @min-[520px]/pane:inline">
            {side === 'local' ? 'Upload' : 'Download'}
          </span>
        </Button>
      </SimpleTooltip>
      {actions}
    </>
  );
  const nav = (
    <>
      <IconButton label="Up one folder" disabled={!canGoUp} onClick={onUp}>
        <ArrowUp />
      </IconButton>
      <IconButton
        label={side === 'remote' ? 'Home folder on the server' : 'Home folder'}
        onClick={onHome}
      >
        <HomeIcon className="size-3.5" />
      </IconButton>
      <IconButton label="Refresh" onClick={onRefresh}>
        <RefreshCw className={cn(loading && 'motion-safe:animate-spin')} />
      </IconButton>
    </>
  );

  if (compact) {
    // One row for the short drawer. The filter is an icon, the title gives way on a narrow
    // pane and the path bar shrinks, so the buttons keep fitting. The pane's section names it.
    return (
      <div
        data-pane-toolbar
        data-compact
        className="flex h-11 shrink-0 items-center gap-1 px-1.5 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]"
      >
        <div className="hidden min-w-0 max-w-[9rem] shrink items-center gap-2 pl-1 @min-[480px]/pane:flex">
          {heading}
        </div>
        {nav}
        <div className="flex min-w-0 flex-1">{children}</div>
        <CompactFilter side={side} value={filter} onChange={onFilterChange} />
        {tools}
      </div>
    );
  }

  return (
    <div
      data-pane-toolbar
      className="flex shrink-0 flex-col gap-1.5 px-2.5 pb-2 pt-2 shadow-[inset_0_-1px_0_hsl(var(--border)/0.6)]"
    >
      <div className="flex h-8 min-w-0 items-center gap-1.5">
        <div className="flex min-w-0 flex-1 items-center gap-2 pl-1">{heading}</div>
        {filterPill}
        {tools}
      </div>
      <div className="flex min-w-0 items-center gap-1">
        {nav}
        {children}
      </div>
    </div>
  );
}
