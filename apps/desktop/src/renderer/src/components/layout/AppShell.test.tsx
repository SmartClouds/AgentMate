import type { AppSettings } from '@runova/core';
import { act, screen, waitFor } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import { progressEvent, runResult, SITE_ID } from '@/components/deploy/files/testing/fixtures';
import { queryKeys } from '@/lib/queryKeys';
import { selectSiteRun, useDeployFilesRunStore } from '@/stores/deployFilesRunStore';
import { useTerminalStore } from '@/stores/terminalStore';
import { renderWithProviders } from '../../../../test/renderer/renderWithProviders';

/**
 * The shell, for the one choice it makes itself: where the main menu goes. The sidebar and the
 * top menu bar are tested on their own; this pins down that the setting picks exactly one of
 * them, that the sidebar's fold button goes with the sidebar, and that a saved change takes
 * effect without a reload.
 *
 * Everything the shell hosts that has nothing to do with the menu (the workspace, the terminal
 * drawer, the dialogs, the status bar) is stubbed out, as are the app-wide listeners it starts.
 * The drawer's stub still says where the shell put it, for the layout tests at the end.
 */

const toast = vi.hoisted(() =>
  Object.assign(vi.fn(), {
    success: vi.fn(),
    error: vi.fn(),
    info: vi.fn(),
    warning: vi.fn(),
    dismiss: vi.fn(),
  }),
);
vi.mock('sonner', () => ({ toast, Toaster: () => null }));

vi.mock('@/components/askAi/AskAiModal', () => ({ AskAiModal: () => null }));
vi.mock('@/components/search/CommandPalette', () => ({ CommandPalette: () => null }));
vi.mock('@/components/terminal/RunningClisDialog', () => ({ RunningClisDialog: () => null }));
// A stand-in that says where the shell put it; the drawer's own frame is tested beside it.
vi.mock('@/components/terminal/TerminalDrawer', () => ({
  TerminalDrawer: ({ placement }: { placement?: string }) => (
    <section aria-label="Terminal" data-placement={placement} />
  ),
}));
// The window's one SFTP conflict dialog; the host has tests of its own.
vi.mock('@/components/sftp/SftpConflictHost', () => ({
  SftpConflictHost: () => <div data-testid="sftp-conflict-host" />,
}));
vi.mock('@/components/toast/ToastHistoryPanel', () => ({ ToastHistoryPanel: () => null }));
vi.mock('@/components/UpdateManager', () => ({ UpdateStatusChip: () => null }));
vi.mock('@/components/workspace/WorkspaceHeaderActions', () => ({
  WorkspaceHeaderActions: () => null,
}));
vi.mock('@/components/workspace/WorkspaceHost', () => ({ WorkspaceHost: () => null }));
vi.mock('./StatusBar', () => ({ StatusBar: () => null }));
vi.mock('./LoadingOverlay', () => ({ LoadingOverlay: () => null }));

vi.mock('@/hooks/useGlobalShortcuts', () => ({ useGlobalShortcuts: () => undefined }));
vi.mock('@/hooks/useVaultEvents', () => ({ useVaultEvents: () => undefined }));
vi.mock('@/hooks/useAppNotificationMessages', () => ({
  useAppNotificationMessages: () => undefined,
}));
vi.mock('@/hooks/useScheduledTaskRunner', () => ({ useScheduledTaskRunner: () => undefined }));
vi.mock('@/hooks/usePetDragGuard', () => ({ usePetDragGuard: () => undefined }));
vi.mock('@/hooks/useRememberRoute', () => ({ useRememberRoute: () => undefined }));
vi.mock('@/lib/terminal/runSessionFeed', () => ({ startRunSessionFeed: () => () => undefined }));
vi.mock('@/stores/agentStatusStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/agentStatusStore')>()),
  initAgentStatus: () => undefined,
}));
vi.mock('@/stores/sshAgentStore', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/stores/sshAgentStore')>()),
  initSshAgentStatus: () => undefined,
}));

// The shell scrolls the page back to the top on every route change, and jsdom has no scrolling.
Element.prototype.scrollTo = () => undefined;

const { AppShell } = await import('./AppShell');

/** Only the field the shell reads. */
function settingsWith(menuPosition: AppSettings['menuPosition']): AppSettings {
  return { menuPosition } as AppSettings;
}

/** Renders the shell and waits for its settings read, so what is on screen is the saved choice. */
async function renderShell(menuPosition: AppSettings['menuPosition'], route = '/usage') {
  const view = renderWithProviders(<AppShell />, {
    route,
    bridge: { 'settings.get': settingsWith(menuPosition) },
  });
  await waitFor(() =>
    expect(view.queryClient.getQueryState(queryKeys.settings)?.status).toBe('success'),
  );
  return view;
}

const sidebar = (): HTMLElement | null => screen.queryByRole('complementary');
const topMenu = (): HTMLElement | null => screen.queryByRole('navigation', { name: 'Main menu' });
const sidebarToggle = (): HTMLElement | null =>
  screen.queryByRole('button', { name: /(Collapse|Hide|Show) sidebar/ });

