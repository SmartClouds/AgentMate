import {
  formatShortcut,
  isMacPlatform,
  type KeyEventLike,
  matchesShortcut,
  type Shortcut,
} from '@/lib/shortcuts';

export type ExplorerCommand =
  | 'rename'
  | 'delete'
  | 'deletePermanently'
  | 'copy'
  | 'cut'
  | 'paste'
  | 'open'
  | 'selectAll'
  | 'copyPath'
  | 'copyRelativePath'
  | 'reveal'
  | 'find'
  | 'addToChat';

type Bindings = Record<ExplorerCommand, Shortcut[]>;

/**
 * The explorer's keys, as VS Code binds them on each system. They only apply while focus is
 * in the tree, so bare keys like Delete and F2 are safe here where the global shortcut
 * registry would reject them. The first binding is the one menus show.
 */
const WINDOWS_LINUX: Bindings = {
  rename: [{ code: 'F2' }],
  delete: [{ code: 'Delete' }],
  deletePermanently: [{ code: 'Delete', shift: true }],
  copy: [{ code: 'KeyC', mod: true }],
  cut: [{ code: 'KeyX', mod: true }],
  paste: [{ code: 'KeyV', mod: true }],
  open: [{ code: 'Enter' }, { code: 'NumpadEnter' }],
  selectAll: [{ code: 'KeyA', mod: true }],
  copyPath: [{ code: 'KeyC', shift: true, alt: true }],
  copyRelativePath: [{ code: 'KeyC', mod: true, shift: true, alt: true }],
  reveal: [{ code: 'KeyR', shift: true, alt: true }],
  find: [{ code: 'KeyF', mod: true }],
  addToChat: [{ code: 'KeyL', mod: true }],
};

const MAC: Bindings = {
  rename: [{ code: 'Enter' }, { code: 'NumpadEnter' }, { code: 'F2' }],
  delete: [{ code: 'Backspace', mod: true }, { code: 'Delete' }],
  deletePermanently: [{ code: 'Backspace', mod: true, alt: true }],
  copy: [{ code: 'KeyC', mod: true }],
  cut: [{ code: 'KeyX', mod: true }],
  paste: [{ code: 'KeyV', mod: true }],
  open: [{ code: 'ArrowDown', mod: true }],
  selectAll: [{ code: 'KeyA', mod: true }],
  copyPath: [{ code: 'KeyC', mod: true, alt: true }],
  copyRelativePath: [{ code: 'KeyC', mod: true, alt: true, shift: true }],
  reveal: [{ code: 'KeyR', mod: true, alt: true }],
  find: [{ code: 'KeyF', mod: true }],
  addToChat: [{ code: 'KeyL', mod: true }],
};

function bindings(): Bindings {
  return isMacPlatform() ? MAC : WINDOWS_LINUX;
}

export function explorerCommandFor(event: KeyEventLike): ExplorerCommand | null {
  for (const [command, shortcuts] of Object.entries(bindings()) as [
    ExplorerCommand,
    Shortcut[],
  ][]) {
    if (shortcuts.some((shortcut) => matchesShortcut(event, shortcut))) return command;
  }
  return null;
}

export function explorerShortcutLabel(command: ExplorerCommand): string {
  const shortcut = bindings()[command][0];
  return shortcut ? formatShortcut(shortcut) : '';
}

/** Ctrl on Windows and Linux, Cmd on macOS: the key that adds a row to the selection. */
export function isToggleSelectClick(event: { ctrlKey: boolean; metaKey: boolean }): boolean {
  return isMacPlatform() ? event.metaKey : event.ctrlKey;
}

/** Holding this while dropping copies instead of moving (Ctrl, or Option on macOS). */
export function isCopyDrag(event: { ctrlKey: boolean; altKey: boolean }): boolean {
  return isMacPlatform() ? event.altKey : event.ctrlKey;
}

export function revealLabel(): string {
  const platform = window.runova.platform;
  if (platform === 'darwin') return 'Reveal in Finder';
  if (platform === 'win32') return 'Reveal in File Explorer';
  return 'Open Containing Folder';
}

export function trashName(): string {
  return window.runova.platform === 'win32' ? 'Recycle Bin' : 'Trash';
}
