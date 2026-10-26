import {
  findGroup,
  type GitChangeStatus,
  isSameOrInside,
  type Project,
  parentPath,
  relativeTo,
} from '@runova/core';
import type { DirectoryEntry, WorkspaceGitState } from '@shared/apiTypes';
import { isImagePath } from '@shared/imageFiles';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useMemo, useRef, useState } from 'react';
import { ChevronRight, File, FilePlus, Folder, FolderOpen, ImageIcon } from '@/components/icons';
import { ContextMenu, ContextMenuTrigger } from '@/components/ui/context-menu';
import { Skeleton } from '@/components/ui/skeleton';
import { queryKeys } from '@/lib/queryKeys';
import { cn } from '@/lib/utils';
import {
  explorerProject,
  patchExplorer,
  selectRows,
  setFolderOpen,
  toggleExplorerSearch,
  useExplorerStore,
} from '@/stores/explorerStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import {
  commandTargets,
  copyPaths,
  copyToClipboard,
  createEntry,
  deleteEntries,
  pasteInto,
  projectRoot,
  renameEntry,
  revealInOs,
  sendPathsToAgent,
  targetFolder,
  transferEntries,
  transferExternalEntries,
} from './explorer/actions';
import { EntryNameInput } from './explorer/EntryNameInput';
import { ExplorerMenu, type ExplorerMenuTarget } from './explorer/ExplorerMenu';
import { ExplorerSearch } from './explorer/ExplorerSearch';
import { explorerCommandFor, isCopyDrag, isToggleSelectClick } from './explorer/keys';
import { StatusLetter, statusTextClass } from './StatusLetter';

/** Folders that are huge and generated; shown, but dimmed, and never expanded on their own. */
const QUIET_FOLDERS = new Set([
  'node_modules',
  'dist',
  'build',
  'out',
  '.next',
  'coverage',
  'target',
]);
const HIDDEN = new Set(['.git']);
/** How long a drag has to hover a closed folder before it opens. */
const DRAG_EXPAND_MS = 600;

interface TreeContext {
  project: Project;
  root: string;
  /** Git status by repository-relative path. */
  statusByPath: Map<string, GitChangeStatus>;
  /** Folders holding a changed file, so a collapsed folder still hints at what is inside. */
  dirtyFolders: Set<string>;
  /** Where the project sits inside the repository, to turn a row path into a status path. */
  projectPrefix: string;
  isRepo: boolean;
  /** The file showing in the focused pane. */
  activePath: string | null;
}

/** The entries being dragged. Drag events can't read their payload until the drop. */
let dragging: { projectId: string; paths: string[] } | null = null;
let expandTimer: { path: string; id: number } | null = null;

function clearExpandTimer(): void {
  if (expandTimer) window.clearTimeout(expandTimer.id);
  expandTimer = null;
}

function rowsOf(tree: Element | null): HTMLElement[] {
  return Array.from(tree?.querySelectorAll<HTMLElement>('[data-explorer-row]') ?? []);
}

function rowPath(row: HTMLElement): string {
  return row.dataset.explorerPath ?? '';
}

function rowIsDirectory(row: HTMLElement): boolean {
  return row.dataset.dir === 'true';
}

function repoPath(context: TreeContext, path: string): string {
  const rel = relativeTo(context.root, path) ?? '';
  return context.projectPrefix ? `${context.projectPrefix}/${rel}` : rel;
}

/** Selects every row from the anchor to `path`, in the order they show on screen. */
function selectRange(projectId: string, tree: Element | null, path: string): void {
  const paths = rowsOf(tree).map(rowPath);
  const anchor = explorerProject(projectId).anchor;
  const from = anchor ? paths.indexOf(anchor) : -1;
  const to = paths.indexOf(path);
  if (from === -1 || to === -1) {
    selectRows(projectId, [path]);
    return;
  }
  const range = paths.slice(Math.min(from, to), Math.max(from, to) + 1);
  selectRows(projectId, range, { focused: path, anchor });
}

/** Whether dropping the dragged entries into `folder` would put a folder inside itself. */
function dropAllowed(projectId: string, folder: string): boolean {
  if (!dragging || dragging.projectId !== projectId) return false;
  return !dragging.paths.some((path) => isSameOrInside(folder, path));
}

