import { Docker, HardDrive, NetworkIcon, Package, Spinner, Trash2 } from '@/components/icons';
import { Chip, GLASS_CARD, PillTabs, SECTION_HEADING, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { SimpleTooltip } from '@/components/ui/tooltip';
import {
  AGE_FILTERS,
  type AgeFilter,
  CLEANUP_KINDS,
  type CleanupFilter,
  type CleanupItem,
  type CleanupKind,
  type SelectionSummary,
} from '@/lib/deploy/cleanup/candidates';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import { ago } from '../security/format';

/**
 * The pickable part of a server's Cleanup section: filters, one group per kind with a select-all,
 * a row per unused item, and the bar that appears once something is picked.
 */

export const KIND_META: Record<
  CleanupKind,
  { label: string; one: string; icon: React.ComponentType<{ className?: string }> }
> = {
  image: { label: 'Images', one: 'image', icon: Package },
  container: { label: 'Containers', one: 'container', icon: Docker },
  volume: { label: 'Volumes', one: 'volume', icon: HardDrive },
  network: { label: 'Networks', one: 'network', icon: NetworkIcon },
};

export function CleanupToolbar({
  filter,
  counts,
  onChange,
}: {
  filter: CleanupFilter;
  counts: Record<CleanupKind | 'all', number>;
  onChange: (next: CleanupFilter) => void;
}): React.JSX.Element {
  return (
    <div className={cn(GLASS_CARD, 'flex flex-wrap items-center gap-2 px-2.5 py-2')}>
      <PillTabs
        id="cleanup-kinds"
        label="Kind"
        kind="toggle"
        value={filter.kind}
        onChange={(kind) => onChange({ ...filter, kind })}
        items={[
          { value: 'all', label: 'All', count: counts.all },
          ...CLEANUP_KINDS.map((kind) => ({
            value: kind,
            label: KIND_META[kind].label,
            count: counts[kind],
          })),
        ]}
      />
      <PillTabs
        id="cleanup-age"
        label="Age"
        kind="toggle"
        size="xs"
        value={filter.age}
        onChange={(age: AgeFilter) => onChange({ ...filter, age })}
        items={AGE_FILTERS.map(({ value, label }) => ({ value, label }))}
      />
      <SearchPill
        type="search"
        value={filter.query}
        onValueChange={(query) => onChange({ ...filter, query })}
        label="Filter unused items"
        clearLabel="Clear filter"
        placeholder="Filter by name or project"
        className="ml-auto h-8 min-w-44 max-w-xs flex-1"
      />
    </div>
  );
}

export type RowState = { state: 'removing' } | { state: 'failed'; message: string };

function rowFacts(item: CleanupItem): string {
  return [
    item.kind === 'container' ? item.detail : null,
    item.createdAtUnixMs !== undefined && item.kind !== 'container'
      ? `made ${ago(item.createdAtUnixMs)}`
      : null,
    item.kind === 'image' ? item.detail : null,
    item.kind === 'network' ? item.detail : null,
    item.project ? `project ${item.project}` : null,
  ]
    .filter(Boolean)
    .join(' · ');
}

function CleanupRow({
  item,
  checked,
  allowed,
  deniedReason,
  busy,
  status,
  onToggle,
}: {
  item: CleanupItem;
  checked: boolean;
  allowed: boolean;
  deniedReason: string;
  busy: boolean;
  status: RowState | undefined;
  onToggle: (on: boolean) => void;
}): React.JSX.Element {
  const Icon = KIND_META[item.kind].icon;
  const box = (
    <Checkbox
      aria-label={`Select ${item.name}`}
      checked={checked}
      disabled={!allowed || busy}
      onCheckedChange={(next) => onToggle(next === true)}
    />
  );
  return (
    <li
      className={cn(
        'transition-colors hover:bg-foreground/[0.03]',
        checked && 'bg-primary/[0.04]',
        status?.state === 'removing' && 'opacity-60',
      )}
    >
      <label className="flex cursor-pointer items-center gap-3 px-3.5 py-2.5">
        {status?.state === 'removing' ? (
          <Spinner
            className="h-[18px] w-[18px] p-0.5 text-primary motion-safe:animate-spin"
            aria-label={`Removing ${item.name}`}
          />
        ) : allowed ? (
          box
        ) : (
          <SimpleTooltip label={deniedReason} wrapTrigger>
            {box}
          </SimpleTooltip>
        )}
        <Icon className="h-4 w-4 shrink-0 text-muted-foreground" />
        <div className="min-w-0 flex-1">
          <p className="flex min-w-0 items-center gap-2 text-xs text-foreground">
            <span className="truncate font-mono">{item.name}</span>
            {item.dangling && (
              <Chip tone="warning" className="h-4 px-1.5 text-[10px]">
                Untagged
              </Chip>
            )}
          </p>
          <p className="truncate text-xs text-muted-foreground">{rowFacts(item)}</p>
          {status?.state === 'failed' && (
            <p className="text-xs text-destructive">{status.message}</p>
          )}
        </div>
        {item.sizeBytes !== undefined && (
          <span className="shrink-0 text-xs tabular-nums text-muted-foreground">
            {formatBytes(item.sizeBytes)}
          </span>
        )}
      </label>
    </li>
  );
}

export function CleanupGroup({
  kind,
  items,
  selected,
  allowed,
  busy,
  statuses,
  onToggle,
}: {
  kind: CleanupKind;
  items: CleanupItem[];
  selected: ReadonlySet<string>;
  allowed: boolean;
  busy: boolean;
  statuses: ReadonlyMap<string, RowState>;
  onToggle: (keys: string[], on: boolean) => void;
}): React.JSX.Element | null {
  if (items.length === 0) return null;
  const meta = KIND_META[kind];
  const ticked = items.filter((item) => selected.has(item.key)).length;
  const all = ticked === items.length;
  const bytes = items.reduce((sum, item) => sum + (item.sizeBytes ?? 0), 0);
  const deniedReason =
    kind === 'volume'
      ? 'Removing volumes is for Admins.'
      : `Removing ${meta.label.toLowerCase()} needs an Operator.`;
  return (
    <section aria-label={meta.label} className={cn(GLASS_CARD, 'settings-rows overflow-hidden')}>
      <div className="flex items-center gap-3 px-3.5 py-2">
        <Checkbox
          aria-label={`Select all ${meta.label.toLowerCase()}`}
          checked={all ? true : ticked > 0 ? 'indeterminate' : false}
          disabled={!allowed || busy}
          onCheckedChange={() =>
            onToggle(
              items.map((item) => item.key),
              !all,
            )
          }
        />
        <p className={cn(SECTION_HEADING, 'flex-1')}>
          {meta.label} <span className="tabular-nums">({items.length})</span>
        </p>
        {bytes > 0 && (
          <span className="text-xs tabular-nums text-muted-foreground">{formatBytes(bytes)}</span>
        )}
      </div>
      <ul>
        {items.map((item) => (
          <CleanupRow
            key={item.key}
            item={item}
            checked={selected.has(item.key)}
            allowed={allowed}
            deniedReason={deniedReason}
            busy={busy}
            status={statuses.get(item.key)}
            onToggle={(on) => onToggle([item.key], on)}
          />
        ))}
      </ul>
    </section>
  );
}

export function SelectionBar({
  summary,
  progress,
  onClear,
  onRemove,
}: {
  summary: SelectionSummary;
  progress: { done: number; total: number } | null;
  onClear: () => void;
  onRemove: () => void;
}): React.JSX.Element {
  return (
    <div
      role="region"
      aria-label="Selection"
      className={cn(
        GLASS_CARD,
        'sticky bottom-2 z-10 flex flex-wrap items-center gap-2 px-3.5 py-2.5 shadow-lg animate-in fade-in slide-in-from-bottom-2 duration-200',
      )}
    >
      <p className="min-w-0 flex-1 text-sm" aria-live="polite">
        {progress ? (
          <span className="flex items-center gap-2">
            <Spinner className="h-3.5 w-3.5 text-primary motion-safe:animate-spin" />
            Removing {Math.min(progress.done + 1, progress.total)} of {progress.total}…
          </span>
        ) : (
          <>
            <span className="font-medium tabular-nums">{summary.count} selected</span>
            {summary.bytes > 0 && (
              <span className="text-muted-foreground">
                {' '}
                · frees about {formatBytes(summary.bytes)}
              </span>
            )}
          </>
        )}
      </p>
      <Button size="sm" variant="ghost" disabled={progress !== null} onClick={onClear}>
        Clear selection
      </Button>
      <Button size="sm" variant="danger" disabled={progress !== null} onClick={onRemove}>
        <Trash2 className="h-3.5 w-3.5" />
        Remove selected
      </Button>
    </div>
  );
}
