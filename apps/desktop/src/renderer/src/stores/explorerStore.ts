import { isSameOrInside, remapPath } from '@runova/core';
import { create } from 'zustand';

/** An inline name box in the explorer: renaming a row, or naming a new file or folder. */
export type ExplorerEditing =
  | { kind: 'rename'; path: string; isDirectory: boolean }
  | { kind: 'newFile' | 'newFolder'; parent: string };

export interface ExplorerProjectState {
  /** Folders that are expanded. */
  open: Record<string, boolean>;
  selected: string[];
  /** The row keyboard commands act from. */
  focused: string | null;
  /** Where a shift-click or shift-arrow range starts. */
  anchor: string | null;
  editing: ExplorerEditing | null;
  /** A row that should take keyboard focus once it has rendered (after a rename or paste). */
  pendingFocus: string | null;
  /** The folder a drag is hovering, or the project root. */
  dropTarget: string | null;
  /** What is typed in the search box above the tree. Null while the box is closed. */
  search: string | null;
}

export interface ExplorerClipboard {
  mode: 'copy' | 'cut';
  projectId: string;
  paths: string[];
}

interface ExplorerState {
  projects: Record<string, ExplorerProjectState>;
  /** Files copied or cut in the explorer. Kept app-wide, like VS Code. */
  clipboard: ExplorerClipboard | null;
  /** Open file tabs holding unsaved edits, so a delete can warn about them. */
  dirtyFiles: Record<string, true>;
}

const EMPTY: ExplorerProjectState = {
  open: {},
  selected: [],
  focused: null,
  anchor: null,
  editing: null,
  pendingFocus: null,
  dropTarget: null,
  search: null,
};

export const useExplorerStore = create<ExplorerState>(() => ({
  projects: {},
  clipboard: null,
  dirtyFiles: {},
}));

export function explorerProject(projectId: string): ExplorerProjectState {
  return useExplorerStore.getState().projects[projectId] ?? EMPTY;
}

export function patchExplorer(
  projectId: string,
  patch:
    | Partial<ExplorerProjectState>
    | ((current: ExplorerProjectState) => Partial<ExplorerProjectState>),
): void {
  useExplorerStore.setState((state) => {
    const current = state.projects[projectId] ?? EMPTY;
    const next = typeof patch === 'function' ? patch(current) : patch;
    return { projects: { ...state.projects, [projectId]: { ...current, ...next } } };
  });
}

/** Opens the search box, or closes it and drops what was typed. */
export function toggleExplorerSearch(projectId: string, open?: boolean): void {
  patchExplorer(projectId, (current) => ({
    search: (open ?? current.search === null) ? (current.search ?? '') : null,
  }));
}

export function setFolderOpen(projectId: string, path: string, open: boolean): void {
  patchExplorer(projectId, (current) => ({ open: { ...current.open, [path]: open } }));
}

/** Selects rows. The last one becomes the focused row unless `focused` says otherwise. */
export function selectRows(
  projectId: string,
  paths: string[],
  options: { focused?: string | null; anchor?: string | null; focus?: boolean } = {},
): void {
  const focused = options.focused !== undefined ? options.focused : (paths.at(-1) ?? null);
  patchExplorer(projectId, (current) => ({
    selected: paths,
    focused,
    anchor: options.anchor !== undefined ? options.anchor : focused,
    pendingFocus: options.focus ? focused : current.pendingFocus,
  }));
}

/** Rewrites every remembered path after a rename or move, so rows stay open and selected. */
export function remapExplorerPaths(projectId: string, from: string, to: string): void {
  const remap = (path: string): string => remapPath(path, from, to) ?? path;
  patchExplorer(projectId, (current) => ({
    open: Object.fromEntries(Object.entries(current.open).map(([path, v]) => [remap(path), v])),
    selected: current.selected.map(remap),
    focused: current.focused ? remap(current.focused) : null,
    anchor: current.anchor ? remap(current.anchor) : null,
  }));
  useExplorerStore.setState((state) => {
    const clipboard = state.clipboard;
    if (!clipboard || clipboard.projectId !== projectId) return state;
    return { clipboard: { ...clipboard, paths: clipboard.paths.map(remap) } };
  });
}

/** Forgets deleted paths wherever the explorer remembered them. */
export function forgetExplorerPaths(projectId: string, removed: string[]): void {
  const gone = (path: string): boolean => removed.some((r) => isSameOrInside(path, r));
  patchExplorer(projectId, (current) => ({
    open: Object.fromEntries(Object.entries(current.open).filter(([path]) => !gone(path))),
    selected: current.selected.filter((path) => !gone(path)),
    focused: current.focused && gone(current.focused) ? null : current.focused,
    anchor: current.anchor && gone(current.anchor) ? null : current.anchor,
  }));
  useExplorerStore.setState((state) => {
    const clipboard = state.clipboard;
    if (!clipboard || clipboard.projectId !== projectId) return state;
    const paths = clipboard.paths.filter((path) => !gone(path));
    return { clipboard: paths.length > 0 ? { ...clipboard, paths } : null };
  });
}

export function setFileDirty(path: string, dirty: boolean): void {
  useExplorerStore.setState((state) => {
    if (Boolean(state.dirtyFiles[path]) === dirty) return state;
    const dirtyFiles = { ...state.dirtyFiles };
    if (dirty) dirtyFiles[path] = true;
    else delete dirtyFiles[path];
    return { dirtyFiles };
  });
}
