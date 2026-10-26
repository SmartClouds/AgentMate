import type { PaneGroupNode, Project } from '@runova/core';
import { fireEvent, screen, within } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useExplorerStore } from '@/stores/explorerStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';
import { PaneGroup } from './PaneGroup';

// The runtime owns real xterm instances, which have no place in jsdom. The session store that
// lives in the same module stays real, since the tabs read their status from it.
vi.mock('@/lib/terminal/terminalRuntime', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/terminal/terminalRuntime')>();
  return {
    ...actual,
    terminalRuntime: {
      ...actual.terminalRuntime,
      mount: vi.fn(),
      unmount: vi.fn(),
      focus: vi.fn(),
    },
  };
});

// The editor body pulls in Monaco and its workers. These tests are about the tab strip.
vi.mock('./FileTab', () => ({ default: () => null }));
vi.mock('./browser/BrowserTab', () => ({
  default: ({ tabId }: { tabId: string }) => <div data-testid="browser-body">{tabId}</div>,
}));
const browserRuntime = vi.hoisted(() => ({
  setDragging: vi.fn(),
  reload: vi.fn(),
  dispose: vi.fn(),
}));
vi.mock('@/lib/browser/browserRuntime', () => ({ browserRuntime }));

const project = { id: 'p1', name: 'App', folderPath: 'C:\\work\\app' } as Project;
const indexPath = 'C:\\work\\app\\src\\index.ts';

/** Reads the workspace from the store on every render, the way the pane tree does. */
function Harness(): React.JSX.Element | null {
  const workspace = useWorkspaceStore((s) => s.workspaces.p1);
  if (!workspace || workspace.root.type !== 'group') return null;
  return (
    <PaneGroup
      project={project}
      workspace={workspace}
      group={workspace.root as PaneGroupNode}
      multiPane={false}
    />
  );
}

beforeEach(() => {
  useWorkspaceStore.getState().openProject('p1');
  useWorkspaceStore.getState().addTerminal('p1', {
    title: 'Claude Code',
    cwd: 'C:\\work\\app',
    cliId: 'claude-code',
  });
  useWorkspaceStore.getState().openFile('p1', indexPath);
});

