import { useEffect } from 'react';
import { useLocation, useNavigate } from 'react-router-dom';
import {
  digitOf,
  type GlobalShortcutCommandId,
  type WorkspaceShortcutCommandId,
} from '@/lib/shortcuts';
import { isWorkspacePath, workspaceCommands } from '@/lib/workspace/commands';
import { togglePauseActiveRun } from '@/stores/runPauseStore';
import { stopActiveRun } from '@/stores/runSessionStore';
import { useSearchStore } from '@/stores/searchStore';
import { commandForEvent, useShortcutStore } from '@/stores/shortcutStore';
import { useTerminalStore } from '@/stores/terminalStore';

function isTypingTarget(target: EventTarget | null): boolean {
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) return true;
  return target instanceof HTMLElement && target.isContentEditable;
}

function isDialogOpen(): boolean {
  return document.querySelector('[role="dialog"][data-state="open"]') !== null;
}

/** Routing away from under an open dialog would strand it over the new page. */
const BLOCKED_BY_DIALOG = new Set<GlobalShortcutCommandId>(['nav.projects', 'nav.help']);

const WORKSPACE_ACTIONS: Record<WorkspaceShortcutCommandId, (event: KeyboardEvent) => void> = {
  'workspace.goToTab': (event) => workspaceCommands.goToTab(digitOf(event.code) ?? 1),
  'workspace.launchAgent': (event) => void workspaceCommands.launchAgent(digitOf(event.code) ?? 1),
  'workspace.buildPrompt': workspaceCommands.buildPrompt,
  'workspace.nextChange': () => workspaceCommands.diffChange('next'),
  'workspace.prevChange': () => workspaceCommands.diffChange('previous'),
  'workspace.newTab': workspaceCommands.openLauncher,
  'workspace.newBrowser': workspaceCommands.newBrowser,
  'workspace.pickElement': workspaceCommands.pickElement,
  'workspace.closeTab': workspaceCommands.closeActiveTab,
  'workspace.splitRight': () => workspaceCommands.split('row'),
  'workspace.splitDown': () => workspaceCommands.split('column'),
  'workspace.focusLeft': () => workspaceCommands.focusPane('left'),
  'workspace.focusRight': () => workspaceCommands.focusPane('right'),
  'workspace.focusUp': () => workspaceCommands.focusPane('up'),
  'workspace.focusDown': () => workspaceCommands.focusPane('down'),
  'workspace.nextTab': () => workspaceCommands.cycleTab(1),
  'workspace.prevTab': () => workspaceCommands.cycleTab(-1),
  'workspace.zoomPane': workspaceCommands.toggleZoom,
  'workspace.toggleGitPanel': workspaceCommands.toggleGitPanel,
  'workspace.newWorktree': workspaceCommands.newWorktree,
  'workspace.run': workspaceCommands.runProject,
  'workspace.search': workspaceCommands.openSearch,
};

/**
 * Runs the app-wide shortcuts. Mounted once by the shell.
 *
 * The listener sits on `window` in the bubble phase on purpose. Dialogs handle
 * their keys through React, whose listener lives on the root container further
 * down the tree, so a dialog that binds the same combination (the prompt
 * builder's Ctrl+T, for one) gets there first and calls `preventDefault`. That
 * parks this handler, which is what gives the open modal the final say.
 */
export function useGlobalShortcuts(): void {
  const navigate = useNavigate();
  const { pathname } = useLocation();
  const onWorkspace = isWorkspacePath(pathname);
  const toggleSearch = useSearchStore((s) => s.toggle);
  const toggleDrawer = useTerminalStore((s) => s.toggleDrawer);
  const openDefaultSession = useTerminalStore((s) => s.openDefaultSession);

  useEffect(() => {
    const actions: Record<GlobalShortcutCommandId, () => void> = {
      // The drawer is the general terminal, so it works the same on every page.
      'terminal.toggle': toggleDrawer,
      'terminal.new': () => void openDefaultSession(),
      'terminal.stopRun': stopActiveRun,
      'terminal.togglePauseRun': () => void togglePauseActiveRun(),
      'nav.projects': () => navigate('/projects'),
      'nav.help': () => navigate('/help'),
      'search.toggle': toggleSearch,
    };

    function onKeyDown(event: KeyboardEvent): void {
      if (event.defaultPrevented || event.isComposing) return;
      const overrides = useShortcutStore.getState().overrides;
      const typing = isTypingTarget(event.target);

      if (onWorkspace && !isDialogOpen()) {
        const workspaceId = commandForEvent(event, overrides, typing, 'workspace');
        const diffKey =
          workspaceId === 'workspace.nextChange' || workspaceId === 'workspace.prevChange';
        if (workspaceId && (!diffKey || workspaceCommands.focusedTabIsDiff())) {
          event.preventDefault();
          WORKSPACE_ACTIONS[workspaceId](event);
          return;
        }
      }

      const id = commandForEvent(event, overrides, typing);
      if (!id) return;
      if (BLOCKED_BY_DIALOG.has(id) && isDialogOpen()) return;
      event.preventDefault();
      actions[id]();
    }

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [navigate, onWorkspace, openDefaultSession, toggleDrawer, toggleSearch]);
}
