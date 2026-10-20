import type { SftpRemoteEntry } from '@shared/sftpTypes';
import { memo, useRef, useState } from 'react';
import { File, Folder, Link, LinkOff } from '@/components/icons';
import { SimpleTooltip } from '@/components/ui/tooltip';
import { formatBytes } from '@/lib/format';
import {
  entryModeKind,
  formatFullDate,
  formatShortDate,
  isRemoteEntry,
  type PaneEntry,
} from '@/lib/sftp/entries';
import { formatMode, formatOctal } from '@/lib/sftp/mode';
import { cn } from '@/lib/utils';

/** One pane of the file manager: the app's glass card, as the Remote files page draws it. */
export const PANE_CARD =
  'glass @container/pane flex min-h-0 flex-col overflow-hidden rounded-[calc(var(--radius)+2px)]';

/** The inline name field (new folder, rename), drawn with the shared field surface. */
export const NAME_FIELD =
  'field-surface h-6 w-full min-w-0 rounded-full px-2.5 text-[13px] outline-none';

/** Every row is this tall, so the list can be drawn a screenful at a time. */
export const ROW_HEIGHT = 28;

/** The columns after the name, shared by the header and the rows so they line up. */
export const COLUMN = {
  size: 'w-20 shrink-0 text-right tabular-nums',
  // On a narrow pane the columns give way, owner first, so the name always has room.
  mtime: 'hidden w-[7.5rem] shrink-0 truncate tabular-nums @min-[400px]/pane:block',
  mode: 'hidden w-[5.75rem] shrink-0 font-mono text-[11px] @min-[480px]/pane:block',
  owner: 'hidden w-20 shrink-0 truncate @min-[640px]/pane:block',
} as const;

export interface FileRowProps {
  entry: PaneEntry;
  /** Unique in the document, for `aria-activedescendant`. */
  id: string;
  index: number;
  remote: boolean;
  selected: boolean;
  /** The keyboard's row. */
  focused: boolean;
  dropTarget: boolean;
  renaming: boolean;
  onRowClick: (event: React.MouseEvent, entry: PaneEntry) => void;
  onRowDoubleClick: (entry: PaneEntry) => void;
  onRowContextMenu: (entry: PaneEntry) => void;
  onRowDragStart: (event: React.DragEvent, entry: PaneEntry) => void;
  onRowDragOver: (event: React.DragEvent, entry: PaneEntry) => void;
  onRowDrop: (event: React.DragEvent, entry: PaneEntry) => void;
  /** Answers true once renamed; false keeps the field open. */
  onRenameSubmit: (entry: PaneEntry, name: string) => Promise<boolean>;
  onRenameCancel: () => void;
}

function RenameField({
  entry,
  onSubmit,
  onCancel,
}: {
  entry: PaneEntry;
  onSubmit: (entry: PaneEntry, name: string) => Promise<boolean>;
  onCancel: () => void;
}): React.JSX.Element {
  const [value, setValue] = useState(entry.name);
  const [busy, setBusy] = useState(false);
  // Closing moves focus back to the list, which blurs this field while it is still mounted;
  // the blur must not commit what Escape just threw away (or rename a second time).
  const closed = useRef(false);

  function close(): void {
    closed.current = true;
    onCancel();
  }

  async function commit(): Promise<void> {
    if (busy || closed.current) return;
    const trimmed = value.trim();
    if (trimmed === '' || trimmed === entry.name) {
      close();
      return;
    }
    setBusy(true);
    const ok = await onSubmit(entry, trimmed);
    setBusy(false);
    if (ok) close();
  }

  return (
    <input
      autoFocus
      aria-label={`New name for ${entry.name}`}
      value={value}
      disabled={busy}
      onChange={(event) => setValue(event.target.value)}
      onFocus={(event) => {
        // Select the name without its extension, the way file managers do.
        const dot = entry.isDirectory ? -1 : entry.name.lastIndexOf('.');
        event.currentTarget.setSelectionRange(0, dot > 0 ? dot : entry.name.length);
      }}
      onBlur={() => {
        if (!closed.current) void commit();
      }}
      onClick={(event) => event.stopPropagation()}
      onDoubleClick={(event) => event.stopPropagation()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === 'Enter') {
          event.preventDefault();
          void commit();
        }
        if (event.key === 'Escape') {
          event.preventDefault();
          close();
        }
      }}
      className={NAME_FIELD}
    />
  );
}

