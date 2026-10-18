import type { FilesChangesSnapshot, FilesPendingFile } from '@shared/deployFilesTypes';
import { memo, useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, Folder, Lock } from '@/components/icons';
import { Chip, FilterChip, NoMatches, SearchPill } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import { cn } from '@/lib/utils';
import {
  type ChangeFilter,
  type FolderGroup,
  filterCounts,
  filterFiles,
  groupByFolder,
  limitGroups,
  selectionState,
} from './changesTree';
import { LEFT_OUT_REASON, plural } from './copy';
import { ChangeChip } from './parts';
import { SelectBox } from './SelectBox';

/**
 * The live list of what changed in the deploy folder since the last deploy (E23): grouped by
 * folder, filtered by kind or a search, each file ticked to go or left for later, and the files
 * that are never sent with the reason for each.
 */

/** Rows drawn at once; the rest wait behind "Show more", a page at a time. */
export const ROW_PAGE = 500;

const FILTERS: { value: ChangeFilter; label: string }[] = [
  { value: 'all', label: 'All' },
  { value: 'added', label: 'Added' },
  { value: 'modified', label: 'Modified' },
  { value: 'deleted', label: 'Deleted' },
  { value: 'leftOut', label: 'Left out' },
];

const ROOT_LABEL = 'Top folder';

export interface ChangesListProps {
  snapshot: FilesChangesSnapshot;
  /** Paths the user unticked. New files are ticked until someone unticks them. */
  deselected: ReadonlySet<string>;
  onDeselectedChange: (deselected: Set<string>) => void;
  /** While a deploy runs, the ticks stay as they are. */
  disabled?: boolean;
}

/**
 * Drawn again only when its own props change: a running deploy sends progress about ten times a
 * second, and the list (up to a page of rows) has nothing to show for it.
 */
export const ChangesList = memo(function ChangesList({
  snapshot,
  deselected,
  onDeselectedChange,
  disabled = false,
}: ChangesListProps): React.JSX.Element {
  const [filter, setFilter] = useState<ChangeFilter>('all');
  const [query, setQuery] = useState('');
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  const [limit, setLimit] = useState(ROW_PAGE);

  const counts = filterCounts(snapshot);
  const shown = useMemo(
    () => filterFiles(snapshot.files, filter, query),
    [snapshot.files, filter, query],
  );
  const groups = useMemo(() => groupByFolder(shown), [shown]);
  const visible = useMemo(
    () =>
      limitGroups(
        groups.map((group) => (collapsed.has(group.folder) ? { ...group, files: [] } : group)),
        limit,
      ),
    [groups, collapsed, limit],
  );
  const visibleByFolder = useMemo(
    () => new Map(visible.groups.map((group) => [group.folder, group])),
    [visible.groups],
  );
  const ticked = snapshot.files.filter((file) => !deselected.has(file.path)).length;

  function setTicked(files: readonly FilesPendingFile[], on: boolean): void {
    const next = new Set(deselected);
    for (const file of files) {
      if (on) next.delete(file.path);
      else next.add(file.path);
    }
    onDeselectedChange(next);
  }

  function toggleFolder(folder: string): void {
    setCollapsed((current) => {
      const next = new Set(current);
      if (next.has(folder)) next.delete(folder);
      else next.add(folder);
      return next;
    });
  }

  return (
    <section aria-label="Pending changes" className="space-y-2.5">
      <div className="flex flex-wrap items-center gap-2">
        <SearchPill
          type="search"
          value={query}
          onValueChange={(value) => {
            setQuery(value);
            setLimit(ROW_PAGE);
          }}
          label="Search the changes"
          clearLabel="Clear filter"
          placeholder="Search paths"
          className="w-full sm:w-56"
        />
        <div role="group" aria-label="Show" className="flex flex-wrap items-center gap-1.5">
          {FILTERS.map((item) => (
            <FilterChip
              key={item.value}
              active={filter === item.value}
              onClick={() => {
                setFilter(item.value);
                setLimit(ROW_PAGE);
              }}
              className="h-6 px-2.5 text-[11px]"
            >
              {item.label} <span className="tabular-nums opacity-70">{counts[item.value]}</span>
            </FilterChip>
          ))}
        </div>
      </div>

      {filter === 'leftOut' ? (
        <LeftOutList snapshot={snapshot} />
      ) : shown.length === 0 ? (
        query.trim() ? (
          <NoMatches query={query} />
        ) : (
          <p className="px-1 py-6 text-center text-xs text-muted-foreground">
            No {filter === 'all' ? '' : `${filter} `}files.
          </p>
        )
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-x-1 gap-y-1 px-1">
            <span className="mr-auto text-[11px] tabular-nums text-muted-foreground">
              {ticked} of {plural(snapshot.files.length, 'file')} ticked
            </span>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => setTicked(shown, true)}
            >
              Select all
            </Button>
            <Button
              size="xs"
              variant="ghost"
              disabled={disabled}
              onClick={() => setTicked(shown, false)}
            >
              Select none
            </Button>
          </div>
          <ul
            aria-label="Changed files"
            className="overflow-hidden rounded-xl bg-foreground/[0.03] ring-1 ring-inset ring-foreground/[0.07]"
          >
            {groups.map((group) => {
              const rows = visibleByFolder.get(group.folder);
              if (!rows && !collapsed.has(group.folder)) return null;
              return (
                <FolderRows
                  key={group.folder}
                  group={group}
                  rows={rows?.files ?? []}
                  collapsed={collapsed.has(group.folder)}
                  onToggle={() => toggleFolder(group.folder)}
                  deselected={deselected}
                  onTick={setTicked}
                  disabled={disabled}
                />
              );
            })}
          </ul>
          {visible.hidden > 0 && (
            <Button
              size="sm"
              variant="soft"
              className="w-full"
              onClick={() => setLimit((current) => current + ROW_PAGE)}
            >
              Show {Math.min(visible.hidden, ROW_PAGE)} more
            </Button>
          )}
        </>
      )}
    </section>
  );
});

