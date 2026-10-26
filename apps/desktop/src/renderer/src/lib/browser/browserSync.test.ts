import { findGroupOfTab } from '@runova/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useBrowserStore } from '@/stores/browserStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { type FakeBridge, installRunovaBridge } from '../../../../test/renderer/runovaBridge';
import type { BrowserPage } from './browserRuntime';

/**
 * What keeps browser tabs in step with their pages while no pane shows them: titles and
 * addresses go to the workspace store, popups become new tabs next to their opener, and browser
 * shortcuts pressed inside a page reach the tab that owns it.
 */

const pageListeners: ((tabId: string, page: BrowserPage) => void)[] = [];
const byWebContents: Record<number, string> = {};

vi.mock('./browserRuntime', () => ({
  browserRuntime: {
    onPageChange: (listener: (tabId: string, page: BrowserPage) => void) => {
      pageListeners.push(listener);
      return () => pageListeners.splice(pageListeners.indexOf(listener), 1);
    },
    tabForWebContents: (id: number) => byWebContents[id] ?? null,
    dispose: vi.fn(),
  },
}));

const { onBrowserShortcut, startBrowserSync } = await import('./browserSync');

let bridge: FakeBridge;

function workspace() {
  const ws = useWorkspaceStore.getState().workspaces.p1;
  if (!ws) throw new Error('no workspace');
  return ws;
}

beforeEach(() => {
  bridge = installRunovaBridge();
  pageListeners.length = 0;
  for (const key of Object.keys(byWebContents)) delete byWebContents[Number(key)];
  useBrowserStore.setState({ annotations: {}, recentUrls: {} });
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
  useWorkspaceStore.getState().openProject('p1');
});

describe('startBrowserSync', () => {
  it('keeps the tab label and address in step with the page, and remembers the address', () => {
    const stop = startBrowserSync();
    const id = useWorkspaceStore.getState().openBrowser('p1', { url: 'http://localhost:5173/' });
    for (const listener of pageListeners) {
      listener(id, { url: 'http://localhost:5173/docs', title: 'Docs', faviconUrl: null });
    }
    expect(workspace().tabs[id]).toMatchObject({
      url: 'http://localhost:5173/docs',
      title: 'Docs',
    });
    expect(useBrowserStore.getState().recentUrls.p1).toEqual(['http://localhost:5173/docs']);
    stop();
    expect(pageListeners).toHaveLength(0);
  });

  it('opens a popup as a new browser tab in the pane of the page that asked', () => {
    startBrowserSync();
    const first = workspace().focusedGroupId;
    const opener = useWorkspaceStore
      .getState()
      .openBrowser('p1', { url: 'http://localhost:5173/' });
    useWorkspaceStore.getState().splitGroup('p1', first, 'row');
    byWebContents[42] = opener;
    bridge.$emit('browser.onOpenInNewTab', { webContentsId: 42, url: 'https://github.com/login' });
    const created = Object.values(workspace().tabs).find(
      (tab) => tab.kind === 'browser' && tab.url === 'https://github.com/login',
    );
    expect(created).toBeDefined();
    expect(findGroupOfTab(workspace().root, created?.id ?? '')?.id).toBe(first);
  });

  it('ignores a popup from a page it does not know', () => {
    startBrowserSync();
    bridge.$emit('browser.onOpenInNewTab', { webContentsId: 7, url: 'https://github.com/' });
    expect(Object.keys(workspace().tabs)).toHaveLength(0);
  });

  it('hands a shortcut pressed inside a page to that page’s tab', () => {
    startBrowserSync();
    byWebContents[42] = 'web-1';
    const seen: string[] = [];
    const off = onBrowserShortcut('web-1', (shortcut) => seen.push(shortcut));
    const other = vi.fn();
    onBrowserShortcut('web-2', other);
    bridge.$emit('browser.onGuestShortcut', { webContentsId: 42, shortcut: 'pick' });
    off();
    bridge.$emit('browser.onGuestShortcut', { webContentsId: 42, shortcut: 'reload' });
    expect(seen).toEqual(['pick']);
    expect(other).not.toHaveBeenCalled();
  });
});