describe('PaneGroup', () => {
  it('renders a file tab next to a terminal tab', () => {
    renderWithProviders(<Harness />);
    expect(screen.getByRole('tab', { name: /Claude Code/ })).toBeInTheDocument();
    expect(screen.getByRole('tab', { name: /index\.ts/ })).toBeInTheDocument();
  });

  it('marks an image tab with a picture icon, and a code file with a file icon', () => {
    // Both pinned, so the picture opens beside the code file instead of replacing the preview.
    useWorkspaceStore.getState().openFile('p1', indexPath, { pin: true });
    useWorkspaceStore.getState().openFile('p1', 'C:\\work\\app\\assets\\logo.png', { pin: true });
    renderWithProviders(<Harness />);

    const imageTab = screen.getByRole('tab', { name: /logo\.png/ });
    expect(imageTab.querySelector('[data-icon="image"]')).toBeInTheDocument();
    const codeTab = screen.getByRole('tab', { name: /index\.ts/ });
    expect(codeTab.querySelector('[data-icon="file"]')).toBeInTheDocument();
  });

  it('shows scroll arrows only once the tabs no longer fit', () => {
    const scrollBy = vi.fn();
    HTMLElement.prototype.scrollBy = scrollBy;
    const scrollWidth = vi.spyOn(HTMLElement.prototype, 'scrollWidth', 'get').mockReturnValue(100);
    const clientWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(100);
    try {
      const { unmount } = renderWithProviders(<Harness />);
      expect(screen.queryByRole('button', { name: 'Scroll tabs right' })).not.toBeInTheDocument();
      unmount();

      scrollWidth.mockReturnValue(400);
      renderWithProviders(<Harness />);
      // At the start of the strip only the right arrow has anywhere to go.
      expect(screen.getByRole('button', { name: 'Scroll tabs left' })).toBeDisabled();
      const right = screen.getByRole('button', { name: 'Scroll tabs right' });
      expect(right).toBeEnabled();
      fireEvent.click(right);
      expect(scrollBy).toHaveBeenCalledWith({ left: 120, behavior: 'smooth' });
      // The new tab button sits outside the scrolling tabs, so it never scrolls out of reach.
      expect(
        within(screen.getByRole('tablist', { name: 'Tabs' })).queryByRole('button', {
          name: 'New tab',
        }),
      ).not.toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'New tab' })).toBeInTheDocument();
    } finally {
      scrollWidth.mockRestore();
      clientWidth.mockRestore();
      Reflect.deleteProperty(HTMLElement.prototype, 'scrollBy');
    }
  });

  it('slides the tabs out of the way of a dragged tab, then moves it there on drop', () => {
    // jsdom does no layout, so each slot is 100px wide with a 2px gap.
    const slotIndex = (el: HTMLElement): number =>
      el.dataset.tabSlot && el.parentElement
        ? Array.from(el.parentElement.querySelectorAll(':scope > [data-tab-slot]')).indexOf(el)
        : -1;
    const left = vi.spyOn(HTMLElement.prototype, 'offsetLeft', 'get').mockImplementation(function (
      this: HTMLElement,
    ) {
      return Math.max(slotIndex(this), 0) * 102;
    });
    const width = vi
      .spyOn(HTMLElement.prototype, 'offsetWidth', 'get')
      .mockImplementation(function (this: HTMLElement) {
        return slotIndex(this) === -1 ? 0 : 100;
      });
    try {
      renderWithProviders(<Harness />);
      const workspace = useWorkspaceStore.getState().workspaces.p1;
      const terminal = screen.getByRole('tab', { name: /Claude Code/ });
      const terminalId = terminal.dataset.tabId as string;
      const tablist = screen.getByRole('tablist', { name: 'Tabs' });
      const slots = (): HTMLElement[] =>
        Array.from(tablist.querySelectorAll<HTMLElement>(':scope > [data-tab-slot]'));
      expect(slots().map((slot) => slot.dataset.tabSlot)[0]).toBe(terminalId);

      const dataTransfer = {
        types: ['application/x-runova-tab'],
        setData: vi.fn(),
        getData: () =>
          JSON.stringify({ projectId: 'p1', tabId: terminalId, groupId: workspace?.root.id }),
        effectAllowed: '',
        dropEffect: '',
      };
      const drag = (type: string, clientX = 0): Event =>
        Object.assign(new Event(type, { bubbles: true, cancelable: true }), {
          dataTransfer,
          clientX,
        });
      fireEvent(terminal, drag('dragstart'));
      // Past the middle of the second tab, so the first one belongs after it.
      fireEvent(tablist, drag('dragover', 160));
      expect(slots()[0].style.transform).toBe('translateX(102px)');
      expect(slots()[1].style.transform).toBe('translateX(-102px)');

      fireEvent(tablist, drag('drop', 160));
      expect(slots().map((slot) => slot.dataset.tabSlot)[1]).toBe(terminalId);
      expect(screen.getAllByRole('tab')[1]).toBe(screen.getByRole('tab', { name: /Claude Code/ }));
      window.dispatchEvent(new Event('dragend'));
    } finally {
      left.mockRestore();
      width.mockRestore();
    }
  });

  it('opens the tab menu on a terminal tab', async () => {
    const { user } = renderWithProviders(<Harness />);
    await user.pointer({
      target: screen.getByRole('tab', { name: /Claude Code/ }),
      keys: '[MouseRight]',
    });
    expect(await screen.findByRole('menuitem', { name: 'Rename' })).toBeInTheDocument();
  });
});