/** A drag carrying real OS files, dropped in from Explorer, Finder or a Linux file manager. */
function isExternalFilesDrag(event: React.DragEvent): boolean {
  return Array.from(event.dataTransfer.types).includes('Files');
}

/** Highlights `folder` as the drop target and arms the same hover-to-expand timer a drag uses. */
function armDropTarget(projectId: string, folder: string, expandPath: string | undefined): void {
  if (explorerProject(projectId).dropTarget !== folder) {
    patchExplorer(projectId, { dropTarget: folder });
  }
  if (expandPath && expandTimer?.path !== expandPath) {
    clearExpandTimer();
    if (!explorerProject(projectId).open[expandPath]) {
      expandTimer = {
        path: expandPath,
        id: window.setTimeout(() => setFolderOpen(projectId, expandPath, true), DRAG_EXPAND_MS),
      };
    }
  }
}

function dropHandlers(
  context: TreeContext,
  folder: string,
  options: { expandPath?: string } = {},
): Pick<React.HTMLAttributes<HTMLElement>, 'onDragOver' | 'onDragLeave' | 'onDrop'> {
  const { project } = context;
  return {
    onDragOver: (event) => {
      if (dragging) {
        event.stopPropagation();
        if (!dropAllowed(project.id, folder)) {
          event.dataTransfer.dropEffect = 'none';
          return;
        }
        event.preventDefault();
        event.dataTransfer.dropEffect = isCopyDrag(event) ? 'copy' : 'move';
        armDropTarget(project.id, folder, options.expandPath);
        return;
      }
      if (!isExternalFilesDrag(event)) return;
      event.stopPropagation();
      event.preventDefault();
      event.dataTransfer.dropEffect = 'copy';
      armDropTarget(project.id, folder, options.expandPath);
    },
    onDragLeave: (event) => {
      const next = event.relatedTarget as Node | null;
      if (next && event.currentTarget.contains(next)) return;
      if (explorerProject(project.id).dropTarget === folder) {
        patchExplorer(project.id, { dropTarget: null });
      }
    },
    onDrop: (event) => {
      if (dragging) {
        event.preventDefault();
        event.stopPropagation();
        clearExpandTimer();
        patchExplorer(project.id, { dropTarget: null });
        const payload = dragging;
        const allowed = dropAllowed(project.id, folder);
        dragging = null;
        if (!allowed) return;
        void transferEntries(project, payload.paths, folder, isCopyDrag(event) ? 'copy' : 'move');
        return;
      }
      if (!isExternalFilesDrag(event)) return;
      event.preventDefault();
      event.stopPropagation();
      clearExpandTimer();
      patchExplorer(project.id, { dropTarget: null });
      const paths = Array.from(event.dataTransfer.files)
        .map((file) => window.runova.shell.pathForFile(file))
        .filter((path): path is string => Boolean(path));
      if (paths.length === 0) return;
      void transferExternalEntries(project, paths, folder);
    },
  };
}

function NewEntryRow({
  context,
  parent,
  kind,
  depth,
}: {
  context: TreeContext;
  parent: string;
  kind: 'newFile' | 'newFolder';
  depth: number;
}): React.JSX.Element {
  const { project } = context;
  const done = (focusPath: string | null): void =>
    patchExplorer(project.id, { editing: null, pendingFocus: focusPath });
  return (
    <div
      className="mx-1.5 flex h-6 w-[calc(100%-0.75rem)] items-center gap-1.5 pr-2"
      style={{ paddingLeft: depth * 12 + 8 }}
    >
      <span className="w-2 shrink-0" />
      {kind === 'newFolder' ? (
        <Folder className="h-3 w-3 shrink-0 text-primary/60" />
      ) : (
        <File className="h-3 w-3 shrink-0 text-muted-foreground" />
      )}
      <EntryNameInput
        projectId={project.id}
        parent={parent}
        isDirectory={kind === 'newFolder'}
        allowNested
        onCancel={() => done(parent === context.root ? null : parent)}
        onCommit={async (name) => {
          const ok = await createEntry(project, kind, parent, name);
          if (ok) patchExplorer(project.id, { editing: null });
          return ok;
        }}
      />
    </div>
  );
}

