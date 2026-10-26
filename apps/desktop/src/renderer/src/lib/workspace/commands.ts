import type { PaneDirection, Project, SplitDirection, WorktreeInfo } from '@runova/core';
import { findGroup, findNeighborGroup, type PaneRect, parseScopeId } from '@runova/core';
import { create } from 'zustand';
import { emitBrowserShortcut } from '@/lib/browser/browserSync';
import { queryKeys } from '@/lib/queryKeys';
import { queryClient } from '@/queryClient';
import { useCliStore } from '@/stores/cliStore';
import { useWorkspaceSearchStore } from '@/stores/workspaceSearchStore';
import { useWorkspaceStore } from '@/stores/workspaceStore';
import { useWorktreeDialogStore } from '@/stores/worktreeDialogStore';
import { sortAgentChoices } from './agentChoices';
import { launchAgentTab, launchShellTab, projectCliId } from './launch';
import { resolveWorkspaceProject } from './scope';

interface LauncherState {
  /** The pane group whose "+" menu is open, or null. */
  openForGroupId: string | null;
  setOpenFor: (groupId: string | null) => void;
}

/** Lets a keyboard shortcut open the same launcher menu the "+" button does. */
export const useLauncherStore = create<LauncherState>((set) => ({
  openForGroupId: null,
  setOpenFor: (groupId) => set({ openForGroupId: groupId }),
}));

interface PromptDialogState {
  /** The project whose Build Prompt dialog is open from the workspace, or null. */
  projectId: string | null;
  /** The pane an "Open in agent" launch from that dialog lands in. */
  groupId: string | null;
  open: (projectId: string, groupId: string | null) => void;
  close: () => void;
}

export const usePromptDialogStore = create<PromptDialogState>((set) => ({
  projectId: null,
  groupId: null,
  open: (projectId, groupId) => set({ projectId, groupId }),
  close: () => set({ projectId: null, groupId: null }),
}));

/** Window event the focused diff tab listens for; `detail` is `'next'` or `'previous'`. */
export const DIFF_CHANGE_EVENT = 'runova:diff-change';

/** Window event the header's Run button listens for, so a shortcut presses it. */
export const RUN_PROJECT_EVENT = 'runova:run-project';

export function isWorkspacePath(pathname: string): boolean {
  return pathname === '/workspace' || pathname.startsWith('/workspace/');
}

/** The project on screen, pointed at the worktree when a worktree's workspace is showing. */
function activeProject(): Project | null {
  const scopeId = useWorkspaceStore.getState().activeProjectId;
  if (!scopeId) return null;
  const { projectId } = parseScopeId(scopeId);
  const projects = queryClient.getQueryData<Project[]>(queryKeys.projects) ?? [];
  const worktrees = queryClient.getQueryData<WorktreeInfo[]>(queryKeys.worktrees(projectId));
  return resolveWorkspaceProject(projects, { [projectId]: worktrees }, scopeId);
}

function activeWorkspace() {
  const state = useWorkspaceStore.getState();
  const projectId = state.activeProjectId;
  const workspace = projectId ? state.workspaces[projectId] : undefined;
  return projectId && workspace ? { projectId, workspace } : null;
}

/** Where each pane group currently sits on screen, for moving focus by direction. */
function groupRects(): Record<string, PaneRect> {
  const rects: Record<string, PaneRect> = {};
  for (const el of document.querySelectorAll<HTMLElement>('[data-pane-group-id]')) {
    const rect = el.getBoundingClientRect();
    if (rect.width === 0 || rect.height === 0) continue;
    const id = el.dataset.paneGroupId;
    if (id) rects[id] = { x: rect.left, y: rect.top, width: rect.width, height: rect.height };
  }
  return rects;
}