describe('PaneGroup file tab menu', () => {
  beforeEach(() => {
    useExplorerStore.setState({ projects: {} });
    useWorkspaceStore.getState().setGitPanel({ activeSection: 'sourceControl' });
  });

  async function openFileTabMenu(name: RegExp = /index\.ts/) {
    const view = renderWithProviders(<Harness />, { bridge: { platform: 'win32' } });
    await view.user.pointer({ target: screen.getByRole('tab', { name }), keys: '[MouseRight]' });
    return view;
  }

  it('shows the file in the system file manager', async () => {
    const { user, bridge } = await openFileTabMenu();
    await user.click(await screen.findByRole('menuitem', { name: 'Reveal in File Explorer' }));
    expect(bridge.$fn('explorer.revealInOs')).toHaveBeenCalledWith('p1', indexPath);
  });

  it('switches the side panel to the explorer and selects the file there', async () => {
    const { user } = await openFileTabMenu();
    await user.click(await screen.findByRole('menuitem', { name: 'Reveal in Explorer View' }));
    expect(useWorkspaceStore.getState().gitPanel.activeSection).toBe('explorer');
    const tree = useExplorerStore.getState().projects.p1;
    expect(tree?.selected).toEqual([indexPath]);
    expect(tree?.open['C:\\work\\app\\src']).toBe(true);
  });

  it('copies the absolute and the project relative path', async () => {
    const { user } = await openFileTabMenu();
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Path' }));
    await vi.waitFor(async () => expect(await navigator.clipboard.readText()).toBe(indexPath));

    await user.pointer({
      target: screen.getByRole('tab', { name: /index\.ts/ }),
      keys: '[MouseRight]',
    });
    await user.click(await screen.findByRole('menuitem', { name: 'Copy Relative Path' }));
    await vi.waitFor(async () =>
      expect(await navigator.clipboard.readText()).toBe('src\\index.ts'),
    );
  });

  it('closes the tab', async () => {
    const { user } = await openFileTabMenu();
    await user.click(await screen.findByRole('menuitem', { name: 'Close' }));
    expect(screen.queryByRole('tab', { name: /index\.ts/ })).not.toBeInTheDocument();
  });

  it('keeps the reveal actions off for a file outside the project', async () => {
    useWorkspaceStore.getState().openFile('p1', 'D:\\elsewhere\\notes.md', { pin: true });
    await openFileTabMenu(/notes\.md/);
    for (const name of ['Reveal in File Explorer', 'Reveal in Explorer View']) {
      expect(await screen.findByRole('menuitem', { name })).toHaveAttribute('data-disabled');
    }
  });
});

describe('PaneGroup browser tab', () => {
  function openBrowser(url = 'http://localhost:5173/pricing'): string {
    const id = useWorkspaceStore.getState().openBrowser('p1', { url });
    useWorkspaceStore
      .getState()
      .setBrowserPage('p1', id, { url, title: 'Pricing | Shop', faviconUrl: null });
    return id;
  }

  it('names the tab after its page and shows the page', async () => {
    const id = openBrowser();
    renderWithProviders(<Harness />);
    const tab = screen.getByRole('tab', { name: /Pricing \| Shop/ });
    expect(tab.querySelector('[data-icon="globe"]')).toBeInTheDocument();
    expect(await screen.findByTestId('browser-body')).toHaveTextContent(id);
  });

  it('calls a tab without a page a new tab', () => {
    useWorkspaceStore.getState().openBrowser('p1');
    renderWithProviders(<Harness />);
    expect(screen.getByRole('tab', { name: /New tab/ })).toBeInTheDocument();
  });

  it('shows the site’s icon once the page has one', () => {
    const id = openBrowser();
    useWorkspaceStore.getState().setBrowserPage('p1', id, {
      url: 'http://localhost:5173/pricing',
      title: 'Pricing | Shop',
      faviconUrl: 'http://localhost:5173/favicon.ico',
    });
    renderWithProviders(<Harness />);
    const tab = screen.getByRole('tab', { name: /Pricing \| Shop/ });
    expect(tab.querySelector('img')).toHaveAttribute('src', 'http://localhost:5173/favicon.ico');
  });

  it('offers reload, copy address and the system browser in its menu', async () => {
    const id = openBrowser();
    const { user, bridge } = renderWithProviders(<Harness />);
    await user.pointer({
      target: screen.getByRole('tab', { name: /Pricing \| Shop/ }),
      keys: '[MouseRight]',
    });
    await user.click(await screen.findByRole('menuitem', { name: 'Reload' }));
    expect(browserRuntime.reload).toHaveBeenCalledWith(id, false);
    await user.pointer({
      target: screen.getByRole('tab', { name: /Pricing \| Shop/ }),
      keys: '[MouseRight]',
    });
    await user.click(await screen.findByRole('menuitem', { name: 'Open in system browser' }));
    expect(bridge.$fn('shell.openExternal')).toHaveBeenCalledWith('http://localhost:5173/pricing');
  });

  it('moves pages out of the way while a tab is dragged', () => {
    openBrowser();
    renderWithProviders(<Harness />);
    const tab = screen.getByRole('tab', { name: /Pricing \| Shop/ });
    const dataTransfer = { setData: vi.fn(), effectAllowed: '' };
    tab.dispatchEvent(Object.assign(new Event('dragstart', { bubbles: true }), { dataTransfer }));
    expect(browserRuntime.setDragging).toHaveBeenLastCalledWith(true);
    window.dispatchEvent(new Event('dragend'));
    expect(browserRuntime.setDragging).toHaveBeenLastCalledWith(false);
  });
});