function Directory({
  context,
  path,
  depth,
  ignored,
}: {
  context: TreeContext;
  path: string;
  depth: number;
  /** The folder itself is gitignored, so everything in it is too. */
  ignored: boolean;
}): React.JSX.Element {
  const { project, isRepo } = context;
  const listing = useQuery({
    queryKey: queryKeys.workspaceExplorerDir(project.id, path),
    queryFn: () => window.runova.fs.listDirectory(path),
    meta: { silentLoading: true },
    staleTime: 30_000,
  });
  const entries = useMemo(
    () => (listing.data ?? []).filter((entry) => !HIDDEN.has(entry.name)),
    [listing.data],
  );
  const ignoredHere = useQuery({
    queryKey: [...queryKeys.workspaceExplorerIgnored(project.id, path), listing.dataUpdatedAt],
    queryFn: async () =>
      new Set(
        await window.runova.explorer.ignoredPaths(
          project.id,
          entries.map((entry) => entry.path),
        ),
      ),
    enabled: isRepo && !ignored && entries.length > 0,
    meta: { silentLoading: true },
    staleTime: 30_000,
  });
  const creating = useExplorerStore((s) => {
    const editing = s.projects[project.id]?.editing;
    return editing && editing.kind !== 'rename' && editing.parent === path ? editing.kind : null;
  });

  if (listing.isPending) {
    return (
      <div className="space-y-px py-px pr-2" style={{ paddingLeft: depth * 12 + 20 }}>
        <Skeleton className="h-6 w-[70%] rounded-lg" />
        <Skeleton className="h-6 w-[50%] rounded-lg" />
      </div>
    );
  }
  if (listing.isError) {
    return (
      <p
        className="py-1 text-[11px] text-muted-foreground"
        style={{ paddingLeft: depth * 12 + 22 }}
      >
        Cannot read this folder.
      </p>
    );
  }
  return (
    <div role="group">
      {creating ? (
        <NewEntryRow context={context} parent={path} kind={creating} depth={depth} />
      ) : null}
      {entries.map((entry, index) => (
        <Entry
          key={entry.path}
          context={context}
          entry={entry}
          depth={depth}
          ignored={ignored || (ignoredHere.data?.has(entry.path) ?? false)}
          first={depth === 0 && index === 0}
        />
      ))}
    </div>
  );
}