function FolderRows({
  group,
  rows,
  collapsed,
  onToggle,
  deselected,
  onTick,
  disabled,
}: {
  group: FolderGroup;
  rows: FilesPendingFile[];
  collapsed: boolean;
  onToggle: () => void;
  deselected: ReadonlySet<string>;
  onTick: (files: readonly FilesPendingFile[], on: boolean) => void;
  disabled: boolean;
}): React.JSX.Element {
  const name = group.folder || ROOT_LABEL;
  const state = selectionState(group.files, deselected);
  const Chevron = collapsed ? ChevronRight : ChevronDown;
  return (
    <li className="[&+li]:shadow-[inset_0_1px_0_hsl(var(--foreground)/0.07)]">
      <div className="flex items-center gap-2 bg-foreground/[0.025] py-1.5 pl-1.5 pr-3">
        <button
          type="button"
          aria-expanded={!collapsed}
          aria-label={`${collapsed ? 'Expand' : 'Collapse'} ${name}`}
          onClick={onToggle}
          className="flex h-6 w-6 shrink-0 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-foreground/[0.07] hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Chevron className="h-3 w-3" />
        </button>
        <SelectBox
          checked={state}
          disabled={disabled}
          aria-label={`Include everything in ${name}`}
          onCheckedChange={() => onTick(group.files, state !== true)}
        />
        <Folder className="h-3 w-3 shrink-0 text-muted-foreground/70" />
        <span
          className={cn(
            'min-w-0 flex-1 truncate text-xs font-medium',
            group.folder ? 'font-mono' : 'text-muted-foreground',
          )}
        >
          {name}
        </span>
        <span className="shrink-0 text-[10px] tabular-nums text-muted-foreground">
          {group.files.length}
        </span>
      </div>
      {!collapsed && rows.length > 0 && (
        <ul aria-label={`Files in ${name}`}>
          {rows.map((file) => (
            <FileRow
              key={file.path}
              file={file}
              ticked={!deselected.has(file.path)}
              onTick={(on) => onTick([file], on)}
              disabled={disabled}
            />
          ))}
        </ul>
      )}
    </li>
  );
}

function FileRow({
  file,
  ticked,
  onTick,
  disabled,
}: {
  file: FilesPendingFile;
  ticked: boolean;
  onTick: (on: boolean) => void;
  disabled: boolean;
}): React.JSX.Element {
  const deleted = file.change === 'deleted';
  return (
    <li>
      <label
        className={cn(
          'flex cursor-pointer items-center gap-2.5 py-1.5 pl-9 pr-3 transition-colors hover:bg-foreground/[0.04]',
          !ticked && 'opacity-60',
          disabled && 'cursor-default',
        )}
      >
        <SelectBox
          checked={ticked}
          disabled={disabled}
          aria-label={`Include ${file.path}`}
          onCheckedChange={(checked) => onTick(checked === true)}
        />
        <ChangeChip change={file.change} />
        <span
          className={cn(
            'min-w-0 flex-1 truncate font-mono text-xs',
            deleted && 'text-muted-foreground line-through decoration-destructive/60',
          )}
        >
          {file.path}
        </span>
        <span className="shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {formatBytes(file.size)}
        </span>
      </label>
    </li>
  );
}

function LeftOutList({ snapshot }: { snapshot: FilesChangesSnapshot }): React.JSX.Element {
  return (
    <div className="space-y-2">
      <div className="flex items-start gap-2 rounded-xl bg-success/[0.07] px-3 py-2 text-xs ring-1 ring-inset ring-success/20">
        <Lock className="mt-px h-3.5 w-3.5 shrink-0 text-success" />
        <p className="text-foreground/90">
          These stay on this computer. Agent settings, secrets and version control are never sent,
          whatever the ignore lines say.
        </p>
      </div>
      {snapshot.leftOut.length === 0 ? (
        <p className="px-1 py-4 text-center text-xs text-muted-foreground">
          Nothing in the deploy folder is left out.
        </p>
      ) : (
        <ul
          aria-label="Left out"
          className="settings-rows overflow-hidden rounded-xl bg-foreground/[0.03] px-3 ring-1 ring-inset ring-foreground/[0.07]"
        >
          {snapshot.leftOut.map((entry) => {
            const reason = LEFT_OUT_REASON[entry.reason];
            return (
              <li key={entry.path} className="flex items-center gap-2.5 py-1.5">
                <SimpleTooltip label={reason.detail} className="max-w-xs">
                  <Chip
                    tabIndex={0}
                    className="w-[5.5rem] cursor-help justify-center outline-none focus-visible:ring-2 focus-visible:ring-ring"
                  >
                    {reason.label}
                  </Chip>
                </SimpleTooltip>
                <span className="min-w-0 flex-1 truncate font-mono text-xs">{entry.path}</span>
              </li>
            );
          })}
        </ul>
      )}
      {snapshot.leftOutTruncated && (
        <p className="px-1 text-[11px] text-muted-foreground">
          More files were left out than are listed here.
        </p>
      )}
    </div>
  );
}
