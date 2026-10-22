import { useCallback, useId, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { toast } from 'sonner';
import { ArrowDown, ArrowUp, FolderOpen, Monitor, Server } from '@/components/icons';
import { EmptyState, NoMatches, Notice, Problem, SECTION_HEADING } from '@/components/pageKit';
import { Button } from '@/components/ui/button';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { useVirtualRows } from '@/hooks/useVirtualRows';
import { limitationOf, refusalFor } from '@/lib/sftp/capabilities';
import { dragKind, readDragPayload, writeDragPayload } from '@/lib/sftp/dnd';
import {
  isRemoteEntry,
  type PaneEntry,
  type SortKey,
  selectionSummary,
  visibleEntries,
} from '@/lib/sftp/entries';
import { remoteDepth, samePath } from '@/lib/sftp/paths';
import {
  clickSelect,
  EMPTY_SELECTION,
  moveFocus,
  type Selection,
  selectAll,
} from '@/lib/sftp/selection';
import { cn } from '@/lib/utils';
import { confirmDialog } from '@/stores/confirmStore';
import { type PaneSide, type PaneState, serverFiles, useSftpStore } from '@/stores/sftpStore';
import { COLUMN, COMPACT_ROW_HEIGHT, FileRow, NAME_FIELD, PANE_CARD, ROW_HEIGHT } from './FileRow';
import { PaneContextMenu, type PaneRefusals } from './PaneContextMenu';
import { PaneToolbar } from './PaneToolbar';
import { PathBar } from './PathBar';

/** How many names a delete question lists before it says "and N more". */
const DELETE_LIST_MAX = 10;

export interface FilePaneProps {
  serverId: string;
  side: PaneSide;
  /** Controls at the end of the title row (the remote pane's Disconnect). */
  actions?: React.ReactNode;
  /** The docked pane: shorter rows and footer, no Permissions or Owner column. */
  compact?: boolean;
  className?: string;
  style?: React.CSSProperties;
}

/** The list's placeholder while the first listing of a folder is on its way. */
export function PaneSkeleton({
  label = 'Loading the folder',
}: {
  label?: string;
}): React.JSX.Element {
  return (
    <div role="status" aria-label={label} className="flex flex-col gap-px px-1.5 py-1.5">
      {Array.from({ length: 8 }, (_, index) => (
        <div key={index} className="flex items-center gap-3 px-2.5" style={{ height: ROW_HEIGHT }}>
          <Skeleton className="h-3.5 w-3.5 rounded" />
          <Skeleton className="h-3 flex-1" style={{ maxWidth: `${68 - index * 6}%` }} />
          <Skeleton className="ml-auto h-2.5 w-10" />
          <Skeleton className="h-2.5 w-16" />
        </div>
      ))}
    </div>
  );
}

function HeaderCell({
  label,
  sortKey,
  sort,
  onSort,
  className,
}: {
  label: string;
  sortKey: SortKey;
  sort: PaneState<PaneEntry>['sort'];
  onSort: (key: SortKey) => void;
  className?: string;
}): React.JSX.Element {
  const active = sort.key === sortKey;
  const Arrow = sort.dir === 'asc' ? ArrowUp : ArrowDown;
  return (
    <div
      role="columnheader"
      aria-sort={active ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}
      className={className}
    >
      <button
        type="button"
        onClick={() => onSort(sortKey)}
        className={cn(
          SECTION_HEADING,
          'inline-flex max-w-full cursor-pointer items-center gap-1 rounded-md outline-none transition-colors hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
          active && 'text-foreground/80',
          className?.includes('text-right') && 'flex-row-reverse',
        )}
      >
        <span className="truncate">{label}</span>
        {active ? <Arrow aria-hidden className="h-2 w-2 shrink-0" /> : null}
      </button>
    </div>
  );
}

function NewFolderRow({
  height,
  onSubmit,
  onCancel,
}: {
  height: number;
  onSubmit: (name: string) => Promise<boolean>;
  onCancel: () => void;
}): React.JSX.Element {
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  // Closing moves focus back to the list, which blurs this field while it is still mounted;
  // the blur must not commit what Escape just threw away (or commit a second time).
  const closed = useRef(false);

  function close(): void {
    closed.current = true;
    onCancel();
  }

  async function commit(): Promise<void> {
    if (busy || closed.current) return;
    if (name.trim() === '') {
      close();
      return;
    }
    setBusy(true);
    const ok = await onSubmit(name);
    setBusy(false);
    if (ok) close();
  }

  return (
    <div role="row" className="mx-1.5 flex items-center gap-2 pl-2.5 pr-2" style={{ height }}>
      <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-2">
        <FolderOpen aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary/80" />
        <input
          autoFocus
          aria-label="New folder name"
          placeholder="Folder name"
          value={name}
          disabled={busy}
          onChange={(event) => setName(event.target.value)}
          onBlur={() => {
            if (!closed.current) void commit();
          }}
          onKeyDown={(event) => {
            event.stopPropagation();
            if (event.key === 'Enter') {
              event.preventDefault();
              void commit();
            } else if (event.key === 'Escape') {
              event.preventDefault();
              close();
            }
          }}
          className={cn(NAME_FIELD, 'max-w-xs')}
        />
      </div>
    </div>
  );
}

/**
 * One side of the file manager, this computer or the server: toolbar, path bar, a sortable,
 * virtualized grid of entries with keyboard, mouse, drag and drop and a context menu, and a
 * footer with what is selected. Both sides are this one component; `side` picks the calls.
 */
export function FilePane({
  serverId,
  side,
  actions,
  compact = false,
  className,
  style,
}: FilePaneProps): React.JSX.Element {
  const rowHeight = compact ? COMPACT_ROW_HEIGHT : ROW_HEIGHT;
  const otherSide: PaneSide = side === 'local' ? 'remote' : 'local';
  // Narrow reads: the queue snapshot (every 100 ms while something moves) must not redraw this.
  const pane = useSftpStore((state) => serverFiles(state, serverId)[side]) as PaneState<PaneEntry>;
  const otherPath = useSftpStore((state) => serverFiles(state, serverId)[otherSide].path);
  const status = useSftpStore((state) => serverFiles(state, serverId).status);
  const session = useSftpStore((state) => serverFiles(state, serverId).session);
  const nickname = useSftpStore((state) => {
    const files = serverFiles(state, serverId);
    return files.session?.nickname ?? files.server?.nickname ?? 'Server';
  });
  const places = useSftpStore((state) => state.places);
  const store = useSftpStore.getState;
  const otherReady = otherPath !== null && (otherSide === 'local' || status === 'ready');
  const remote = side === 'remote';
  // What the server side does not allow (E27); this computer allows everything.
  const refusals = useMemo<PaneRefusals>(
    () =>
      remote
        ? {
            edit: refusalFor(session, 'edit'),
            rename: refusalFor(session, 'rename'),
            remove: refusalFor(session, 'remove'),
          }
        : {},
    [remote, session],
  );
  const limitation = remote ? limitationOf(session) : null;

  const [editingPath, setEditingPath] = useState(false);
  const [creating, setCreating] = useState(false);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [menuEntries, setMenuEntries] = useState<PaneEntry[]>([]);
  const gridRef = useRef<HTMLDivElement | null>(null);
  const idBase = useId();

  const visible = useMemo(
    () =>
      visibleEntries(pane.entries, {
        sort: pane.sort,
        filter: pane.filter,
        showHidden: pane.showHidden,
      }),
    [pane.entries, pane.sort, pane.filter, pane.showHidden],
  );
  const names = useMemo(() => visible.map((entry) => entry.name), [visible]);
  const selectedSet = useMemo(() => new Set(pane.selection.selected), [pane.selection.selected]);
  const selectedEntries = useMemo(
    () => visible.filter((entry) => selectedSet.has(entry.name)),
    [visible, selectedSet],
  );
  const focusIndex = pane.selection.focus ? names.indexOf(pane.selection.focus) : -1;
  const rowId = (index: number) => `${idBase}-row-${index}`;

  const { containerRef, onScroll, start, end, padTop, padBottom, scrollToIndex } = useVirtualRows(
    visible.length,
    rowHeight,
  );
  const bodyRef = useRef<HTMLDivElement | null>(null);
  const setBody = useCallback(
    (box: HTMLDivElement | null) => {
      bodyRef.current = box;
      containerRef(box);
    },
    [containerRef],
  );
  // Another folder starts at its top; a refresh of the same one keeps the place.
  const shownPath = useRef(pane.path);
  useLayoutEffect(() => {
    const before = shownPath.current;
    shownPath.current = pane.path;
    if (before === null || pane.path === null || samePath(before, pane.path)) return;
    if (bodyRef.current) bodyRef.current.scrollTop = 0;
    onScroll();
  }, [pane.path, onScroll]);

  /** The latest selection, read at event time so a handler never acts on a stale one. */
  const currentSelection = (): Selection => serverFiles(store(), serverId)[side].selection;
  const setSelection = (selection: Selection) => store().setSelection(serverId, side, selection);
  const focusGrid = () => gridRef.current?.focus({ preventScroll: true });

  // ---- actions --------------------------------------------------------------------------

  function transfer(entries: PaneEntry[]): void {
    if (entries.length === 0) return;
    if (!otherReady || !otherPath) {
      toast.error(
        remote ? 'Open a folder on this computer first.' : 'Connect to the server first.',
      );
      return;
    }
    void store().transferPaths(
      serverId,
      side,
      entries.map((entry) => entry.path),
      otherPath,
    );
  }

  /** Enter or a double-click: a folder opens, a file goes to the other pane (D15). */
  function openEntry(entry: PaneEntry): void {
    if (entry.isDirectory) {
      void store().navigate(serverId, side, entry.path);
      return;
    }
    if (isRemoteEntry(entry) && (entry.kind === 'link' || entry.kind === 'other')) return;
    transfer([entry]);
  }

  async function deleteEntries(entries: PaneEntry[]): Promise<void> {
    if (entries.length === 0) return;
    const items = entries.slice(0, DELETE_LIST_MAX).map((entry) => ({
      name: entry.name,
      isDirectory: entry.isDirectory,
    }));
    const moreCount =
      entries.length > DELETE_LIST_MAX ? entries.length - DELETE_LIST_MAX : undefined;
    const one = entries.length === 1 ? entries[0] : undefined;
    const paths = entries.map((entry) => entry.path);

    if (remote) {
      // A shallow folder like /var/www holds a whole site; make the user type it out.
      const shallow = entries.some(
        (entry) => entry.isDirectory && !entry.isSymlink && remoteDepth(entry.path) <= 2,
      );
      const confirmed = await confirmDialog({
        title: one
          ? `Delete "${one.name}" from ${nickname}?`
          : `Delete ${entries.length} items from ${nickname}?`,
        description:
          'This deletes them on the server for good, folders with everything inside them. It cannot be undone.',
        items,
        moreCount,
        confirmLabel: 'Delete',
        variant: 'destructive',
        typeToConfirm: shallow ? 'delete' : undefined,
      });
      if (confirmed) await store().removeRemote(serverId, paths);
      return;
    }

    const confirmed = await confirmDialog({
      title: one
        ? `Move "${one.name}" to the Trash?`
        : `Move ${entries.length} items to the Trash?`,
      description: 'You can put them back from the Trash.',
      items,
      moreCount,
      confirmLabel: 'Move to Trash',
      variant: 'destructive',
    });
    if (!confirmed) return;
    const trashed = await store().removeLocal(serverId, paths, { permanent: false });
    if (trashed.ok) return;
    const permanent = await confirmDialog({
      title: "Couldn't move to the Trash",
      description: `${trashed.message} Delete permanently instead? This cannot be undone.`,
      items,
      moreCount,
      confirmLabel: 'Delete permanently',
      variant: 'destructive',
    });
    if (!permanent) return;
    const deleted = await store().removeLocal(serverId, paths, { permanent: true });
    if (!deleted.ok) toast.error(`Could not delete: ${deleted.message}`);
  }

  function copyPaths(paths: string[]): void {
    if (paths.length === 0) return;
    void navigator.clipboard
      .writeText(paths.join('\n'))
      .then(() => toast.success(paths.length > 1 ? 'Copied the paths' : 'Copied the path'))
      .catch(() => toast.error('Could not copy to the clipboard.'));
  }

  function startRename(entry: PaneEntry | undefined): void {
    if (!entry) return;
    setCreating(false);
    setRenaming(entry.name);
  }

  function startNewFolder(): void {
    setRenaming(null);
    setCreating(true);
    // The field sits above the first row; bring it into view.
    scrollToIndex(0);
  }

  // ---- keyboard -------------------------------------------------------------------------

  function move(step: 1 | -1 | 'home' | 'end', extend: boolean): void {
    const next = moveFocus(currentSelection(), names, step, { extend });
    if (next.focus) scrollToIndex(names.indexOf(next.focus));
    setSelection(next);
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.target !== event.currentTarget) return;
    const mod = event.ctrlKey || event.metaKey;
    const key = event.key;
    const focused = pane.selection.focus
      ? visible.find((entry) => entry.name === pane.selection.focus)
      : undefined;
    let handled = true;
    if (mod && key.toLowerCase() === 'a') {
      setSelection(selectAll(currentSelection(), names));
    } else if (mod && key.toLowerCase() === 'l') {
      setEditingPath(true);
    } else if ((event.altKey && key === 'ArrowUp') || key === 'Backspace') {
      void store().up(serverId, side);
    } else if (key === 'ArrowDown') move(1, event.shiftKey);
    else if (key === 'ArrowUp') move(-1, event.shiftKey);
    else if (key === 'Home') move('home', event.shiftKey);
    else if (key === 'End') move('end', event.shiftKey);
    else if (key === 'Enter') {
      if (focused) openEntry(focused);
    } else if (key === 'F2') {
      if (refusals.rename && focused) toast.info(refusals.rename);
      else startRename(focused);
    } else if (key === 'Delete') {
      if (refusals.remove && selectedEntries.length > 0) toast.info(refusals.remove);
      else void deleteEntries(selectedEntries);
    }
    else if (key === 'F5') void store().refresh(serverId, side);
    else if (key === 'Escape') setSelection(EMPTY_SELECTION);
    else if (key === 'Tab') {
      // Tab and Shift+Tab jump straight to the other pane's list, from either side.
      const other = document.querySelector<HTMLElement>(`[data-sftp-grid="${otherSide}"]`);
      if (other) other.focus();
      else handled = false;
    } else handled = false;
    if (handled) event.preventDefault();
  }

  // ---- drag and drop --------------------------------------------------------------------

  /** Rows from the other pane, or OS files onto the server's pane. */
  function accepts(data: DataTransfer): boolean {
    if (pane.path === null) return false;
    const kind = dragKind(data);
    if (!kind) return false;
    if (kind.type === 'files') return remote && status === 'ready';
    return kind.side !== side;
  }

  function drop(data: DataTransfer, dir: string): void {
    setDropTarget(null);
    const kind = dragKind(data);
    if (!kind) return;
    if (kind.type === 'rows') {
      const payload = readDragPayload(data);
      if (!payload || payload.side === side || payload.serverId !== serverId) return;
      void store().transferPaths(serverId, payload.side, payload.paths, dir);
      return;
    }
    if (!remote) return;
    const paths = Array.from(data.files)
      .map((file) => window.agentmat.shell.pathForFile(file))
      .filter((path): path is string => typeof path === 'string' && path.length > 0);
    if (paths.length > 0) void store().transferPaths(serverId, 'local', paths, dir);
  }

  const paneDrop = {
    onDragOver: (event: React.DragEvent) => {
      if (!accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      if (dropTarget !== '') setDropTarget('');
    },
    onDragLeave: (event: React.DragEvent) => {
      const next = event.relatedTarget as Node | null;
      if (next && event.currentTarget.contains(next)) return;
      setDropTarget(null);
    },
    onDrop: (event: React.DragEvent) => {
      if (!accepts(event.dataTransfer) || pane.path === null) {
        setDropTarget(null);
        return;
      }
      event.preventDefault();
      drop(event.dataTransfer, pane.path);
    },
  };

  // ---- rows -----------------------------------------------------------------------------

  // The rows are memoized, so they get handlers that never change and call the latest ones.
  const handlers = {
    onRowClick: (event: React.MouseEvent, entry: PaneEntry) => {
      focusGrid();
      setSelection(
        clickSelect(currentSelection(), names, entry.name, {
          toggle: event.ctrlKey || event.metaKey,
          range: event.shiftKey,
        }),
      );
    },
    onRowDoubleClick: (entry: PaneEntry) => {
      if (renaming === entry.name) return;
      openEntry(entry);
    },
    onRowContextMenu: (entry: PaneEntry) => {
      if (selectedSet.has(entry.name)) {
        setMenuEntries(selectedEntries);
        return;
      }
      setSelection({ selected: [entry.name], focus: entry.name, anchor: entry.name });
      setMenuEntries([entry]);
    },
    onRowDragStart: (event: React.DragEvent, entry: PaneEntry) => {
      const dragged = selectedSet.has(entry.name) ? selectedEntries : [entry];
      if (!selectedSet.has(entry.name)) {
        setSelection({ selected: [entry.name], focus: entry.name, anchor: entry.name });
      }
      writeDragPayload(event.dataTransfer, {
        serverId,
        side,
        paths: dragged.map((one) => one.path),
      });
    },
    onRowDragOver: (event: React.DragEvent, entry: PaneEntry) => {
      if (!entry.isDirectory || !accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      event.dataTransfer.dropEffect = 'copy';
      if (dropTarget !== entry.name) setDropTarget(entry.name);
    },
    onRowDrop: (event: React.DragEvent, entry: PaneEntry) => {
      if (!entry.isDirectory || !accepts(event.dataTransfer)) return;
      event.preventDefault();
      event.stopPropagation();
      drop(event.dataTransfer, entry.path);
    },
    onRenameSubmit: (entry: PaneEntry, name: string) =>
      store().rename(serverId, side, entry.path, name),
    onRenameCancel: () => {
      setRenaming(null);
      focusGrid();
    },
  };
  const latest = useRef(handlers);
  latest.current = handlers;
  const rowHandlers = useMemo(
    () => ({
      onRowClick: (event: React.MouseEvent, entry: PaneEntry) =>
        latest.current.onRowClick(event, entry),
      onRowDoubleClick: (entry: PaneEntry) => latest.current.onRowDoubleClick(entry),
      onRowContextMenu: (entry: PaneEntry) => latest.current.onRowContextMenu(entry),
      onRowDragStart: (event: React.DragEvent, entry: PaneEntry) =>
        latest.current.onRowDragStart(event, entry),
      onRowDragOver: (event: React.DragEvent, entry: PaneEntry) =>
        latest.current.onRowDragOver(event, entry),
      onRowDrop: (event: React.DragEvent, entry: PaneEntry) =>
        latest.current.onRowDrop(event, entry),
      onRenameSubmit: (entry: PaneEntry, name: string) =>
        latest.current.onRenameSubmit(entry, name),
      onRenameCancel: () => latest.current.onRenameCancel(),
    }),
    [],
  );

  // ---- render ---------------------------------------------------------------------------

  const hasListing = pane.path !== null;
  const heading = remote ? (
    <>
      <Server aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
      <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">{nickname}</h2>
    </>
  ) : (
    <>
      <Monitor aria-hidden className="h-3.5 w-3.5 shrink-0 text-primary" />
      <h2 className="min-w-0 truncate text-[13px] font-semibold tracking-tight">This computer</h2>
    </>
  );
  const gridLabel = remote ? `Files on ${nickname}` : 'Files on this computer';
  const menuPaths =
    menuEntries.length > 0 ? menuEntries.map((entry) => entry.path) : pane.path ? [pane.path] : [];

  let body: React.ReactNode;
  if (!hasListing && pane.error) {
    body = (
      <div className="p-2.5">
        <Problem message={pane.error} onRetry={() => void store().retryListing(serverId, side)} />
      </div>
    );
  } else if (!hasListing) {
    body = <PaneSkeleton />;
  } else {
    const empty =
      visible.length === 0 && !creating ? (
        pane.entries.length === 0 ? (
          <EmptyState
            size="sm"
            icon={FolderOpen}
            title="This folder is empty"
            description={remote ? 'Drop files here to upload them.' : undefined}
          />
        ) : pane.filter.trim() ? (
          <NoMatches query={pane.filter} />
        ) : (
          <EmptyState
            size="sm"
            icon={FolderOpen}
            title="Only hidden files here"
            action={
              <Button size="sm" variant="soft" onClick={() => store().toggleHidden(serverId, side)}>
                Show hidden files
              </Button>
            }
          />
        )
      ) : null;

    body = (
      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={gridRef}
            role="grid"
            tabIndex={0}
            data-sftp-grid={side}
            aria-label={gridLabel}
            aria-multiselectable
            aria-rowcount={visible.length + 1}
            // Only a drawn row can be named; a row scrolled out of the window is not in the DOM.
            aria-activedescendant={
              focusIndex >= start && focusIndex < end ? rowId(focusIndex) : undefined
            }
            aria-busy={pane.loading || undefined}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => {
              if ((event.target as HTMLElement).closest('[data-sftp-row]')) return;
              setSelection(EMPTY_SELECTION);
              setMenuEntries([]);
            }}
            className="group/grid flex min-h-0 flex-1 flex-col outline-none"
          >
            <div role="rowgroup" className="shrink-0">
              <div
                role="row"
                aria-rowindex={1}
                className={cn(
                  'mx-1.5 flex items-center gap-3 pb-1 pl-2.5 pr-2',
                  compact ? 'pt-1' : 'pt-2',
                )}
              >
                <HeaderCell
                  label="Name"
                  sortKey="name"
                  sort={pane.sort}
                  onSort={(key) => store().sortBy(serverId, side, key)}
                  className="min-w-0 flex-1 pl-6"
                />
                <HeaderCell
                  label="Size"
                  sortKey="size"
                  sort={pane.sort}
                  onSort={(key) => store().sortBy(serverId, side, key)}
                  className={cn(COLUMN.size, 'flex justify-end')}
                />
                <HeaderCell
                  label="Modified"
                  sortKey="mtime"
                  sort={pane.sort}
                  onSort={(key) => store().sortBy(serverId, side, key)}
                  className={COLUMN.mtime}
                />
                {remote && !compact ? (
                  <>
                    <HeaderCell
                      label="Permissions"
                      sortKey="mode"
                      sort={pane.sort}
                      onSort={(key) => store().sortBy(serverId, side, key)}
                      className={COLUMN.mode}
                    />
                    <HeaderCell
                      label="Owner"
                      sortKey="owner"
                      sort={pane.sort}
                      onSort={(key) => store().sortBy(serverId, side, key)}
                      className={COLUMN.owner}
                    />
                  </>
                ) : null}
              </div>
            </div>
            <div
              role="rowgroup"
              ref={setBody}
              onScroll={onScroll}
              onClick={(event) => {
                // Rows (and the new folder field) handle their own clicks.
                if ((event.target as HTMLElement).closest('[role="row"]')) return;
                focusGrid();
                setSelection(EMPTY_SELECTION);
              }}
              className="rail-scroll min-h-0 flex-1 overflow-y-auto pb-1.5"
            >
              {creating ? (
                <NewFolderRow
                  height={rowHeight}
                  onSubmit={(name) => store().mkdir(serverId, side, name)}
                  onCancel={() => {
                    setCreating(false);
                    focusGrid();
                  }}
                />
              ) : null}
              {padTop > 0 ? <div aria-hidden style={{ height: padTop }} /> : null}
              {visible.slice(start, end).map((entry, offset) => {
                const index = start + offset;
                return (
                  <FileRow
                    key={entry.name}
                    entry={entry}
                    id={rowId(index)}
                    index={index}
                    remote={remote}
                    selected={selectedSet.has(entry.name)}
                    focused={index === focusIndex}
                    dropTarget={dropTarget === entry.name}
                    renaming={renaming === entry.name}
                    compact={compact}
                    {...rowHandlers}
                  />
                );
              })}
              {padBottom > 0 ? <div aria-hidden style={{ height: padBottom }} /> : null}
              {empty}
            </div>
          </div>
        </ContextMenuTrigger>
        <PaneContextMenu
          side={side}
          entries={menuEntries}
          canTransfer={otherReady}
          refusals={refusals}
          onTransfer={() => transfer(menuEntries)}
          onEdit={(entry) => void store().openEditor(serverId, entry.path)}
          onRename={startRename}
          onDelete={() => void deleteEntries(menuEntries)}
          onNewFolder={startNewFolder}
          onProperties={() => store().openProperties(serverId, menuPaths)}
          onCopyPath={() => copyPaths(menuPaths)}
          onRefresh={() => void store().refresh(serverId, side)}
        />
      </ContextMenu>
    );
  }

  return (
    <section
      aria-label={remote ? `Server ${nickname}` : 'This computer'}
      data-drop-target={dropTarget === '' ? 'pane' : undefined}
      data-compact={compact || undefined}
      style={style}
      className={cn(
        PANE_CARD,
        'transition-shadow motion-reduce:transition-none',
        dropTarget === '' && 'ring-2 ring-inset ring-primary/60',
        className,
      )}
      {...paneDrop}
    >
      <PaneToolbar
        side={side}
        compact={compact}
        heading={heading}
        actions={actions}
        canGoUp={pane.parent !== null && hasListing}
        loading={pane.loading}
        onUp={() => void store().up(serverId, side)}
        onHome={() => void store().home(serverId, side)}
        onRefresh={() => void store().refresh(serverId, side)}
        onNewFolder={() => {
          if (hasListing) startNewFolder();
        }}
        transferDisabled={selectedEntries.length === 0 || !otherReady}
        onTransfer={() => transfer(selectedEntries)}
        showHidden={pane.showHidden}
        onToggleHidden={() => store().toggleHidden(serverId, side)}
        filter={pane.filter}
        onFilterChange={(value) => store().setFilter(serverId, side, value)}
        places={side === 'local' ? places : null}
        onPlace={(place) => void store().navigate(serverId, side, place.path)}
      >
        <PathBar
          side={side}
          path={pane.path}
          editing={editingPath}
          onEditingChange={(editing) => {
            setEditingPath(editing);
            if (!editing) focusGrid();
          }}
          onNavigate={(path) => void store().navigate(serverId, side, path)}
          onSubmit={(text) => store().goTo(serverId, side, text)}
        />
      </PaneToolbar>
      {limitation ? (
        <div className="px-2.5 pt-2">
          <Notice role="note" size="sm">
            {limitation}
          </Notice>
        </div>
      ) : null}
      {hasListing && pane.partial ? (
        <div className="px-2.5 pt-2">
          <Notice role="status" tone="warning" size="sm">
            Only part of this folder is listed, because it is too large to read in full without a
            shell. Start the container, or open a folder further down.
          </Notice>
        </div>
      ) : null}
      {hasListing && pane.error ? (
        <div className="px-2.5 pt-2">
          <Problem message={pane.error} onRetry={() => void store().retryListing(serverId, side)} />
        </div>
      ) : null}
      {body}
      <div
        aria-live="polite"
        className={cn(
          'flex shrink-0 items-center px-3.5 text-[11px] tabular-nums text-muted-foreground shadow-[inset_0_1px_0_hsl(var(--foreground)/0.08)]',
          compact ? 'h-6' : 'h-7',
        )}
      >
        {hasListing ? selectionSummary(visible, selectedSet) : ''}
      </div>
    </section>
  );
}