function NameIcon({ entry }: { entry: PaneEntry }): React.JSX.Element {
  const Icon = entry.isDirectory ? Folder : File;
  return (
    <span className="relative flex h-4 w-4 shrink-0 items-center justify-center">
      <Icon
        className={cn(
          'h-3.5 w-3.5',
          entry.isDirectory ? 'text-primary/80' : 'text-muted-foreground',
        )}
      />
    </span>
  );
}

/** One entry of a pane, as a grid row. */
export const FileRow = memo(function FileRow({
  entry,
  id,
  index,
  remote,
  selected,
  focused,
  dropTarget,
  renaming,
  onRowClick,
  onRowDoubleClick,
  onRowContextMenu,
  onRowDragStart,
  onRowDragOver,
  onRowDrop,
  onRenameSubmit,
  onRenameCancel,
}: FileRowProps): React.JSX.Element {
  const remoteEntry = isRemoteEntry(entry) ? (entry as SftpRemoteEntry) : null;
  const broken = remoteEntry?.kind === 'link';
  const full = formatFullDate(entry.mtimeMs);

  const name = <span className={cn('min-w-0 truncate', broken && 'opacity-55')}>{entry.name}</span>;

  return (
    <div
      id={id}
      role="row"
      aria-selected={selected}
      aria-rowindex={index + 2}
      data-sftp-row={entry.name}
      draggable={!renaming}
      onClick={(event) => onRowClick(event, entry)}
      onDoubleClick={() => onRowDoubleClick(entry)}
      onContextMenu={() => onRowContextMenu(entry)}
      onDragStart={(event) => onRowDragStart(event, entry)}
      onDragOver={(event) => onRowDragOver(event, entry)}
      onDrop={(event) => onRowDrop(event, entry)}
      style={{ height: ROW_HEIGHT }}
      className={cn(
        'relative mx-1.5 flex cursor-default select-none items-center gap-3 rounded-lg pl-2.5 pr-2 text-[13px] transition-colors motion-reduce:transition-none',
        selected
          ? 'bg-primary/12 text-primary hover:bg-primary/[0.16]'
          : 'text-foreground/90 hover:bg-foreground/[0.05]',
        focused &&
          'group-focus-visible/grid:ring-1 group-focus-visible/grid:ring-inset group-focus-visible/grid:ring-ring/70',
        dropTarget && 'bg-primary/20 ring-1 ring-inset ring-primary/50',
      )}
    >
      {selected ? (
        <span
          aria-hidden
          className="absolute left-0 top-1/2 h-3.5 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
        />
      ) : null}
      <div role="gridcell" className="flex min-w-0 flex-1 items-center gap-2">
        <NameIcon entry={entry} />
        {renaming ? (
          <RenameField entry={entry} onSubmit={onRenameSubmit} onCancel={onRenameCancel} />
        ) : broken ? (
          <SimpleTooltip label="Broken link">{name}</SimpleTooltip>
        ) : (
          name
        )}
        {entry.isSymlink && !renaming ? (
          broken ? (
            <LinkOff aria-label="Broken link" className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <Link aria-label="Link" className="h-3 w-3 shrink-0 text-muted-foreground" />
          )
        ) : null}
      </div>
      <div role="gridcell" className={cn(COLUMN.size, 'text-[11px] text-muted-foreground')}>
        {entry.isDirectory ? '' : formatBytes(entry.size)}
      </div>
      <div role="gridcell" className={cn(COLUMN.mtime, 'text-[11px] text-muted-foreground')}>
        {full ? (
          <SimpleTooltip label={full}>
            <span>{formatShortDate(entry.mtimeMs)}</span>
          </SimpleTooltip>
        ) : null}
      </div>
      {remote && remoteEntry ? (
        <>
          <div role="gridcell" className={cn(COLUMN.mode, 'text-muted-foreground')}>
            <SimpleTooltip label={`Octal ${formatOctal(remoteEntry.mode)}`}>
              <span>{formatMode(remoteEntry.mode, entryModeKind(remoteEntry))}</span>
            </SimpleTooltip>
          </div>
          <div role="gridcell" className={cn(COLUMN.owner, 'text-[11px] text-muted-foreground')}>
            {remoteEntry.owner ?? ''}
          </div>
        </>
      ) : null}
    </div>
  );
});
