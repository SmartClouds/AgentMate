import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from '@/components/ui/context-menu';
import { isRemoteEntry, type PaneEntry } from '@/lib/sftp/entries';

export interface PaneMenuActions {
  /** Upload (local) or Download (remote) of the entries. */
  onTransfer: () => void;
  /** Opens a remote text file in the editor. */
  onEdit: (entry: PaneEntry) => void;
  onRename: (entry: PaneEntry) => void;
  onDelete: () => void;
  onNewFolder: () => void;
  onProperties: () => void;
  onCopyPath: () => void;
  onRefresh: () => void;
}

export interface PaneContextMenuProps extends PaneMenuActions {
  side: 'local' | 'remote';
  /** What the menu is about: the selected rows, or none for the empty space. */
  entries: PaneEntry[];
  /** The other side has a folder open, so a transfer has somewhere to go. */
  canTransfer: boolean;
}

function Item({
  label,
  shortcut,
  onSelect,
  disabled,
  danger,
}: {
  label: string;
  shortcut?: string;
  onSelect: () => void;
  disabled?: boolean;
  danger?: boolean;
}): React.JSX.Element {
  return (
    <ContextMenuItem onSelect={onSelect} disabled={disabled} tone={danger ? 'danger' : 'default'}>
      <span className="truncate">{label}</span>
      {shortcut ? <ContextMenuShortcut>{shortcut}</ContextMenuShortcut> : null}
    </ContextMenuItem>
  );
}

/** Radix puts focus back on the list when an item runs; a field that opens has to wait for that. */
function later(run: () => void): () => void {
  return () => {
    setTimeout(run, 0);
  };
}

/** The right-click menu of a pane: what it offers depends on the side and on what was clicked. */
export function PaneContextMenu({
  side,
  entries,
  canTransfer,
  onTransfer,
  onEdit,
  onRename,
  onDelete,
  onNewFolder,
  onProperties,
  onCopyPath,
  onRefresh,
}: PaneContextMenuProps): React.JSX.Element {
  const single = entries.length === 1 ? entries[0] : undefined;
  const editable =
    single !== undefined && isRemoteEntry(single) && single.kind === 'file' && !single.isDirectory;
  const remote = side === 'remote';

  return (
    <ContextMenuContent
      className="min-w-[14rem]"
      onCloseAutoFocus={(event) => event.preventDefault()}
    >
      {entries.length > 0 ? (
        <>
          <Item
            label={remote ? 'Download' : 'Upload'}
            onSelect={onTransfer}
            disabled={!canTransfer}
          />
          {remote ? (
            <Item label="Edit" onSelect={() => single && onEdit(single)} disabled={!editable} />
          ) : null}
          <Item
            label="Rename"
            shortcut="F2"
            onSelect={later(() => single && onRename(single))}
            disabled={!single}
          />
          <Item
            label={remote ? 'Delete' : 'Move to Trash'}
            shortcut="Del"
            danger
            onSelect={later(onDelete)}
          />
          <ContextMenuSeparator />
        </>
      ) : null}
      <Item label="New folder" onSelect={later(onNewFolder)} />
      {remote && entries.length > 0 ? (
        <Item label="Permissions and properties" onSelect={onProperties} />
      ) : null}
      <Item label="Copy path" onSelect={onCopyPath} />
      <Item label="Refresh" shortcut="F5" onSelect={onRefresh} />
    </ContextMenuContent>
  );
}