function Entry({
  context,
  entry,
  depth,
  ignored,
  first,
}: {
  context: TreeContext;
  entry: DirectoryEntry;
  depth: number;
  ignored: boolean;
  /** The top row of the tree, which takes Tab focus until a row has been focused. */
  first: boolean;
}): React.JSX.Element {
  const { project, root, statusByPath, dirtyFolders, activePath, isRepo } = context;
  const rowRef = useRef<HTMLDivElement>(null);
  const open = useExplorerStore((s) => s.projects[project.id]?.open[entry.path] === true);
  const selected = useExplorerStore(
    (s) => s.projects[project.id]?.selected.includes(entry.path) === true,
  );
  const focused = useExplorerStore((s) => s.projects[project.id]?.focused === entry.path);
  const tabbable = useExplorerStore((s) => {
    const focusedPath = s.projects[project.id]?.focused;
    return focusedPath ? focusedPath === entry.path : first;
  });
  const renaming = useExplorerStore((s) => {
    const editing = s.projects[project.id]?.editing;
    return editing?.kind === 'rename' && editing.path === entry.path;
  });
  const wantsFocus = useExplorerStore((s) => s.projects[project.id]?.pendingFocus === entry.path);
  const dropTarget = useExplorerStore((s) => s.projects[project.id]?.dropTarget === entry.path);
  const cut = useExplorerStore(
    (s) => s.clipboard?.mode === 'cut' && s.clipboard.paths.includes(entry.path),
  );
  const openFile = useWorkspaceStore((s) => s.openFile);

  const relative = repoPath(context, entry.path);
  const quiet = isRepo ? ignored : entry.isDirectory && QUIET_FOLDERS.has(entry.name);
  const status = entry.isDirectory ? undefined : statusByPath.get(relative);
  const dirty = entry.isDirectory && dirtyFolders.has(relative);
  const folder = entry.isDirectory ? entry.path : (parentPath(entry.path) ?? root);
  const drop = dropHandlers(context, folder, {
    expandPath: entry.isDirectory ? entry.path : undefined,
  });

  // A rename, paste or keyboard move asks for this row to take focus once it exists.
  useEffect(() => {
    if (!wantsFocus) return;
    const row = rowRef.current;
    row?.focus({ preventScroll: true });
    row?.scrollIntoView({ block: 'nearest' });
    patchExplorer(project.id, { pendingFocus: null });
  }, [wantsFocus, project.id]);

  const toggle = (): void => setFolderOpen(project.id, entry.path, !open);

  return (
    <>
      <div
        ref={rowRef}
        role="treeitem"
        aria-level={depth + 1}
        aria-selected={selected}
        aria-expanded={entry.isDirectory ? open : undefined}
        aria-label={entry.name}
        tabIndex={tabbable ? 0 : -1}
        data-explorer-row
        data-explorer-path={entry.path}
        data-dir={entry.isDirectory ? 'true' : 'false'}
        draggable={!renaming}
        onFocus={(event) => {
          if (event.target === event.currentTarget && !focused) {
            patchExplorer(project.id, { focused: entry.path });
          }
        }}
        onClick={(event) => {
          if (renaming) return;
          if (event.shiftKey) {
            selectRange(project.id, rowRef.current?.closest('[role="tree"]') ?? null, entry.path);
            return;
          }
          if (isToggleSelectClick(event)) {
            const current = explorerProject(project.id).selected;
            const next = selected
              ? current.filter((path) => path !== entry.path)
              : [...current, entry.path];
            selectRows(project.id, next, { focused: entry.path, anchor: entry.path });
            return;
          }
          selectRows(project.id, [entry.path]);
          if (entry.isDirectory) toggle();
          else openFile(project.id, entry.path);
        }}
        onDoubleClick={(event) => {
          if (renaming || event.shiftKey || isToggleSelectClick(event)) return;
          if (!entry.isDirectory) openFile(project.id, entry.path, { pin: true });
        }}
        onDragStart={(event) => {
          const current = explorerProject(project.id).selected;
          const paths = current.includes(entry.path) ? current : [entry.path];
          if (!current.includes(entry.path)) selectRows(project.id, [entry.path]);
          dragging = { projectId: project.id, paths };
          event.dataTransfer.effectAllowed = 'copyMove';
          event.dataTransfer.setData('text/plain', paths.join('\n'));
        }}
        onDragEnd={() => {
          dragging = null;
          clearExpandTimer();
          patchExplorer(project.id, { dropTarget: null });
        }}
        {...drop}
        className={cn(
          'relative mx-1.5 flex h-6 w-[calc(100%-0.75rem)] cursor-pointer select-none items-center gap-1.5 rounded-lg pr-1.5 text-left text-[12px] outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring/60',
          selected
            ? 'bg-primary/12 text-primary hover:bg-primary/[0.16]'
            : activePath === entry.path
              ? 'bg-foreground/[0.06] text-foreground hover:bg-foreground/[0.08]'
              : 'text-foreground/85 hover:bg-foreground/[0.06] hover:text-foreground',
          dropTarget && 'bg-primary/20 ring-1 ring-inset ring-primary/50',
        )}
        style={{ paddingLeft: depth * 12 + 8 }}
      >
        {selected ? (
          <span
            aria-hidden
            className="absolute left-0 top-1/2 h-3.5 w-[3px] -translate-y-1/2 rounded-full bg-primary shadow-[0_0_8px_hsl(var(--primary)/0.7)]"
          />
        ) : null}
        <span
          className={cn(
            'flex min-w-0 flex-1 items-center gap-1.5',
            quiet && 'opacity-55',
            cut && 'opacity-50',
          )}
        >
          {entry.isDirectory ? (
            <ChevronRight
              className={cn(
                'h-2 w-2 shrink-0 text-muted-foreground/70 transition-transform',
                open && 'rotate-90',
              )}
            />
          ) : (
            <span className="w-2 shrink-0" />
          )}
          {entry.isDirectory ? (
            open ? (
              <FolderOpen className="h-3 w-3 shrink-0 text-primary/80" />
            ) : (
              <Folder className="h-3 w-3 shrink-0 text-primary/60" />
            )
          ) : isImagePath(entry.path) ? (
            <ImageIcon className="h-3 w-3 shrink-0 text-muted-foreground" />
          ) : (
            <File className="h-3 w-3 shrink-0 text-muted-foreground" />
          )}
          {renaming ? (
            <EntryNameInput
              projectId={project.id}
              parent={parentPath(entry.path) ?? root}
              initial={entry.name}
              isDirectory={entry.isDirectory}
              allowNested={false}
              onCancel={() =>
                patchExplorer(project.id, { editing: null, pendingFocus: entry.path })
              }
              onCommit={async (name) => {
                const ok = await renameEntry(project, entry.path, name);
                if (ok) patchExplorer(project.id, { editing: null });
                return ok;
              }}
            />
          ) : (
            <span
              className={cn(
                'min-w-0 flex-1 truncate',
                status && statusTextClass(status),
                status === 'D' && 'line-through',
                dirty && 'text-warning/90',
              )}
            >
              {entry.name}
            </span>
          )}
        </span>
        {renaming ? null : status ? (
          <StatusLetter status={status} />
        ) : dirty ? (
          <span className="mr-1 h-1.5 w-1.5 rounded-full bg-warning/80" />
        ) : null}
      </div>
      {entry.isDirectory && open ? (
        <Directory context={context} path={entry.path} depth={depth + 1} ignored={ignored} />
      ) : null}
    </>
  );
}

