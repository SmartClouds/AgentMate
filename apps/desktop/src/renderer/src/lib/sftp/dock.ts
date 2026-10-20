import { terminalMaxHeight, useTerminalStore } from '@/stores/terminalStore';

/**
 * The SSH file manager docked in the terminal drawer (E25 F6). The drawer stays mounted on every
 * page, so a server's files stay one click away while the user works elsewhere. Each server has
 * at most one such tab; it is only a view, so closing it leaves the SFTP session open.
 */

/** Below this the docked panes list only a few rows under their toolbar and column header. */
export const DOCK_MIN_HEIGHT = 380;
/** The share of the window the drawer gets when the file manager docks in a shorter one. */
const DOCK_WINDOW_SHARE = 0.45;

/**
 * The drawer height for a docked file manager: 45% of the window, at least DOCK_MIN_HEIGHT,
 * never more than the drawer may take. A drawer already taller keeps its height.
 */
export function dockDrawerHeight(current: number, windowHeight: number, maxHeight: number): number {
  const wanted = Math.min(
    maxHeight,
    Math.max(DOCK_MIN_HEIGHT, Math.round(windowHeight * DOCK_WINDOW_SHARE)),
  );
  return Math.max(current, wanted);
}

/** The page area the drawer stacks in, as the drawer's own resize measures it. */
function pageAreaHeight(): number {
  const area = document.querySelector('[data-terminal-drawer]')?.parentElement?.clientHeight;
  return area && area > 0 ? area : window.innerHeight;
}

function raiseDrawer(): void {
  const terminal = useTerminalStore.getState();
  const next = dockDrawerHeight(
    terminal.drawerHeight,
    window.innerHeight,
    terminalMaxHeight(pageAreaHeight()),
  );
  if (next !== terminal.drawerHeight) terminal.setDrawerHeight(next);
}

function dockTabOf(serverId: string): string | null {
  return (
    useTerminalStore
      .getState()
      .sessions.find((s) => s.kind === 'sftp' && s.sftpServerId === serverId)?.id ?? null
  );
}

/**
 * The drawer as the first docked server found it, so taking the last one away (Open as page,
 * Open in a new window) gives the user back the drawer they had instead of a tall, empty one.
 */
let drawerBefore: { height: number; open: boolean; raisedTo: number } | null = null;

function hasDockTab(): boolean {
  return useTerminalStore.getState().sessions.some((s) => s.kind === 'sftp');
}

/**
 * Opens the drawer on the server's file manager tab, adding the tab when it has none, and makes
 * a short drawer tall enough to list a screenful of files.
 */
export function openSftpDock(serverId: string, nickname: string): void {
  const first = !hasDockTab();
  const { drawerHeight, isOpen } = useTerminalStore.getState();
  raiseDrawer();
  const terminal = useTerminalStore.getState();
  if (first) {
    drawerBefore = { height: drawerHeight, open: isOpen, raisedTo: terminal.drawerHeight };
  }
  const existing = dockTabOf(serverId);
  if (existing) {
    terminal.setActiveSession(existing);
    terminal.openDrawer();
    return;
  }
  // Named apart from the server's SSH tab, which goes by the nickname alone.
  terminal.openSession({ title: `Files: ${nickname}`, kind: 'sftp', sftpServerId: serverId });
}

/**
 * Removes the server's file manager tab from the drawer, if it has one. When it was the last
 * one, the drawer goes back to the height it had (unless the user resized it since), and closes
 * when it was closed before or has no tab left.
 */
export function closeSftpDock(serverId: string): void {
  const id = dockTabOf(serverId);
  if (!id) return;
  useTerminalStore.getState().closeSession(id);
  if (hasDockTab()) return;
  const before = drawerBefore;
  drawerBefore = null;
  const terminal = useTerminalStore.getState();
  if (before && terminal.drawerHeight === before.raisedTo) terminal.setDrawerHeight(before.height);
  if (terminal.sessions.length === 0 || before?.open === false) {
    terminal.setMaximized(false);
    terminal.closeDrawer();
  }
}
