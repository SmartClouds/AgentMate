import { findGroupOfTab } from '@runova/core';
import type { GuestShortcut } from '@shared/browserGuest';
import { useBrowserStore } from '@/stores/browserStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { browserRuntime } from './browserRuntime';

/**
 * Keeps browser tabs in step with their pages whether or not a pane shows them. Started once by
 * the workspace: page titles and addresses go to the workspace store (the tab strip and the saved
 * layout read them there), popups open as browser tabs next to their opener, and browser
 * shortcuts pressed inside a page are handed to that page's tab.
 */

type ShortcutListener = (shortcut: GuestShortcut) => void;
const shortcutListeners = new Map<string, Set<ShortcutListener>>();

/** Listens for browser shortcuts pressed while the tab's page has focus. */
export function onBrowserShortcut(tabId: string, listener: ShortcutListener): () => void {
  const set = shortcutListeners.get(tabId) ?? new Set();
  set.add(listener);
  shortcutListeners.set(tabId, set);
  return () => {
    set.delete(listener);
    if (set.size === 0) shortcutListeners.delete(tabId);
  };
}

/** Hands a browser shortcut to a tab, as the app's own keyboard shortcuts do. */
export function emitBrowserShortcut(tabId: string, shortcut: GuestShortcut): void {
  for (const listener of shortcutListeners.get(tabId) ?? []) listener(shortcut);
}

/** The workspace holding a tab, as its key in the store. */
function workspaceOf(tabId: string): string | null {
  const { workspaces } = useWorkspaceStore.getState();
  for (const [projectId, ws] of Object.entries(workspaces)) if (ws.tabs[tabId]) return projectId;
  return null;
}

export function startBrowserSync(): () => void {
  const offPage = browserRuntime.onPageChange((tabId, page) => {
    const projectId = workspaceOf(tabId);
    if (!projectId) return;
    useWorkspaceStore.getState().setBrowserPage(projectId, tabId, page);
    useBrowserStore.getState().rememberUrl(projectId, page.url);
  });

  const offPopup = window.runova.browser.onOpenInNewTab(({ webContentsId, url }) => {
    const opener = browserRuntime.tabForWebContents(webContentsId);
    const projectId = opener ? workspaceOf(opener) : null;
    if (!opener || !projectId) return;
    const state = useWorkspaceStore.getState();
    const ws = state.workspaces[projectId];
    const groupId = ws ? findGroupOfTab(ws.root, opener)?.id : undefined;
    state.openBrowser(projectId, { url, groupId });
  });

  const offShortcut = window.runova.browser.onGuestShortcut(({ webContentsId, shortcut }) => {
    const tabId = browserRuntime.tabForWebContents(webContentsId);
    if (tabId) emitBrowserShortcut(tabId, shortcut);
  });

  return () => {
    offPage();
    offPopup();
    offShortcut();
  };
}
