import {
  baseName,
  formatFileMentions,
  isSameOrInside,
  type Project,
  parentPath,
  relativeTo,
  topLevelPaths,
} from '@runova/core';
import type { DirectoryEntry, ExplorerMove } from '@shared/apiTypes';
import { toast } from 'sonner';
import { Trash2 } from '@/components/icons';
import { queryKeys } from '@/lib/queryKeys';
import { deliverToAgent } from '@/lib/workspace/agentSend';
import { findAgentTerminal } from '@/lib/workspace/agentTarget';
import { launchShellTab, projectCliId } from '@/lib/workspace/launch';
import { queryClient } from '@/queryClient';
import { type ConfirmItem, confirmDialog } from '@/stores/confirmStore';
import {
  explorerProject,
  forgetExplorerPaths,
  patchExplorer,
  remapExplorerPaths,
  selectRows,
  setFolderOpen,
  useExplorerStore,
} from '@/stores/explorerStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { trashName } from './keys';

/** Electron prefixes rejected IPC calls with "Error invoking remote method '...': Error: ". */
function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error ?? '');
  return (
    raw
      .replace(/^Error invoking remote method '[^']*':\s*/, '')
      .replace(/^Error:\s*/, '')
      .trim() || 'Something went wrong.'
  );
}

function fail(title: string, error: unknown): void {
  toast.error(title, { description: errorText(error) });
}

export function projectRoot(project: Project): string {
  return project.folderPath.replace(/[\\/]+$/, '');
}

function refreshTree(projectId: string): Promise<void> {
  return queryClient.invalidateQueries({ queryKey: queryKeys.workspaceExplorer(projectId) });
}

/** Opens every folder between the project root and `path`, so a new or pasted row is visible. */
function revealRow(project: Project, path: string): void {
  const root = projectRoot(project);
  let folder = parentPath(path);
  while (folder && isSameOrInside(folder, root) && folder !== root) {
    setFolderOpen(project.id, folder, true);
    folder = parentPath(folder);
  }
}

/** Opens the folders down to `path`, then selects and focuses its row. */
export function revealInTree(project: Project, path: string): void {
  revealRow(project, path);
  selectRows(project.id, [path], { focus: true });
}

/** The entries already listed in a folder, from the tree's cache. */
export function cachedListing(projectId: string, dir: string): DirectoryEntry[] {
  return (
    queryClient.getQueryData<DirectoryEntry[]>(queryKeys.workspaceExplorerDir(projectId, dir)) ?? []
  );
}

/** Moves open tabs, cached file contents and the tree's memory of a path to where it went. */
function followMoves(projectId: string, moves: ExplorerMove[]): void {
  const workspace = useWorkspaceStore.getState();
  for (const { from, to } of moves) {
    for (const tab of Object.values(workspace.workspaces[projectId]?.tabs ?? {})) {
      if (tab.kind !== 'file' || !isSameOrInside(tab.path, from)) continue;
      const next = to + tab.path.slice(from.replace(/[\\/]+$/, '').length);
      const data = queryClient.getQueryData(queryKeys.workspaceFile(tab.path));
      if (data !== undefined) queryClient.setQueryData(queryKeys.workspaceFile(next), data);
    }
    workspace.retargetFileTabs(projectId, from, to);
    remapExplorerPaths(projectId, from, to);
  }
}

/** The folder a paste or "New File" lands in: the focused folder, or the focused file's folder. */
export function targetFolder(project: Project, path: string | null, isDirectory: boolean): string {
  if (!path) return projectRoot(project);
  return isDirectory ? path : (parentPath(path) ?? projectRoot(project));
}

export function startCreate(project: Project, kind: 'newFile' | 'newFolder', parent: string): void {
  const root = projectRoot(project);
  if (parent !== root) {
    revealRow(project, parent);
    setFolderOpen(project.id, parent, true);
  }
  patchExplorer(project.id, { editing: { kind, parent } });
}

/** "New File" from the panel header: inside the focused folder, or beside the focused file. */
export function startCreateAtFocus(project: Project, kind: 'newFile' | 'newFolder'): void {
  const { focused } = explorerProject(project.id);
  const row = focused
    ? Array.from(document.querySelectorAll<HTMLElement>('[data-explorer-row]')).find(
        (element) => element.dataset.explorerPath === focused,
      )
    : undefined;
  const parent = row
    ? targetFolder(project, focused, row.dataset.dir === 'true')
    : projectRoot(project);
  startCreate(project, kind, parent);
}