export const workspaceCommands = {
  openLauncher(): void {
    const current = activeWorkspace();
    if (current) useLauncherStore.getState().setOpenFor(current.workspace.focusedGroupId);
  },

  newShell(): void {
    const project = activeProject();
    const current = activeWorkspace();
    if (project && current) launchShellTab(project, undefined, current.workspace.focusedGroupId);
  },

  /**
   * Starts the agent at this position of the "+" menu (1 is the first) in the focused pane.
   * Positions past the installed agents do nothing, the way going to a missing tab does.
   */
  async launchAgent(position: number): Promise<void> {
    const project = activeProject();
    const current = activeWorkspace();
    if (!project || !current) return;
    const groupId = current.workspace.focusedGroupId;
    const statuses = await queryClient.ensureQueryData({
      queryKey: queryKeys.cliStatus,
      queryFn: () => window.runova.cli.detectAll(),
    });
    const { installed } = sortAgentChoices(
      statuses,
      useCliStore.getState().cliOrder,
      projectCliId(project),
    );
    const choice = installed[position - 1];
    if (!choice) return;
    useLauncherStore.getState().setOpenFor(null);
    launchAgentTab(project, choice.cli.id, groupId);
  },

  /** Opens Build Prompt for the project on screen, so "Open in agent" lands in the focused pane. */
  buildPrompt(): void {
    const current = activeWorkspace();
    if (!current) return;
    useLauncherStore.getState().setOpenFor(null);
    usePromptDialogStore.getState().open(current.projectId, current.workspace.focusedGroupId);
  },

  newBrowser(): void {
    const current = activeWorkspace();
    if (!current) return;
    useWorkspaceStore
      .getState()
      .openBrowser(current.projectId, { groupId: current.workspace.focusedGroupId });
  },

  /** Starts commenting on a page element, when the focused pane shows a browser tab. */
  pickElement(): void {
    const current = activeWorkspace();
    if (!current) return;
    const group = findGroup(current.workspace.root, current.workspace.focusedGroupId);
    const tab = group?.activeTabId ? current.workspace.tabs[group.activeTabId] : undefined;
    if (tab?.kind === 'browser' && tab.url) emitBrowserShortcut(tab.id, 'pick');
  },

  closeActiveTab(): void {
    const current = activeWorkspace();
    if (!current) return;
    const group = findGroup(current.workspace.root, current.workspace.focusedGroupId);
    if (group?.activeTabId) {
      useWorkspaceStore.getState().closeTab(current.projectId, group.activeTabId);
    }
  },

  split(direction: SplitDirection): void {
    const current = activeWorkspace();
    if (!current) return;
    const groupId = useWorkspaceStore
      .getState()
      .splitGroup(current.projectId, current.workspace.focusedGroupId, direction);
    useLauncherStore.getState().setOpenFor(groupId);
  },

  focusPane(direction: PaneDirection): void {
    const current = activeWorkspace();
    if (!current) return;
    const next = findNeighborGroup(groupRects(), current.workspace.focusedGroupId, direction);
    if (next) useWorkspaceStore.getState().focusGroup(current.projectId, next);
  },

  cycleTab(step: 1 | -1): void {
    const current = activeWorkspace();
    if (!current) return;
    const group = findGroup(current.workspace.root, current.workspace.focusedGroupId);
    if (!group || group.tabIds.length < 2) return;
    const index = group.activeTabId ? group.tabIds.indexOf(group.activeTabId) : 0;
    const next = group.tabIds[(index + step + group.tabIds.length) % group.tabIds.length];
    if (next) useWorkspaceStore.getState().activateTab(current.projectId, next);
  },

  goToTab(position: number): void {
    const current = activeWorkspace();
    if (!current) return;
    const group = findGroup(current.workspace.root, current.workspace.focusedGroupId);
    const tabId = group?.tabIds[position - 1];
    if (tabId) useWorkspaceStore.getState().activateTab(current.projectId, tabId);
  },

  toggleZoom(): void {
    const current = activeWorkspace();
    if (current) {
      useWorkspaceStore.getState().toggleZoom(current.projectId, current.workspace.focusedGroupId);
    }
  },

  focusedTabIsDiff(): boolean {
    const current = activeWorkspace();
    if (!current) return false;
    const group = findGroup(current.workspace.root, current.workspace.focusedGroupId);
    const tab = group?.activeTabId ? current.workspace.tabs[group.activeTabId] : undefined;
    return tab?.kind === 'diff';
  },

  /** Moves the diff in the focused pane to its next or previous change. */
  diffChange(direction: 'next' | 'previous'): void {
    window.dispatchEvent(new CustomEvent(DIFF_CHANGE_EVENT, { detail: direction }));
  },

  toggleGitPanel(): void {
    const { gitPanel, setGitPanel } = useWorkspaceStore.getState();
    setGitPanel({ collapsed: !gitPanel.collapsed });
  },

  /** Presses the header's Run button for the project on screen. */
  runProject(): void {
    window.dispatchEvent(new CustomEvent(RUN_PROJECT_EVENT));
  },

  /** Opens the search dialog on the project on screen, or closes it when it is already up. */
  openSearch(): void {
    const scopeId = useWorkspaceStore.getState().activeProjectId;
    if (scopeId) useWorkspaceSearchStore.getState().toggle(scopeId);
  },

  /** New worktree of the project on screen, whether its checkout or one of its worktrees is up. */
  newWorktree(): void {
    const scopeId = useWorkspaceStore.getState().activeProjectId;
    if (!scopeId) return;
    useWorktreeDialogStore.getState().openCreate({ projectId: parseScopeId(scopeId).projectId });
  },
};