/**
 * The project's files as a tree, with the file operations VS Code's explorer has: a context
 * menu, inline rename and create, copy, cut and paste, drag to move, and the same keys.
 * Changed files carry their git status; a file opens in a tab.
 */
export function ExplorerSection({
  project,
  state,
}: {
  project: Project;
  state: WorkspaceGitState | undefined;
}): React.JSX.Element {
  const root = projectRoot(project);
  const treeRef = useRef<HTMLDivElement>(null);
  const [menuTarget, setMenuTarget] = useState<ExplorerMenuTarget>({
    path: null,
    isDirectory: true,
  });
  const rootDropTarget = useExplorerStore((s) => s.projects[project.id]?.dropTarget === root);
  const search = useExplorerStore((s) => s.projects[project.id]?.search ?? null);
  const creating = useExplorerStore((s) => {
    const editing = s.projects[project.id]?.editing;
    return editing !== null && editing !== undefined && editing.kind !== 'rename';
  });
  // The file showing in the focused pane is highlighted in the tree.
  const activePath = useWorkspaceStore((s) => {
    const ws = s.workspaces[project.id];
    if (!ws) return null;
    const group = findGroup(ws.root, ws.focusedGroupId);
    const tab = group?.activeTabId ? ws.tabs[group.activeTabId] : undefined;
    return tab?.kind === 'file' ? tab.path : null;
  });

  const context = useMemo<TreeContext>(() => {
    const statusByPath = new Map<string, GitChangeStatus>();
    const dirtyFolders = new Set<string>();
    const add = (path: string, status: GitChangeStatus): void => {
      if (!statusByPath.has(path) || status === 'U') statusByPath.set(path, status);
      const parts = path.split('/');
      for (let i = 1; i < parts.length; i += 1) dirtyFolders.add(parts.slice(0, i).join('/'));
    };
    for (const entry of state?.conflicts ?? []) add(entry.path, 'U');
    for (const entry of [...(state?.unstaged ?? []), ...(state?.staged ?? [])]) {
      add(entry.path, entry.status);
    }
    for (const entry of state?.untracked ?? []) add(entry.path, '?');
    return {
      project,
      root,
      statusByPath,
      dirtyFolders,
      projectPrefix: state?.projectPrefix ?? '',
      isRepo: state?.isRepo === true,
      activePath,
    };
  }, [project, root, state, activePath]);

  const rootDrop = dropHandlers(context, root);

  function focusRow(row: HTMLElement | undefined, extend: boolean): void {
    if (!row) return;
    const path = rowPath(row);
    if (extend) selectRange(project.id, treeRef.current, path);
    else selectRows(project.id, [path]);
    row.focus({ preventScroll: true });
    row.scrollIntoView({ block: 'nearest' });
  }

  async function deleteWithFocus(permanent: boolean): Promise<void> {
    const targets = commandTargets(project.id);
    if (targets.length === 0) return;
    const rows = rowsOf(treeRef.current);
    const paths = rows.map(rowPath);
    const last = Math.max(...targets.map((path) => paths.indexOf(path)));
    const survivor =
      paths.slice(last + 1).find((path) => !targets.some((t) => isSameOrInside(path, t))) ??
      paths
        .slice(0, Math.max(0, last))
        .reverse()
        .find((path) => !targets.some((t) => isSameOrInside(path, t)));
    const deleted = await deleteEntries(project, targets, { permanent });
    if (deleted && survivor) selectRows(project.id, [survivor], { focus: true });
    else if (!deleted)
      patchExplorer(project.id, { pendingFocus: explorerProject(project.id).focused });
  }

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    const target = event.target as HTMLElement;
    if (target.closest('input, textarea, [contenteditable="true"]')) return;
    const rows = rowsOf(treeRef.current);
    const row = target.closest<HTMLElement>('[data-explorer-row]');
    const index = row ? rows.indexOf(row) : -1;
    const path = row ? rowPath(row) : null;
    const isDirectory = row ? rowIsDirectory(row) : true;
    const plain = !event.ctrlKey && !event.metaKey && !event.altKey;
    const handled = (): void => {
      event.preventDefault();
      event.stopPropagation();
    };

    if (plain) {
      switch (event.key) {
        case 'ArrowDown':
          handled();
          focusRow(index === -1 ? rows[0] : rows[index + 1], event.shiftKey);
          return;
        case 'ArrowUp':
          handled();
          focusRow(index === -1 ? rows[0] : rows[index - 1], event.shiftKey);
          return;
        case 'Home':
          handled();
          focusRow(rows[0], event.shiftKey);
          return;
        case 'End':
          handled();
          focusRow(rows.at(-1), event.shiftKey);
          return;
        case 'ArrowRight':
          if (!row || !isDirectory || !path) return;
          handled();
          if (!explorerProject(project.id).open[path]) setFolderOpen(project.id, path, true);
          else if (Number(rows[index + 1]?.ariaLevel) > Number(row.ariaLevel)) {
            focusRow(rows[index + 1], false);
          }
          return;
        case 'ArrowLeft': {
          if (!row || !path) return;
          handled();
          if (isDirectory && explorerProject(project.id).open[path]) {
            setFolderOpen(project.id, path, false);
            return;
          }
          const parent = parentPath(path);
          focusRow(
            rows.find((r) => rowPath(r) === parent),
            false,
          );
          return;
        }
        case ' ':
          if (!row || !path || event.shiftKey) return;
          handled();
          if (isDirectory) setFolderOpen(project.id, path, !explorerProject(project.id).open[path]);
          else useWorkspaceStore.getState().openFile(project.id, path);
          return;
        case 'Escape': {
          const { clipboard } = useExplorerStore.getState();
          const { selected, focused } = explorerProject(project.id);
          if (clipboard?.mode === 'cut') {
            handled();
            useExplorerStore.setState({ clipboard: null });
          } else if (selected.length > 1 || (selected.length === 1 && selected[0] !== focused)) {
            handled();
            selectRows(project.id, focused ? [focused] : []);
          }
          return;
        }
      }
    }

    const command = explorerCommandFor(event);
    if (!command) return;
    const targets = commandTargets(project.id);
    switch (command) {
      case 'rename':
        if (!path) return;
        handled();
        patchExplorer(project.id, { editing: { kind: 'rename', path, isDirectory } });
        return;
      case 'delete':
      case 'deletePermanently':
        if (targets.length === 0) return;
        handled();
        void deleteWithFocus(command === 'deletePermanently');
        return;
      case 'copy':
      case 'cut':
        if (targets.length === 0) return;
        handled();
        copyToClipboard(project, targets, command);
        return;
      case 'paste':
        handled();
        void pasteInto(project, targetFolder(project, path, isDirectory));
        return;
      case 'open':
        if (!path) return;
        handled();
        if (isDirectory) setFolderOpen(project.id, path, !explorerProject(project.id).open[path]);
        else useWorkspaceStore.getState().openFile(project.id, path, { pin: true });
        return;
      case 'selectAll':
        handled();
        selectRows(project.id, rows.map(rowPath), { focused: path, anchor: path });
        return;
      case 'copyPath':
      case 'copyRelativePath':
        handled();
        copyPaths(project, targets.length > 0 ? targets : [root], command === 'copyRelativePath');
        return;
      case 'reveal':
        handled();
        revealInOs(project, path ?? root);
        return;
      case 'find':
        handled();
        toggleExplorerSearch(project.id, true);
        return;
      case 'addToChat':
        if (targets.length === 0) return;
        handled();
        sendPathsToAgent(project, targets);
        return;
    }
  }

  /** Closes the search box and puts the keyboard back on the tree. */
  function closeSearch(): void {
    toggleExplorerSearch(project.id, false);
    const { focused } = explorerProject(project.id);
    if (focused) patchExplorer(project.id, { pendingFocus: focused });
    else rowsOf(treeRef.current)[0]?.focus({ preventScroll: true });
  }

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {search !== null ? (
        <ExplorerSearch
          project={project}
          query={search}
          statusByPath={context.statusByPath}
          projectPrefix={context.projectPrefix}
          activePath={activePath}
          onClose={closeSearch}
        />
      ) : null}
      <ContextMenu
        modal={false}
        onOpenChange={(open) => {
          if (open) return;
          // Give keyboard focus back to the row, unless the chosen item moved it (a rename box,
          // a dialog).
          setTimeout(() => {
            const { editing, focused } = explorerProject(project.id);
            if (!editing && focused && document.activeElement === document.body) {
              patchExplorer(project.id, { pendingFocus: focused });
            }
          }, 0);
        }}
      >
        <ContextMenuTrigger asChild>
          <div
            ref={treeRef}
            role="tree"
            aria-label="Project files"
            aria-multiselectable
            tabIndex={-1}
            onKeyDown={onKeyDown}
            onContextMenu={(event) => {
              const target = event.target as HTMLElement;
              // The name box stops its own right-clicks before they get here, so it keeps the
              // text field menu. This only catches any other input that ends up in the tree.
              if (target.closest('input')) {
                event.preventDefault();
                return;
              }
              const row = target.closest<HTMLElement>('[data-explorer-row]');
              if (!row) {
                setMenuTarget({ path: null, isDirectory: true });
                return;
              }
              const path = rowPath(row);
              const { selected } = explorerProject(project.id);
              if (selected.includes(path)) patchExplorer(project.id, { focused: path });
              else selectRows(project.id, [path]);
              setMenuTarget({ path, isDirectory: rowIsDirectory(row) });
            }}
            onClick={(event) => {
              // A click on the empty space below the rows clears the selection.
              if (event.target === event.currentTarget)
                selectRows(project.id, [], { focused: null });
            }}
            {...rootDrop}
            className={cn(
              'min-h-0 flex-1 space-y-px overflow-y-auto py-1.5 outline-none [&_[role=group]]:space-y-px',
              rootDropTarget && 'bg-primary/[0.06] ring-1 ring-inset ring-primary/40',
              // Results take the tree's place while something is typed. The tree stays mounted
              // so it keeps its scroll position and its folders stay loaded.
              search && 'hidden',
            )}
          >
            <Directory context={context} path={root} depth={0} ignored={false} />
            {!creating ? <EmptyHint context={context} /> : null}
          </div>
        </ContextMenuTrigger>
        <ExplorerMenu project={project} target={menuTarget} isRepo={context.isRepo} />
      </ContextMenu>
    </div>
  );
}

/** Shown under an empty project folder, so the right-click menu is not the only way in. */
function EmptyHint({ context }: { context: TreeContext }): React.JSX.Element | null {
  const { project, root } = context;
  const empty = useQuery({
    queryKey: queryKeys.workspaceExplorerDir(project.id, root),
    queryFn: () => window.runova.fs.listDirectory(root),
    select: (entries) => entries.filter((entry) => !HIDDEN.has(entry.name)).length === 0,
    meta: { silentLoading: true },
    staleTime: 30_000,
  });
  if (empty.data !== true) return null;
  return (
    <button
      type="button"
      onClick={() => patchExplorer(project.id, { editing: { kind: 'newFile', parent: root } })}
      className="mx-2 mt-2 flex h-7 cursor-pointer items-center gap-1.5 rounded-full px-2.5 text-[12px] text-muted-foreground transition-colors hover:bg-foreground/[0.06] hover:text-foreground"
    >
      <FilePlus className="h-3 w-3" />
      This folder is empty. Create a file
    </button>
  );
}