export async function createEntry(
  project: Project,
  kind: 'newFile' | 'newFolder',
  parent: string,
  name: string,
): Promise<boolean> {
  try {
    const api = window.runova.explorer;
    const path =
      kind === 'newFile'
        ? await api.createFile(project.id, parent, name)
        : await api.createFolder(project.id, parent, name);
    revealRow(project, path);
    await refreshTree(project.id);
    selectRows(project.id, [path], { focus: kind === 'newFolder' || /[\\/]$/.test(name) });
    if (kind === 'newFile' && !/[\\/]$/.test(name)) {
      useWorkspaceStore.getState().openFile(project.id, path, { pin: true });
    }
    return true;
  } catch (error) {
    fail(kind === 'newFile' ? 'Could not create the file' : 'Could not create the folder', error);
    return false;
  }
}

export async function renameEntry(
  project: Project,
  path: string,
  newName: string,
): Promise<boolean> {
  if (newName === baseName(path)) return true;
  try {
    const next = await window.runova.explorer.rename(project.id, path, newName);
    followMoves(project.id, [{ from: path, to: next }]);
    await refreshTree(project.id);
    selectRows(project.id, [next], { focus: true });
    return true;
  } catch (error) {
    fail('Could not rename', error);
    return false;
  }
}

function listNames(paths: string[]): string {
  const names = paths.slice(0, 10).map((path) => baseName(path));
  const more = paths.length > 10 ? `\nand ${paths.length - 10} more` : '';
  return `${names.join('\n')}${more}`;
}

const LISTED_LIMIT = 50;

/** The rows the delete modal lists: each name, the folder it sits in, and whether it is a folder. */
function deleteItems(project: Project, paths: string[]): ConfirmItem[] {
  const root = projectRoot(project);
  return paths.slice(0, LISTED_LIMIT).map((path) => {
    const parent = parentPath(path) ?? root;
    const name = baseName(path);
    const entry = cachedListing(project.id, parent).find((row) => row.name === name);
    const folder = relativeTo(root, parent);
    return { name, detail: folder || undefined, isDirectory: entry?.isDirectory ?? false };
  });
}

/** Deletes after asking, to the trash unless `permanent`. True when anything was deleted. */
export async function deleteEntries(
  project: Project,
  paths: string[],
  options: { permanent: boolean },
): Promise<boolean> {
  const targets = topLevelPaths(paths).filter((path) => path !== projectRoot(project));
  if (targets.length === 0) return false;
  const dirty = Object.keys(useExplorerStore.getState().dirtyFiles).filter((file) =>
    targets.some((target) => isSameOrInside(file, target)),
  );
  const items = deleteItems(project, targets);
  const single = targets.length === 1;
  const subject = single
    ? `this ${items[0]?.isDirectory ? 'folder' : 'file'}`
    : `${targets.length} items`;
  const restoreNote = options.permanent
    ? "This can't be undone."
    : `You can restore ${single ? 'it' : 'them'} from the ${trashName()}.`;
  const confirmed = await confirmDialog({
    title: options.permanent ? `Permanently delete ${subject}?` : `Delete ${subject}?`,
    description: restoreNote,
    items,
    moreCount: targets.length - items.length || undefined,
    warning:
      dirty.length > 0
        ? `${dirty.length === 1 ? 'One open file has' : `${dirty.length} open files have`} unsaved changes that will be lost.`
        : undefined,
    icon: Trash2,
    confirmLabel: options.permanent ? 'Delete permanently' : `Move to ${trashName()}`,
    variant: 'destructive',
  });
  if (!confirmed) return false;

  let deleted = targets;
  try {
    const result = await window.runova.explorer.delete(project.id, targets, options);
    if (result.failed.length > 0) {
      const again = await confirmDialog({
        title: `Could not move ${result.failed.length === 1 ? `"${baseName(result.failed[0] as string)}"` : `${result.failed.length} items`} to the ${trashName()}`,
        description: "Delete permanently instead? This can't be undone.",
        confirmLabel: 'Delete permanently',
        variant: 'destructive',
      });
      if (again) {
        await window.runova.explorer.delete(project.id, result.failed, { permanent: true });
      } else {
        deleted = targets.filter((path) => !result.failed.includes(path));
      }
    }
  } catch (error) {
    fail('Could not delete', error);
    await refreshTree(project.id);
    return false;
  }
  useWorkspaceStore.getState().closeFileTabsUnder(project.id, deleted);
  forgetExplorerPaths(project.id, deleted);
  await refreshTree(project.id);
  return deleted.length > 0;
}

/** The in-app copy on its way to the OS clipboard. A paste waits for it before reading there. */
let clipboardWrite: Promise<void> = Promise.resolve();

export function copyToClipboard(project: Project, paths: string[], mode: 'copy' | 'cut'): void {
  const top = topLevelPaths(paths).filter((path) => path !== projectRoot(project));
  if (top.length === 0) return;
  useExplorerStore.setState({ clipboard: { mode, projectId: project.id, paths: top } });
  // Taking the OS clipboard clears any files copied in Explorer earlier, so files found there at
  // paste time were copied after this and win.
  clipboardWrite = navigator.clipboard.writeText(top.join('\n')).catch(() => undefined);
}

