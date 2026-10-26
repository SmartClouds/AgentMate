// @vitest-environment jsdom
import type { Project } from '@runova/core';
import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { BrowserNavState } from '@/lib/browser/browserRuntime';
import type { PickPayload, PickResult } from '@/lib/browser/types';
import { useBrowserStore } from '@/stores/browserStore';
import { useWorkspaceStore, type WorkspaceBrowserTab } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../../test/renderer/renderWithProviders';

/**
 * The browser tab as a whole, with the webview runtime replaced by a stand-in: jsdom has no
 * webview, and what matters here is what the tab asks of the page and what the user sees.
 */

const payload: PickPayload = {
  page: {
    url: 'http://localhost:5173/',
    title: 'Home',
    viewport: { width: 1280, height: 800 },
    dpr: 1,
  },
  element: {
    tagName: 'button',
    selector: 'section.plans > button.buy',
    path: 'main > section.plans > button.buy',
    role: 'button',
    name: 'Buy now',
    text: 'Buy now',
    html: '<button class="buy">Buy now</button>',
    attributes: {},
    styles: {},
    react: { components: ['Pricing', 'BuyButton'], source: null },
    rectViewport: { x: 100, y: 200, width: 96, height: 32 },
    rectPage: { x: 100, y: 200, width: 96, height: 32 },
    fixed: false,
  },
};

const runtime = vi.hoisted(() => {
  const listeners = new Set<() => void>();
  const ready = new Set<() => void>();
  let state: BrowserNavState = {
    url: '',
    title: '',
    faviconUrl: null,
    loading: false,
    canGoBack: false,
    canGoForward: false,
    webContentsId: 42,
    error: null,
  };
  const picks: ((result: PickResult) => void)[] = [];
  const overlay = { el: null as HTMLElement | null };
  return {
    picks,
    setState(next: Partial<BrowserNavState>) {
      state = { ...state, ...next };
      for (const listener of listeners) listener();
    },
    fireReady() {
      for (const listener of ready) listener();
    },
    api: {
      ensure: vi.fn(),
      attach: vi.fn(() => () => undefined),
      overlay: vi.fn(() => {
        if (!overlay.el) {
          overlay.el = document.createElement('div');
          document.body.appendChild(overlay.el);
        }
        return overlay.el;
      }),
      frame: vi.fn(() => ({ left: 0, top: 0, scale: 1 })),
      state: () => state,
      subscribe: (_tabId: string, listener: () => void) => {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      onDocumentReady: (_tabId: string, listener: () => void) => {
        ready.add(listener);
        return () => ready.delete(listener);
      },
      setViewport: vi.fn(),
      navigate: vi.fn(),
      back: vi.fn(),
      forward: vi.fn(),
      reload: vi.fn(),
      stop: vi.fn(),
      focus: vi.fn(),
      openDevTools: vi.fn(),
      tabForWebContents: vi.fn(() => 'web-1'),
      onPageChange: vi.fn(() => () => undefined),
      picker: vi.fn((_tabId: string, call: string): Promise<unknown> => {
        if (call === 'awaitPick()') return new Promise((resolve) => picks.push(resolve));
        return Promise.resolve(true);
      }),
    },
    reset() {
      picks.length = 0;
      listeners.clear();
      ready.clear();
      overlay.el?.remove();
      overlay.el = null;
      state = {
        url: '',
        title: '',
        faviconUrl: null,
        loading: false,
        canGoBack: false,
        canGoForward: false,
        webContentsId: 42,
        error: null,
      };
    },
  };
});

vi.mock('@/lib/browser/browserRuntime', () => ({ browserRuntime: runtime.api }));

const { default: BrowserTab } = await import('./BrowserTab');

const project = { id: 'p1', name: 'Shop', folderPath: '/repo', cliId: null } as Project;

function openTab(url: string): WorkspaceBrowserTab {
  const store = useWorkspaceStore.getState();
  store.openProject('p1');
  const id = store.openBrowser('p1', { url });
  runtime.setState({ url });
  return currentTab(id);
}

function currentTab(id: string): WorkspaceBrowserTab {
  return useWorkspaceStore.getState().workspaces.p1?.tabs[id] as WorkspaceBrowserTab;
}

function render(tab: WorkspaceBrowserTab) {
  return renderWithProviders(<BrowserTab project={project} tabId={tab.id} focused />, {
    bridge: {
      'cli.detectAll': [],
      'browser.captureElement': {
        path: '/tmp/element-1.png',
        thumbDataUrl: 'data:image/png;base64,t',
      },
    },
  });
}

async function pick(result: PickResult): Promise<void> {
  await waitFor(() => expect(runtime.picks.length).toBeGreaterThan(0));
  await act(async () => {
    runtime.picks.shift()?.(result);
  });
}

function pickerCalls(): string[] {
  return runtime.api.picker.mock.calls.map(([, call]) => call as string);
}

beforeEach(() => {
  vi.clearAllMocks();
  runtime.reset();
  useBrowserStore.setState({ annotations: {}, recentUrls: {} });
  useWorkspaceStore.setState({ workspaces: {}, railProjectIds: [], activeProjectId: null });
});

describe('a new browser tab', () => {
  it('starts on its start page and loads what is opened there', async () => {
    const tab = openTab('');
    const { user } = render(tab);
    expect(runtime.api.ensure).not.toHaveBeenCalled();
    await user.type(screen.getByRole('textbox', { name: 'Open a page' }), 'localhost:5173{Enter}');
    expect(currentTab(tab.id).url).toBe('http://localhost:5173/');
  });
});

describe('a browser tab with a page', () => {
  it('lays its page over the pane body at the chosen device size', () => {
    const tab = openTab('http://localhost:5173/');
    render(tab);
    expect(runtime.api.ensure).toHaveBeenCalledWith(tab.id, 'http://localhost:5173/');
    expect(runtime.api.attach).toHaveBeenCalledWith(tab.id, expect.any(HTMLElement));
    expect(runtime.api.setViewport).toHaveBeenCalledWith(tab.id, 'responsive');
  });

  it('shows why the page failed, and tries again', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user } = render(tab);
    act(() =>
      runtime.setState({
        error: { code: -102, description: 'ERR_CONNECTION_REFUSED', url: 'http://localhost:5173/' },
      }),
    );
    expect(screen.getByText('Nothing is listening on port 5173')).toBeInTheDocument();
    await user.click(screen.getByRole('button', { name: 'Try again' }));
    expect(runtime.api.reload).toHaveBeenCalledWith(tab.id, false);
  });
});