describe('AppShell main menu position', () => {
  it('shows the sidebar and its fold button when the menu is on the left', async () => {
    await renderShell('left');

    expect(sidebar()).not.toBeNull();
    expect(topMenu()).toBeNull();
    expect(sidebarToggle()).not.toBeNull();
  });

  it('swaps the sidebar for the top menu bar when the menu is on top', async () => {
    await renderShell('top');

    expect(topMenu()).not.toBeNull();
    expect(sidebar()).toBeNull();
    // Nothing left to fold away, so the button goes too.
    expect(sidebarToggle()).toBeNull();
  });

  it('moves the menu as soon as the saved setting changes, without a reload', async () => {
    const { queryClient, bridge } = await renderShell('left');
    expect(sidebar()).not.toBeNull();

    // What the Settings page does with the answer to a save. React Query tells its readers on
    // the next tick, hence the wait, but nothing is fetched again.
    act(() => queryClient.setQueryData(queryKeys.settings, settingsWith('top')));
    await waitFor(() => expect(topMenu()).not.toBeNull());
    expect(sidebar()).toBeNull();

    act(() => queryClient.setQueryData(queryKeys.settings, settingsWith('left')));
    await waitFor(() => expect(sidebar()).not.toBeNull());
    expect(topMenu()).toBeNull();
    expect(bridge.$fn('settings.get')).toHaveBeenCalledTimes(1);
  });
});

/**
 * A deploy to an FTP or SFTP site keeps going in main while the user is on another page, so its
 * events are taken in by the shell, which every page sits in.
 */
describe('AppShell FTP and SFTP deploy runs', () => {
  it('takes in a run that finishes while no Deploy page is open', async () => {
    const { bridge } = await renderShell('left', '/usage');
    expect(bridge.$listenerCount('deployFiles.onRunFinished')).toBe(1);
    expect(bridge.$listenerCount('deployFiles.onProgress')).toBe(1);

    act(() => bridge.$emit('deployFiles.onProgress', progressEvent()));
    expect(selectSiteRun(SITE_ID)(useDeployFilesRunStore.getState()).progress).not.toBeNull();
    act(() => bridge.$emit('deployFiles.onRunFinished', runResult()));
    const run = selectSiteRun(SITE_ID)(useDeployFilesRunStore.getState());
    expect(run.progress).toBeNull();
    expect(run.result?.state).toBe('done');
    expect(toast.success).toHaveBeenCalled();
  });
});

/**
 * The terminal drawer used to sit inside the page island: clipped to its corners on a page, and
 * flush edge to edge on the Workspace (where the island is a plain box). It is now a sibling of
 * the page in the same page area, so it is one more island on every route.
 */
describe('AppShell SFTP conflicts', () => {
  it('mounts the one conflict dialog host of the window, whatever page is open', async () => {
    await renderShell('left', '/usage');
    expect(screen.getAllByTestId('sftp-conflict-host')).toHaveLength(1);
  });
});

describe('AppShell terminal drawer', () => {
  const drawer = (): HTMLElement => screen.getByRole('region', { name: 'Terminal' });

  it.each(['left', 'top'] as const)(
    'stacks the drawer under the page island, not inside it (menu %s)',
    async (menuPosition) => {
      await renderShell(menuPosition);

      const page = drawer().previousElementSibling as HTMLElement;
      expect(page).toHaveAttribute('data-page-island');
      expect(page).toHaveClass('chrome-island');
      expect(drawer().closest('.chrome-island')).toBeNull();
      expect(drawer()).toHaveAttribute('data-placement', 'page');
    },
  );

  it('stacks the drawer under the Workspace too, lined up with its panes', async () => {
    await renderShell('left', '/workspace');

    const page = drawer().previousElementSibling as HTMLElement;
    // The Workspace draws its own islands, so the box above the drawer is plain.
    expect(page).not.toHaveAttribute('data-page-island');
    expect(page).not.toHaveClass('chrome-island');
    expect(drawer().closest('.chrome-island')).toBeNull();
    expect(drawer()).toHaveAttribute('data-placement', 'workspace');
    // Same parent as on a page: the page area under the top bar.
    expect(drawer().parentElement).toBe(page.parentElement);
  });

  it('hides the page under a maximized drawer without unmounting it', async () => {
    await renderShell('left', '/workspace');
    const page = drawer().previousElementSibling as HTMLElement;
    expect(page).not.toHaveClass('invisible');

    act(() => useTerminalStore.setState({ isOpen: true, isMaximized: true }));
    expect(page).toHaveClass('invisible');
    expect(drawer().previousElementSibling).toBe(page);

    // Closed, the drawer covers nothing, even if it opens maximized next time.
    act(() => useTerminalStore.setState({ isOpen: false }));
    expect(page).not.toHaveClass('invisible');
    act(() => useTerminalStore.setState({ isMaximized: false }));
  });
});