/** Case only matters to a path on Linux. */
function samePath(a: string, b: string): boolean {
  const norm = (path: string): string => {
    const trimmed = path.replace(/[\\/]+$/, '');
    return window.runova.platform === 'linux' ? trimmed : trimmed.toLowerCase();
  };
  return norm(a) === norm(b);
}

/** Pasting an entry onto itself puts the copy beside it, as VS Code does, not inside itself. */
function pasteTarget(project: Project, target: string, sources: string[]): string {
  if (!sources.some((source) => samePath(source, target))) return target;
  return parentPath(target) ?? projectRoot(project);
}

/** Copies or moves entries into a folder, asking before a move replaces anything. */
export async function transferEntries(
  project: Project,
  sources: string[],
  target: string,
  mode: 'copy' | 'move',
): Promise<boolean> {
  const api = window.runova.explorer;
  try {
    let result =
      mode === 'copy'
        ? await api.copy(project.id, sources, target)
        : await api.move(project.id, sources, target, { overwrite: false });
    if (result.conflicts.length > 0) {
      const [first] = result.conflicts;
      const replace = await confirmDialog({
        title:
          result.conflicts.length === 1
            ? `"${first}" already exists in "${baseName(target)}"`
            : `${result.conflicts.length} items already exist in "${baseName(target)}"`,
        description:
          result.conflicts.length === 1
            ? 'Do you want to replace it? The file that is there now goes to the ' +
              `${trashName()}.`
            : `${listNames(result.conflicts)}\n\nDo you want to replace them? The files there now go to the ${trashName()}.`,
        confirmLabel: 'Replace',
        variant: 'destructive',
      });
      if (!replace) return false;
      result = await api.move(project.id, sources, target, { overwrite: true });
    }
    if (mode === 'move') followMoves(project.id, result.moves);
    if (target !== projectRoot(project)) setFolderOpen(project.id, target, true);
    await refreshTree(project.id);
    const landed = result.moves.map((move) => move.to);
    if (landed.length > 0) selectRows(project.id, landed, { focus: true });
    return true;
  } catch (error) {
    fail(mode === 'copy' ? 'Could not copy' : 'Could not move', error);
    await refreshTree(project.id);
    return false;
  }
}

/** Copies external entries (an OS clipboard paste, or a drag from the OS file manager) in. */
export async function transferExternalEntries(
  project: Project,
  sources: string[],
  target: string,
): Promise<boolean> {
  try {
    const result = await window.runova.explorer.pasteExternal(project.id, sources, target);
    if (target !== projectRoot(project)) setFolderOpen(project.id, target, true);
    await refreshTree(project.id);
    const landed = result.moves.map((move) => move.to);
    if (landed.length > 0) selectRows(project.id, landed, { focus: true });
    return true;
  } catch (error) {
    fail('Could not copy', error);
    await refreshTree(project.id);
    return false;
  }
}

/**
 * Pastes whichever was copied last: files on the OS clipboard (copied in Explorer or Finder), or
 * what was cut or copied in this explorer. An in-app copy takes the OS clipboard over, so files
 * found there came after it. With nothing to paste, this does nothing.
 */
export async function pasteInto(project: Project, target: string): Promise<void> {
  await clipboardWrite;
  const external = await window.runova.explorer.osClipboardPaths().catch(() => []);
  if (external.length > 0) {
    // The in-app copy is older than these files, so it is done with, and a cut row stops fading.
    useExplorerStore.setState({ clipboard: null });
    await transferExternalEntries(project, external, pasteTarget(project, target, external));
    return;
  }
  const clipboard = useExplorerStore.getState().clipboard;
  if (!clipboard || clipboard.projectId !== project.id) return;
  const done = await transferEntries(
    project,
    clipboard.paths,
    pasteTarget(project, target, clipboard.paths),
    clipboard.mode === 'cut' ? 'move' : 'copy',
  );
  // A cut moves once; a copy can be pasted again.
  if (done && clipboard.mode === 'cut') useExplorerStore.setState({ clipboard: null });
}

export function copyPaths(project: Project, paths: string[], relative: boolean): void {
  const separator = window.runova.platform === 'win32' ? '\\' : '/';
  const text = paths
    .map((path) => {
      if (!relative) return path;
      const rel = relativeTo(projectRoot(project), path);
      return rel === null ? path : rel.replaceAll('/', separator) || '.';
    })
    .join('\n');
  void navigator.clipboard.writeText(text).then(
    () => toast.success(paths.length === 1 ? 'Path copied' : `${paths.length} paths copied`),
    (error) => fail('Could not copy the path', error),
  );
}