describe('commenting on an element', () => {
  it('picks an element, takes its screenshot and adds the comment to the tray', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user, bridge } = render(tab);
    await user.click(screen.getByRole('button', { name: /Comment on an element/ }));
    expect(await screen.findByText(/Click an element to comment/)).toBeInTheDocument();
    await waitFor(() => expect(pickerCalls()).toContain('arm()'));

    await pick({ kind: 'pick', payload });
    expect(await screen.findByText('BuyButton button "Buy now"')).toBeInTheDocument();
    expect(pickerCalls()).toContain('freeze()');
    await waitFor(() =>
      expect(bridge.$fn('browser.captureElement')).toHaveBeenCalledWith(
        42,
        payload.element.rectViewport,
        payload.page.viewport,
      ),
    );
    expect(pickerCalls()).toContain('setChromeHidden(true)');
    expect(pickerCalls()).toContain('setChromeHidden(false)');

    await user.type(screen.getByRole('textbox', { name: 'Comment' }), 'Make it full width');
    await user.click(screen.getByRole('button', { name: 'Add comment' }));

    const [annotation] = useBrowserStore.getState().annotations[tab.id] ?? [];
    expect(annotation).toMatchObject({
      comment: 'Make it full width',
      intent: 'change',
      screenshotPath: '/tmp/element-1.png',
      element: { selector: 'section.plans > button.buy' },
    });
    expect(screen.getByRole('list', { name: 'Comments' })).toBeInTheDocument();
    await waitFor(() =>
      expect(pickerCalls().some((call) => call.startsWith('setMarkers([{"n":1'))).toBe(true),
    );
    // Adding keeps the picker going for the next element.
    await waitFor(() => expect(runtime.picks.length).toBeGreaterThan(0));
  });

  it('copies an element on right-click and keeps picking', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user } = render(tab);
    await user.click(screen.getByRole('button', { name: /Comment on an element/ }));
    await pick({ kind: 'copy', payload });
    await waitFor(async () =>
      expect(await navigator.clipboard.readText()).toContain('section.plans > button.buy'),
    );
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull();
    await waitFor(() => expect(runtime.picks.length).toBeGreaterThan(0));
  });

  it('copies with the pick tool, without a card', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user } = render(tab);
    await user.click(screen.getByRole('button', { name: /Pick an element to copy/ }));
    await pick({ kind: 'pick', payload });
    await waitFor(async () => expect(await navigator.clipboard.readText()).toContain('Element on'));
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull();
  });

  it('stops picking when the page says Esc was pressed', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user } = render(tab);
    await user.click(screen.getByRole('button', { name: /Comment on an element/ }));
    await pick({ kind: 'cancel' });
    await waitFor(() => expect(screen.queryByText(/Click an element to comment/)).toBeNull());
    expect(pickerCalls()).toContain('disarm()');
  });

  it('goes back to picking when the card is cancelled', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user } = render(tab);
    await user.click(screen.getByRole('button', { name: /Comment on an element/ }));
    await pick({ kind: 'pick', payload });
    await user.click(await screen.findByRole('button', { name: 'Cancel' }));
    expect(screen.queryByRole('textbox', { name: 'Comment' })).toBeNull();
    expect(screen.getByText(/Click an element to comment/)).toBeInTheDocument();
  });

  it('arms the picker again in a page that navigated', async () => {
    const tab = openTab('http://localhost:5173/');
    const { user } = render(tab);
    await user.click(screen.getByRole('button', { name: /Comment on an element/ }));
    await waitFor(() => expect(pickerCalls().filter((call) => call === 'arm()')).toHaveLength(1));
    act(() => runtime.fireReady());
    await waitFor(() => expect(pickerCalls().filter((call) => call === 'arm()')).toHaveLength(2));
  });
});