/** Whether a row is a folder, from the listing of its parent the tree already loaded. */
function isListedDirectory(projectId: string, path: string): boolean {
  const parent = parentPath(path);
  if (!parent) return false;
  return cachedListing(projectId, parent).some((entry) => entry.path === path && entry.isDirectory);
}

/**
 * The CLI that "Add to agent chat" hands files to: the running agent it would pick, or the
 * project's default CLI that it would start. Null when there is neither.
 */
export function agentChatTarget(project: Project): { cliId: string; running: boolean } | null {
  const tab = findAgentTerminal(project.id);
  if (tab?.cliId) return { cliId: tab.cliId, running: true };
  const cliId = projectCliId(project);
  return cliId ? { cliId, running: false } : null;
}

/**
 * Types references to files and folders (`@src/app.ts @src/lib/ `) into the agent CLI running
 * in the workspace and focuses it, so the user asks about them right there. Nothing is
 * submitted. With no agent running, the project's default CLI is started and gets them once it
 * is ready.
 */
export function sendPathsToAgent(project: Project, paths: string[]): void {
  const root = projectRoot(project);
  const entries = topLevelPaths(paths)
    .filter((path) => path !== root)
    .map((path) => ({
      relativePath: relativeTo(root, path) ?? path,
      isDirectory: isListedDirectory(project.id, path),
    }));
  if (entries.length === 0) return;

  void deliverToAgent(project, {
    build: (cliId) => formatFileMentions(cliId, entries),
    what: 'The file references',
  });
}

export function revealInOs(project: Project, path: string): void {
  void window.runova.explorer
    .revealInOs(project.id, path)
    .catch((error) => fail('Could not open the folder', error));
}

export function openInTerminal(project: Project, path: string, isDirectory: boolean): void {
  launchShellTab(project, undefined, undefined, targetFolder(project, path, isDirectory));
}

export function openToSide(project: Project, path: string): void {
  const store = useWorkspaceStore.getState();
  const ws = store.workspaces[project.id];
  if (!ws) return;
  store.splitGroup(project.id, ws.focusedGroupId, 'row');
  store.openFile(project.id, path, { pin: true });
}

/**
 * Adds rows to the repository's root .gitignore: each path on its own line, or with
 * `extension`, every file sharing the first path's extension. Paths git still tracks are
 * offered a "Stop tracking" action, since ignoring alone does not untrack them.
 */
export async function addToGitignore(
  project: Project,
  paths: string[],
  pattern: 'path' | 'extension',
): Promise<void> {
  const api = window.runova.explorer;
  const targets = pattern === 'extension' ? paths.slice(0, 1) : topLevelPaths(paths);
  const lines: string[] = [];
  const tracked: string[] = [];
  let added = 0;
  try {
    // One at a time: every call rewrites the same .gitignore.
    for (const path of targets) {
      const result = await api.addToGitignore(project.id, path, pattern);
      lines.push(result.line);
      if (result.added) added += 1;
      if (result.tracked && pattern === 'path') tracked.push(path);
    }
  } catch (error) {
    fail('Could not update .gitignore', error);
  } finally {
    await refreshTree(project.id);
  }
  if (lines.length === 0) return;

  const message =
    lines.length === 1
      ? added === 1
        ? `Added ${lines[0]} to .gitignore`
        : `${lines[0]} is already in .gitignore`
      : `Added ${added} of ${lines.length} entries to .gitignore`;
  if (tracked.length === 0) {
    toast.success(message);
    return;
  }
  const subject =
    tracked.length === 1 ? `"${baseName(tracked[0] as string)}"` : `${tracked.length} of them`;
  toast.message(message, {
    description: `Git still tracks ${subject}, so its changes keep showing until it is untracked.`,
    duration: 10_000,
    action: {
      label: 'Stop tracking',
      onClick: () => {
        void (async () => {
          try {
            for (const path of tracked) await api.untrack(project.id, path);
            toast.success(
              tracked.length === 1
                ? `Stopped tracking ${baseName(tracked[0] as string)}. It stays on disk.`
                : `Stopped tracking ${tracked.length} items. They stay on disk.`,
            );
          } catch (error) {
            fail('Could not stop tracking', error);
          } finally {
            void refreshTree(project.id);
          }
        })();
      },
    },
  });
}

export function collapseAll(projectId: string): void {
  patchExplorer(projectId, { open: {} });
}

/** Rows the keyboard commands act on: the selection, when the focused row is part of it. */
export function commandTargets(projectId: string): string[] {
  const { selected, focused } = explorerProject(projectId);
  if (focused && !selected.includes(focused)) return [focused];
  return selected.length > 0 ? selected : focused ? [focused] : [];
}
